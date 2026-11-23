// Isolated-PG integration participant. No provider requests or credentials leave
// the child; IPC contains only admission outcomes.
import { installSourceLoader } from '../../scripts/lib/load-typescript-source.mjs';
import { setTimeout as delay } from 'node:timers/promises';
installSourceLoader();
const { acquireModelCallPermit } = await import('../../src/lib/ai/model-call-governor.ts');
const { getPool } = await import('../../src/lib/db/pool.ts');
const controller = new AbortController(), permits = [];
process.on('message', message => {
  if (message !== 'stop') return;
  controller.abort();
  for (const permit of permits) permit.release();
});
await Promise.all(Array.from({ length: 3 }, async () => {
  const result = await acquireModelCallPermit({ profile: 'server-discovery', signal: controller.signal,
    deadlineEpochMs: Date.now() + 10000, maxWaitMs: 8000 });
  if (result.ok) {
    permits.push(result.permit);
    if (controller.signal.aborted) result.permit.release();
    process.send?.({ outcome: 'acquired' });
  } else process.send?.({ outcome: result.reason });
}));
// All three may acquire if peers exit early; still retain their leases until
// the parent has inspected the shared ceiling.
if (!controller.signal.aborted) await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
for (const permit of permits) permit.release();
// Permit release and cancelled-waiter removal are asynchronous. Keep the pool
// open until both participants' submitted cleanup queries have settled.
const cleanupDeadline = Date.now() + 5000;
while (Date.now() < cleanupDeadline) {
  const state = (await getPool().query('select (select count(*) from ai_model_call_leases)+(select count(*) from ai_model_call_waiters) as remaining')).rows[0];
  if (Number(state.remaining) === 0) break;
  await delay(25);
}
await getPool().end();
process.disconnect?.();
