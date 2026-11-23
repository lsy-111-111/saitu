#!/usr/bin/env node
import { isDirectExecution } from '../lib/direct-execution.mjs';
import pg from 'pg';

const LOCK_ID = '724310896145229';
const BATCH_SIZE = 100;
const MAX_BATCHES = 20;
const AUDIT_BATCH_SIZE = 1_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SOCKET_PATHS = new Set(['/run/postgresql', '/var/run/postgresql']);

/** This administrator-only CLI never loads application secrets or refreshes grants.
 * Recommended service identity: postgres, using its local peer-authenticated socket. */
export function retentionDatabaseUrl(environment = process.env) {
  const value = environment.SAITU_MAINTENANCE_DATABASE_URL?.trim() || environment.DATABASE_URL?.trim();
  if (!value) throw new Error('RETENTION_DATABASE_URL_REQUIRED');
  let url;
  try { url = new URL(value); } catch { throw new Error('RETENTION_DATABASE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash
    || !/^\/[^/]+$/.test(url.pathname)) throw new Error('RETENTION_DATABASE_URL_INVALID');
  const socket = url.searchParams.get('host');
  if (socket) {
    if (url.hostname || url.port || url.searchParams.size !== 1 || !SOCKET_PATHS.has(socket))
      throw new Error('RETENTION_LOCAL_DATABASE_REQUIRED');
  } else if (!LOCAL_HOSTS.has(url.hostname) || url.search
    || url.port && !['5432', '5433'].includes(url.port)) throw new Error('RETENTION_LOCAL_DATABASE_REQUIRED');
  return value;
}

async function transaction(client, work) {
  await client.query('begin');
  try { const result = await work(); await client.query('commit'); return result; }
  catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
}

async function redactDiscoverySessions(client) {
  return transaction(client, async () => {
    const { rows } = await client.query(`select session_id from public.competition_discovery_sessions
      where status='active' and expires_at<=now() order by expires_at for update skip locked limit $1`, [BATCH_SIZE]);
    if (!rows.length) return 0;
    const ids = rows.map(row => row.session_id);
    await client.query(`update public.competition_discovery_events set ciphertext=null,iv=null,tag=null,redacted=true
      where run_id in (select run_id from public.competition_discovery_runs where session_id=any($1::uuid[]))`, [ids]);
    await client.query(`update public.competition_discovery_runs set status='expired',ciphertext=null,iv=null,tag=null,
      lease_owner=null,lease_expires_at=null,lease_fence=lease_fence+1,updated_at=now() where session_id=any($1::uuid[])`, [ids]);
    await client.query(`update public.competition_discovery_sessions set status='expired',ciphertext=null,iv=null,tag=null,
      clarification_owner=null,clarification_lease_expires_at=null,clarification_fence=clarification_fence+1,updated_at=now()
      where session_id=any($1::uuid[])`, [ids]);
    return rows.length;
  });
}

/** A retry may extend the parent session; an older run still keeps its own expiry. */
async function redactDiscoveryRuns(client) {
  return transaction(client, async () => {
    const { rows } = await client.query(`select r.run_id from public.competition_discovery_runs r
      where r.status not in ('expired','deleted') and (r.expires_at<=now() or exists (
        select 1 from public.competition_discovery_sessions s where s.session_id=r.session_id
          and (s.expires_at<=now() or s.status<>'active')))
      order by r.expires_at for update of r skip locked limit $1`, [BATCH_SIZE]);
    if (!rows.length) return 0;
    const ids = rows.map(row => row.run_id);
    await client.query(`update public.competition_discovery_events set ciphertext=null,iv=null,tag=null,redacted=true
      where run_id=any($1::uuid[])`, [ids]);
    await client.query(`update public.competition_discovery_runs set status='expired',ciphertext=null,iv=null,tag=null,
      lease_owner=null,lease_expires_at=null,lease_fence=lease_fence+1,updated_at=now() where run_id=any($1::uuid[])`, [ids]);
    return rows.length;
  });
}

async function redactLegacyRuns(client) {
  return transaction(client, async () => {
    const { rows } = await client.query(`select r.run_id from public.competition_decision_runs r
      where r.content_redacted_at is null and (r.expires_at<=now() or exists (
        select 1 from public.competition_decision_states s where s.state_key=r.state_key and s.expires_at<=now()))
      order by r.expires_at for update of r skip locked limit $1`, [BATCH_SIZE]);
    if (!rows.length) return 0;
    const ids = rows.map(row => row.run_id);
    // Keep every call identifier, dispatch timestamp, reservation and cost record.
    await client.query(`update public.competition_decision_calls set ciphertext=null,iv=null,tag=null,content_redacted_at=now()
      where run_id=any($1::uuid[]) and content_redacted_at is null`, [ids]);
    await client.query(`update public.competition_decision_chat_requests set ciphertext=null,iv=null,tag=null,
      content_redacted_at=now() where run_id=any($1::uuid[]) and content_redacted_at is null`, [ids]);
    await client.query(`update public.competition_decision_runs set status='expired',ciphertext=null,iv=null,tag=null,
      content_redacted_at=now(),lease_owner=null,lease_expires_at=null,lease_fence=lease_fence+1,updated_at=now()
      where run_id=any($1::uuid[])`, [ids]);
    return rows.length;
  });
}

async function redactLegacyStates(client) {
  return transaction(client, async () => {
    const result = await client.query(`with expired as (
      select state_key from public.competition_decision_states where expires_at<=now() and content_redacted_at is null
      order by expires_at for update skip locked limit $1
    ) update public.competition_decision_states s set ciphertext=null,iv=null,tag=null,content_redacted_at=now(),updated_at=now()
      from expired e where s.state_key=e.state_key`, [BATCH_SIZE]);
    return result.rowCount;
  });
}

async function pruneConsentAudit(client) {
  const day = (await client.query(`select to_char(now() at time zone 'Asia/Shanghai','YYYY-MM-DD') as day`)).rows[0].day;
  const previous = (await client.query(`select 1 from public.saitu_retention_maintenance
    where task='ai_consents' and completed_day>=$1::date`, [day])).rowCount;
  if (previous) return { deleted: 0, completed: true };
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const result = await client.query(`with expired as (
      select id from public.ai_consents where created_at<now()-interval '180 days'
      order by created_at for update skip locked limit $1
    ) delete from public.ai_consents c using expired e where c.id=e.id`, [AUDIT_BATCH_SIZE]);
    deleted += result.rowCount;
    if (result.rowCount < AUDIT_BATCH_SIZE) break;
  }
  const pending = (await client.query(`select exists(select 1 from public.ai_consents
    where created_at<now()-interval '180 days') as pending`)).rows[0].pending;
  if (!pending) await client.query(`insert into public.saitu_retention_maintenance(task,completed_day)
    values('ai_consents',$1::date) on conflict(task) do update
      set completed_day=excluded.completed_day,updated_at=now()`, [day]);
  return { deleted, completed: !pending };
}

