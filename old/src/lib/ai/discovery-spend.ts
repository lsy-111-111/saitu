import "server-only";
import { getPool } from "@/lib/db/pool";
import { acquireModelCallPermit } from "./model-call-governor";
import { estimateSpendMicros, FLASH_PRICE_SNAPSHOT, type SpendUsage } from "./spend-ledger";
import { configuredDiscoveryAuthority, verifyDiscoveryAuthority } from "./discovery-authority";
import { setTimeout as delay } from "node:timers/promises";

export type { SpendUsage } from "./spend-ledger";

export type DiscoveryOperation = "competition_discovery_clarify" | "competition_discovery_report";
export type DiscoveryModelCallTiming = {
  stage: "gate_wait_started" | "gate_acquired" | "dispatched";
  atEpochMs: number;
  waitMs?: number;
};
export type DiscoveryModelCallOptions = {
  operation: DiscoveryOperation;
  callId: string;
  signal: AbortSignal;
  deadlineEpochMs: number;
  inputTokensEstimate: number;
  maxOutputTokens?: number;
  reasoningEffort: "max" | "high";
  onTiming?: (timing: DiscoveryModelCallTiming) => void;
};
export type DiscoveryModelCallContext = {
  signal: AbortSignal;
  markDispatched(): Promise<void>;
  recordUsage(usage: SpendUsage): void;
};

function settlementQuery(text: string, values: unknown[]) {
  // pg accepts a per-query read timeout even though @types/pg omits it from
  // QueryConfig. Keep the concrete config so short retries stay bounded.
  const query = { text, values, query_timeout: 350 };
  return getPool().query(query);
}

/** Settlement is independent from model execution: database retries must never
 * repeat a successful or uncertain provider request. A durable receipt lets a
 * later worker retain known usage, or conservatively settle an interrupted call. */
async function settleDiscoveryCall(input: {
  authority: ReturnType<typeof configuredDiscoveryAuthority>; callId: string; reservedMicros: number;
  dispatchRequested: boolean; usage?: SpendUsage;
}) {
  const { authority, callId, reservedMicros, dispatchRequested, usage } = input;
  const charged = usage ? estimateSpendMicros(usage) : dispatchRequested ? reservedMicros : 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Revocation prevents new dispatches, but cannot erase the cost of an
      // already authorized request. The complete grant binding is still checked.
      await verifyDiscoveryAuthority(getPool(), authority, true, 350);
      await settlementQuery(`update saitu_discovery_call_receipts set completed_at=coalesce(completed_at,now()),
        input_tokens=$3,output_tokens=$4,cached_input_tokens=$5,usage_cost_micros=$6 where call_id=$1 and run_id=$2`,
      [callId, authority.runId, usage?.inputTokens ?? null, usage?.outputTokens ?? null,
        usage?.cachedInputTokens ?? null, usage ? estimateSpendMicros(usage) : null]);
      await settlementQuery(`update ai_spend_ledger set charged_micros=$2,state=$3,input_tokens=$4,
        output_tokens=$5,cached_input_tokens=$6,settled_at=now() where id=$1 and run_id=$7 and state='reserved'`,
      [callId, charged, usage ? "usage_estimated" : dispatchRequested ? "conservative" : "cancelled",
        usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.cachedInputTokens ?? null, authority.runId]);
      return;
    } catch {
      if (attempt < 2) await delay(attempt === 0 ? 50 : 150);
    }
  }
  // Content-free evidence only. A successful answer stays successful; the
  // reserved amount remains visible until the periodic reconciler settles it.
  console.warn(JSON.stringify({ event: "discovery_spend_settlement_pending", callId, runId: authority.runId, attempts: 3 }));
}

/** Reconcile only this explicitly authorized run after every possible HTTP
 * response has passed its absolute deadline plus a cleanup grace period. */
export async function reconcileDiscoverySpend(): Promise<number> {
  const authority = configuredDiscoveryAuthority();
  await verifyDiscoveryAuthority(getPool(), authority, true);
  const result = await getPool().query(`update ai_spend_ledger l set
    charged_micros=case when r.usage_cost_micros is not null then r.usage_cost_micros when r.dispatched_at is null then 0 else l.reserved_micros end,
    state=case when r.usage_cost_micros is not null then 'usage_estimated' when r.dispatched_at is null then 'cancelled' else 'conservative' end,
    input_tokens=r.input_tokens,output_tokens=r.output_tokens,cached_input_tokens=r.cached_input_tokens,
    settled_at=now() from saitu_discovery_call_receipts r
    where l.id=r.call_id and l.run_id=$1 and r.run_id=$1 and l.state='reserved'
      and l.operation in ('competition_discovery_clarify','competition_discovery_report')
      and r.hard_deadline_at + interval '30 seconds' <= now()`, [authority.runId]);
  // Calls created before durable dispatch receipts were installed have unknown
  // outcomes. Never infer that they were free merely because no receipt exists.
  const legacy = await getPool().query(`update ai_spend_ledger l set charged_micros=l.reserved_micros,state='conservative',
    input_tokens=null,output_tokens=null,cached_input_tokens=null,settled_at=now()
    where l.run_id=$1 and l.state='reserved' and l.operation in ('competition_discovery_clarify','competition_discovery_report')
      and l.created_at + interval '210 seconds' <= now()
      and not exists(select 1 from saitu_discovery_call_receipts r where r.call_id=l.id)`, [authority.runId]);
  return (result.rowCount ?? 0) + (legacy.rowCount ?? 0);
}

