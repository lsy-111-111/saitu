import pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, chown } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { atomicWrite, serializeEnvironment, requireRoot, ENV_FILE, NODE, captured, execute } from './common.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const database = 'saitu_production', role = 'saitu_runtime';
const configFile = '/etc/saitu/credentials.json';
const input = async () => { let text = ''; for await (const part of process.stdin) text += part; return text; };

async function databaseSetup(config) {
  if (process.getuid?.() === 0) throw new Error('DATABASE_SETUP_REQUIRES_POSTGRES_PEER_USER');
  const admin = new pg.Client({ user: 'postgres', host: '/var/run/postgresql', database: 'postgres' });
  await admin.connect();
  try {
    const existingRole = (await admin.query('select rolname from pg_roles where rolname=$1', [role])).rows[0];
    if (!existingRole) await admin.query(`create role ${pg.escapeIdentifier(role)} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${pg.escapeLiteral(config.runtimePassword)}`);
    const existingDatabase = (await admin.query('select datname from pg_database where datname=$1', [database])).rows[0];
    if (!existingDatabase) await admin.query(`create database ${pg.escapeIdentifier(database)} encoding 'UTF8'`);
  } finally { await admin.end(); }
  const client = new pg.Client({ user: 'postgres', host: '/var/run/postgresql', database });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select pg_advisory_xact_lock(hashtextextended('saitu.production.migrations.v1',0))");
    await client.query('create table if not exists saitu_local_migrations(name text primary key,sha256 text not null,installed_at timestamptz not null default now())');
    const manifest = await readFile(path.join(root, 'ops/config/migrations.manifest'), 'utf8');
    const listed = manifest.split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => line.trim().split(/\s+/));
    const names = ['db/schema.sql', ...listed.map(([, filename]) => `db/migrations/${filename}`),
      'db/migrations/20261119_local_standalone.sql', 'db/migrations/20261119_discovery_runtime_grant.sql',
      'db/migrations/20261119_competition_discovery.sql', 'db/migrations/20261119_discovery_call_receipts.sql',
      'db/migrations/20261120_server_discovery_runtime_grant.sql', 'db/migrations/20261120_server_retention.sql'];
    for (const name of names) {
      const sql = await readFile(path.join(root, name), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const pinned = listed.find(([, filename]) => name === `db/migrations/${filename}`)?.[0];
      if (pinned && pinned !== sha) throw new Error(`MIGRATION_MANIFEST_MISMATCH:${name}`);
      const installed = (await client.query('select sha256 from saitu_local_migrations where name=$1', [name])).rows[0];
      if (installed) { if (installed.sha256 !== sha) throw new Error(`APPLIED_MIGRATION_CHANGED:${name}`); continue; }
      await client.query(sql);
      await client.query('insert into saitu_local_migrations(name,sha256) values($1,$2)', [name, sha]);
    }
    await client.query('revoke create on schema public from public');
    await client.query(`revoke create,temporary on database ${pg.escapeIdentifier(database)} from public`);
    await client.query(`grant connect on database ${pg.escapeIdentifier(database)} to ${pg.escapeIdentifier(role)}`);
    await client.query(`grant usage on schema public to ${pg.escapeIdentifier(role)}`);
    for (const filename of ['runtime-table-privileges.conf', 'discovery-runtime-table-privileges.conf']) {
      for (const line of (await readFile(path.join(root, 'ops/postgresql', filename), 'utf8')).split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const matched = /^([a-z_]+)=((?:SELECT|INSERT|UPDATE)(?:,(?:SELECT|INSERT|UPDATE))*)$/.exec(line);
        if (!matched) throw new Error('INVALID_RUNTIME_PRIVILEGES');
        await client.query(`grant ${matched[2]} on ${pg.escapeIdentifier(matched[1])} to ${pg.escapeIdentifier(role)}`);
      }
    }
    for (const line of (await readFile(path.join(root, 'ops/postgresql/runtime-function-privileges.conf'), 'utf8')).split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const matched = /^([a-z_]+)=([a-z,]*)$/.exec(line);
      if (!matched) throw new Error('INVALID_RUNTIME_FUNCTION');
      await client.query(`grant execute on function public.${pg.escapeIdentifier(matched[1])}(${matched[2]}) to ${pg.escapeIdentifier(role)}`);
    }
    // The primary budget is a compatibility authority. Only the
    // separately authorized discovery profile can dispatch production calls.
    await client.query('insert into ai_spend_budgets(run_id,hard_limit_micros) values($1,1) on conflict do nothing', [config.runId]);
    await client.query('insert into ai_spend_authority(singleton,run_id) values(true,$1) on conflict do nothing', [config.runId]);
    if ((await client.query('select run_id from ai_spend_authority where singleton=true')).rows[0]?.run_id !== config.runId) throw new Error('PRODUCTION_AUTHORITY_CHANGED');
    const { initializeServerDiscoveryRuntimeGrant } = await import('../../src/lib/ai/discovery-grant-setup.mjs');
    await initializeServerDiscoveryRuntimeGrant(client, config.runId);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { await client.end(); }
  console.log('Production database migrations and authorization are ready.');
}

