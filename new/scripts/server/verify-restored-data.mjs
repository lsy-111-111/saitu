#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDirectExecution } from '../lib/direct-execution.mjs';
import pg from 'pg';
import { installSourceLoader } from '../lib/load-typescript-source.mjs';
import { retentionDatabaseUrl, runRetention } from './retention.mjs';

const RESTORE_DATABASE = /^saitu_restore_[a-z0-9_]{1,80}$/;

async function readSecret() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input, 'utf8') > 8_192) throw new Error('RESTORE_SECRET_INPUT_INVALID');
  }
  let value;
  try { value = JSON.parse(input); } catch { throw new Error('RESTORE_SECRET_INPUT_INVALID'); }
  if (!value || Object.keys(value).join(',') !== 'signingSecret' || typeof value.signingSecret !== 'string'
    || value.signingSecret.length < 32 || value.signingSecret.length > 4_096) throw new Error('RESTORE_SECRET_INPUT_INVALID');
  return value.signingSecret;
}

/** Synthetic records only. Never select or decrypt an existing user's body. */
async function main() {
  const connectionString = retentionDatabaseUrl();
  const requestedName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  if (!RESTORE_DATABASE.test(requestedName)) throw new Error('RESTORE_ISOLATED_DATABASE_REQUIRED');
  const signingSecret = await readSecret();
  const client = new pg.Client({ connectionString, application_name: 'saitu-restore-verification', connectionTimeoutMillis: 5_000 });
  const synthetic = [];
  try {
    await client.connect();
    const identity = (await client.query('select current_database() as database')).rows[0];
    if (identity.database !== requestedName || !RESTORE_DATABASE.test(identity.database)) throw new Error('RESTORE_DATABASE_IDENTITY_MISMATCH');
    process.env.AI_CONVERSATION_SIGNING_SECRET = signingSecret;
    installSourceLoader();
    const { sealV7, unsealV7 } = await import('../../src/lib/competitions/v7/crypto.ts');
    const payload = { schemaVersion: 'saitu.restore-probe.v1', synthetic: true, marker: randomBytes(16).toString('hex') };
    for (const expired of [true, false]) {
      const sessionId = randomUUID(), runId = randomUUID();
      const binding = createHash('sha256').update(sessionId).digest('hex');
      const session = sealV7(`discovery-session:${sessionId}`, payload);
      const run = sealV7(`discovery-run:${runId}`, payload);
      await client.query(`insert into public.competition_discovery_sessions
        (session_id,creation_key,input_sha256,ciphertext,iv,tag,expires_at)
        values($1,$2,$2,$3,$4,$5,now()+$6::interval)`,
      [sessionId, binding, session.ciphertext, session.iv, session.tag, expired ? '-1 hour' : '24 hours']);
      synthetic.push({ sessionId, runId, expired });
      await client.query(`insert into public.competition_discovery_runs
        (run_id,session_id,submission_key,input_sha256,status,ciphertext,iv,tag,submitted_at,deadline_at,expires_at)
        values($1,$2,$3,$3,'complete',$4,$5,$6,now()-interval '3 hours',now()-interval '2 hours',now()+$7::interval)`,
      [runId, sessionId, binding, run.ciphertext, run.iv, run.tag, expired ? '-1 hour' : '24 hours']);
      const event = sealV7(`discovery-event:${runId}:1`, payload);
      await client.query(`insert into public.competition_discovery_events(run_id,seq,ciphertext,iv,tag)
        values($1,1,$2,$3,$4)`, [runId, event.ciphertext, event.iv, event.tag]);
    }
    // A restored cursor or backlog must never stop removal of expired content.
    let cleanup;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      cleanup = await runRetention(client);
      if (cleanup.skipped) throw new Error('RESTORE_RETENTION_BUSY');
      const pending = (await client.query(`select count(*)::int as pending from public.competition_discovery_sessions
        where session_id=any($1::uuid[]) and status='active' and expires_at<=now()`,
      [synthetic.map(record => record.sessionId)])).rows[0].pending;
      if (!pending) break;
      if (attempt === 9) throw new Error('RESTORE_RETENTION_BACKLOG');
    }
    for (const record of synthetic) {
      const session = (await client.query(`select status,ciphertext,iv,tag,expires_at from public.competition_discovery_sessions where session_id=$1`, [record.sessionId])).rows[0];
      const run = (await client.query(`select status,ciphertext,iv,tag from public.competition_discovery_runs where run_id=$1`, [record.runId])).rows[0];
      const event = (await client.query(`select redacted,ciphertext,iv,tag from public.competition_discovery_events where run_id=$1 and seq=1`, [record.runId])).rows[0];
      if (record.expired) {
        assert.equal(session.status, 'expired'); assert.equal(run.status, 'expired'); assert.equal(event.redacted, true);
        for (const row of [session, run, event]) for (const field of ['ciphertext', 'iv', 'tag']) assert.equal(row[field], null);
        assert(session.expires_at.getTime() < Date.now());
      } else {
        assert.equal(session.status, 'active'); assert.equal(run.status, 'complete'); assert.equal(event.redacted, false);
        assert.deepEqual(unsealV7(`discovery-session:${record.sessionId}`, session), payload);
        assert.deepEqual(unsealV7(`discovery-run:${record.runId}`, run), payload);
        assert.deepEqual(unsealV7(`discovery-event:${record.runId}:1`, event), payload);
        assert(session.expires_at.getTime() > Date.now());
      }
    }
    console.info(JSON.stringify({ event: 'saitu_restored_data_verified', syntheticOnly: true,
      decryptedActiveRecords: 3, expiredBodiesCleared: 3, expiryExtended: false, maintenanceCompleted: !cleanup.skipped }));
  } finally {
    delete process.env.AI_CONVERSATION_SIGNING_SECRET;
    // No genuine restored row is selected here; only our new UUIDs are removed.
    if (synthetic.length) {
      const runIds = synthetic.map(record => record.runId), sessionIds = synthetic.map(record => record.sessionId);
      await client.query('delete from public.competition_discovery_events where run_id=any($1::uuid[])', [runIds]).catch(() => undefined);
      await client.query('delete from public.competition_discovery_runs where run_id=any($1::uuid[])', [runIds]).catch(() => undefined);
      await client.query('delete from public.competition_discovery_sessions where session_id=any($1::uuid[])', [sessionIds]).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch(() => {
    console.error(JSON.stringify({ event: 'saitu_restored_data_verification_failed' }));
    process.exitCode = 1;
  });
}