/** Uses the same global transport gate while keeping this authorization separate
 * from the old finite calibration budget. No caller can mint or expand a grant. */
export async function withDiscoveryModelCall<T>(options: DiscoveryModelCallOptions,
  execute: (context: DiscoveryModelCallContext) => Promise<T>): Promise<T> {
  const authority = configuredDiscoveryAuthority();
  if (!authority.policy.operations.includes(options.operation)
    || !["max", "high"].includes(options.reasoningEffort)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options.callId)
    || !Number.isSafeInteger(options.inputTokensEstimate) || options.inputTokensEstimate < 0
    || !Number.isFinite(options.deadlineEpochMs)) throw new Error("DISCOVERY_CALL_CONFIGURATION_INVALID");
  options.signal.throwIfAborted();
  const remainingMs = options.deadlineEpochMs - Date.now();
  if (remainingMs <= 0) throw new Error("DISCOVERY_CALL_DEADLINE");
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.ceil(remainingMs))]);
  const observe = (timing: DiscoveryModelCallTiming) => {
    // Observability must never alter dispatch, retries or accounting outcomes.
    try { options.onTiming?.(timing); } catch { /* Content-free diagnostic only. */ }
  };
  const gateStartedAt = Date.now();
  observe({ stage: "gate_wait_started", atEpochMs: gateStartedAt });
  const gate = await acquireModelCallPermit({ signal, deadlineEpochMs: options.deadlineEpochMs,
    maxWaitMs: Math.max(0, options.deadlineEpochMs - Date.now()),
    ...(authority.mode === "server" ? { profile: "server-discovery" as const } : {}) });
  if (!gate.ok) throw new Error(`DISCOVERY_MODEL_GATE_${gate.reason}`);
  observe({ stage: "gate_acquired", atEpochMs: Date.now(), waitMs: Date.now() - gateStartedAt });
  let reserved = false, dispatchRequested = false, dispatchPromise: Promise<void> | undefined, usage: SpendUsage | undefined;
  // This is a content-free estimate for an unknown response, never a fee cap.
  const reservedMicros = Math.max(1, estimateSpendMicros({ inputTokens: options.inputTokensEstimate,
    outputTokens: options.maxOutputTokens ?? 16384, cachedInputTokens: 0 }));
  try {
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await verifyDiscoveryAuthority(client, authority);
      if (Date.now() >= options.deadlineEpochMs) throw new Error("DISCOVERY_CALL_DEADLINE");
      signal.throwIfAborted();
      await client.query(`insert into ai_spend_ledger
        (id,run_id,model,effort,operation,price_version,reserved_micros,state,phase,effort_policy_sha256)
        values($1,$2,'deepseek-flash',$7,$3,$4,$5,'reserved','formal',$6)`,
      [options.callId, authority.runId, options.operation, FLASH_PRICE_SNAPSHOT.id, reservedMicros, authority.policySha256,
        options.reasoningEffort]);
      await client.query(`insert into saitu_discovery_call_receipts(call_id,run_id,hard_deadline_at) values($1,$2,$3)`,
        [options.callId, authority.runId, new Date(options.deadlineEpochMs)]);
      await client.query("commit"); reserved = true;
    } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
    finally { client.release(); }
    return await execute({ signal,
      markDispatched() {
        if (!dispatchPromise) {
          signal.throwIfAborted(); dispatchRequested = true;
          dispatchPromise = (async () => {
            await verifyDiscoveryAuthority(getPool(), authority);
            signal.throwIfAborted();
            const result = await getPool().query(`update saitu_discovery_call_receipts set dispatched_at=coalesce(dispatched_at,now())
              where call_id=$1 and run_id=$2 returning call_id`, [options.callId, authority.runId]);
            if (result.rowCount !== 1) throw new Error("DISCOVERY_DISPATCH_RECEIPT_REQUIRED");
            observe({ stage: "dispatched", atEpochMs: Date.now() });
          })();
        }
        return dispatchPromise;
      },
      recordUsage(value) { estimateSpendMicros(value); usage = { ...value }; }
    });
  } finally {
    try {
      if (reserved) {
        await dispatchPromise?.catch(() => undefined);
        await settleDiscoveryCall({ authority, callId: options.callId, reservedMicros, dispatchRequested, usage });
      }
    } finally { gate.permit.release(); }
  }
}