export async function runRetention(client) {
  const locked = (await client.query('select pg_try_advisory_lock($1::bigint) as locked', [LOCK_ID])).rows[0].locked;
  if (!locked) return { skipped: true };
  const counts = { discoverySessions: 0, discoveryRuns: 0, legacyRuns: 0, legacyStates: 0, securityState: 0, consentAudit: 0 };
  try {
    await client.query("set statement_timeout='10000ms'");
    await client.query("set lock_timeout='2000ms'");
    for (const [key, work] of [
      ['discoverySessions', redactDiscoverySessions], ['discoveryRuns', redactDiscoveryRuns],
      ['legacyRuns', redactLegacyRuns], ['legacyStates', redactLegacyStates],
    ]) {
      for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
        const count = await work(client); counts[key] += count;
        if (count < BATCH_SIZE) break;
      }
    }
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const { rows } = await client.query(`select public.resume_ai_runtime_prune_competition_state()
        + public.resume_ai_runtime_prune_model_gate() as pruned`);
      counts.securityState += rows[0].pruned;
      if (!rows[0].pruned) break;
    }
    const audit = await pruneConsentAudit(client); counts.consentAudit = audit.deleted;
    return { skipped: false, ...counts, consentAuditCompletedToday: audit.completed };
  } finally { await client.query('select pg_advisory_unlock($1::bigint)', [LOCK_ID]); }
}

async function main() {
  const startedAt = Date.now();
  const client = new pg.Client({ connectionString: retentionDatabaseUrl(), application_name: 'saitu-retention', connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    console.info(JSON.stringify({ event: 'saitu_retention_completed', ...await runRetention(client), elapsedMs: Date.now()-startedAt }));
  } finally { await client.end().catch(() => undefined); }
}

if (isDirectExecution(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'saitu_retention_failed', code: /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'RETENTION_FAILED' }));
    process.exitCode = 1;
  });
}