if (process.argv[2] === '--database') {
  process.env.SAITU_RUNTIME_MODE = 'server';
  await databaseSetup(JSON.parse(await input()));
} else {
  requireRoot();
  if (process.argv[2] === 'set-api-key') {
    const key = (await input()).trim();
    if (!key || /[\r\n\0]/.test(key)) throw new Error('INVALID_API_KEY');
    const { parseEnv } = await import('node:util');
    const env = parseEnv(await readFile(ENV_FILE, 'utf8'));
    await atomicWrite(ENV_FILE, serializeEnvironment({ ...env, AI_API_KEY: key }), 0o640);
    await chown(ENV_FILE, 0, Number(await captured('id', ['-g', 'saitu'])));
    console.log('Production API key configured; value was not displayed.');
  } else {
    let config;
    try { config = JSON.parse(await readFile(configFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      config = { version: 1, runtimePassword: randomBytes(32).toString('hex'), runId: `saitu-server-${randomBytes(16).toString('hex')}`,
        consentSalt: randomBytes(32).toString('hex'), signingSecret: randomBytes(32).toString('hex'), logSecret: randomBytes(32).toString('hex') };
      await atomicWrite(configFile, JSON.stringify(config) + '\n');
    }
    const runtimeUrl = new URL(`postgresql://${role}@127.0.0.1:5432/${database}`); runtimeUrl.password = config.runtimePassword;
    let previous = {};
    try { const { parseEnv } = await import('node:util'); previous = parseEnv(await readFile(ENV_FILE, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const env = { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_SITE_URL: 'https://gzhanchuang.com',
      NEXT_PUBLIC_ICP_LABEL: '粤ICP备2026158125号-1', FEATURE_AI: '1', FEATURE_COMPETITION_RECOMMENDER: '1',
      SAITU_RUNTIME_MODE: 'server', SAITU_AI_EXECUTION_MODE: 'finite', SAITU_V7_WORKER_CONCURRENCY: '4',
      SAITU_DECISION_STRATEGY: 'rules', SAITU_V7_DETAIL_LAYOUT: 'single', AI_PROVIDER: 'deepseek',
      AI_API_URL: 'https://api.deepseek.com/chat/completions', AI_MODELS_URL: 'https://api.deepseek.com/models',
      AI_API_KEY: previous.AI_API_KEY || '', AI_MODEL: 'deepseek-flash', AI_COMPETITION_NORMALIZE_MODEL: 'deepseek-flash',
      AI_COMPETITION_CLARIFY_MODEL: 'deepseek-flash', AI_COMPETITION_RECOMMEND_MODEL: 'deepseek-flash',
      AI_REASONING_EFFORT: 'high', AI_TEST_MODE: '0', ALLOW_AI_MOCK: '0',
      DATABASE_URL: runtimeUrl.href, AI_SPEND_RUN_ID: config.runId, SAITU_DISCOVERY_SPEND_RUN_ID: config.runId.replace('saitu-server-', 'saitu-discovery-server-'),
      AI_SPEND_PHASE: 'formal', AI_CONSENT_SALT: config.consentSalt, AI_CONVERSATION_SIGNING_SECRET: config.signingSecret, LOG_HASH_SECRET: config.logSecret };
    await execute('sudo', ['-u', 'postgres', '--', NODE, fileURLToPath(import.meta.url), '--database'], {
      stdio: ['pipe', 'inherit', 'inherit'], input: JSON.stringify(config), env: { ...process.env, SAITU_RUNTIME_MODE: 'server' }
    });
    await atomicWrite(ENV_FILE, serializeEnvironment(env), 0o640);
    await chown(ENV_FILE, 0, Number(await captured('id', ['-g', 'saitu'])));
    console.log('Production environment is ready. Secrets and spending history were preserved.');
  }
}
