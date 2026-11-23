import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import net from 'node:net';
import pg from 'pg';
import { ROOT, LOCAL, PG, DATA, CONFIG, exec, exists, json, save, settings, updateSettings } from './shared.mjs';
import { createHash } from 'node:crypto';
import { DEFAULT_EFFORT_POLICY, effortPolicySha256 } from '../../src/lib/ai/effort-policy.mjs';
import { discoveryRunId } from '../../src/lib/ai/discovery-policy.mjs';
import { initializeDiscoveryRuntimeGrant } from '../../src/lib/ai/discovery-grant-setup.mjs';

export async function portFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`本机端口 ${port} 已被占用；请先处理占用，不会停止其他程序。`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}
export async function databaseRunning() {
  if (!await exists(path.join(DATA, 'PG_VERSION'))) return false;
  return exec(path.join(PG, 'pg_ctl'), ['-D', DATA, 'status']).then(() => true, () => false);
}
export async function ensureDatabase() {
  if (!await exists(CONFIG)) throw new Error('请先运行 ./saitu setup。');
  if (await databaseRunning()) return;
  await portFree(5433);
  await mkdir(path.join(LOCAL, 'logs'), { recursive: true, mode: 0o700 });
  await exec(path.join(PG, 'pg_ctl'), ['-D', DATA, '-l', path.join(LOCAL, 'logs/postgres.log'), '-w', '-t', '30', 'start'], { timeout: 35000 });
}
export async function stopDatabase() {
  if (await databaseRunning()) await exec(path.join(PG, 'pg_ctl'), ['-D', DATA, '-m', 'fast', '-w', '-t', '30', 'stop'], { timeout: 35000 });
}
function connection(user, password, database) {
  const url = new URL(`postgresql://${user}@127.0.0.1:5433/${database}`); url.password = password; return url.href;
}
export async function adminClient(database = 'saitu_clean') {
  const config = await json(CONFIG);
  const client = new pg.Client({ connectionString: connection('postgres', config.adminPassword, database), connectionTimeoutMillis: 4000 });
  await client.connect(); return client;
}
export async function migrate(client) {
  await client.query('create table if not exists saitu_local_migrations (name text primary key, sha256 text not null, installed_at timestamptz not null default now())');
  const manifest = await readFile(path.join(ROOT, 'ops/config/migrations.manifest'), 'utf8');
  const names = ['db/schema.sql', ...manifest.split('\n').filter(line => line.trim() && !line.startsWith('#')).map(line => `db/migrations/${line.split(/\s+/)[1]}`),
    'db/migrations/20261119_local_standalone.sql', 'db/migrations/20261119_discovery_runtime_grant.sql',
    'db/migrations/20261119_competition_discovery.sql', 'db/migrations/20261119_discovery_call_receipts.sql'];
  for (const name of names) {
    const sql = await readFile(path.join(ROOT, name), 'utf8');
    const sha = createHash('sha256').update(sql).digest('hex');
    const installed = (await client.query('select sha256 from saitu_local_migrations where name=$1', [name])).rows[0];
    if (installed) { if (installed.sha256 !== sha) throw new Error(`已应用的数据库迁移发生变化：${name}`); continue; }
    await client.query(sql); await client.query('insert into saitu_local_migrations(name,sha256) values($1,$2)', [name, sha]);
  }
}
export async function grantRuntime(client, database, role) {
  const id = pg.escapeIdentifier;
  await client.query('revoke create on schema public from public');
  await client.query(`revoke create,temporary on database ${id(database)} from public`);
  await client.query(`grant usage on schema public to ${id(role)}`);
  const privilegeFiles = ['ops/postgresql/runtime-table-privileges.conf', 'ops/postgresql/discovery-runtime-table-privileges.conf'];
  for (const filename of privilegeFiles) for (const line of (await readFile(path.join(ROOT, filename), 'utf8')).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([a-z_]+)=((?:SELECT|INSERT|UPDATE)(?:,(?:SELECT|INSERT|UPDATE))*)$/.exec(line);
    if (!match) throw new Error('Invalid runtime table privileges');
    await client.query(`grant ${match[2]} on ${id(match[1])} to ${id(role)}`);
  }
  await client.query(`grant select on saitu_local_runtime_grants to ${id(role)}`);
  for (const line of (await readFile(path.join(ROOT, 'ops/postgresql/runtime-function-privileges.conf'), 'utf8')).split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([a-z_]+)=([a-z,]*)$/.exec(line);
    if (!match) throw new Error('Invalid runtime function privileges');
    await client.query(`grant execute on function public.${id(match[1])}(${match[2]}) to ${id(role)}`);
  }
}
export async function setup() {
  await mkdir(path.join(LOCAL, 'private'), { recursive: true, mode: 0o700 });
  let config;
  if (await exists(CONFIG)) config = await json(CONFIG);
  else {
    if (await exists(DATA)) throw new Error('数据库目录已存在但没有本副本凭据，拒绝覆盖。');
    await portFree(5433);
    const values = await settings();
    const total = Number(values.AI_SPEND_LIMIT_CNY || 300), funded = Number(values.AI_SPEND_FUNDED_CNY || total);
    if (![total, funded].every(n => Number.isFinite(n) && n > 0 && n <= 300)) throw new Error('本地预算配置必须在 0 至 300 元之间。');
    const adminPassword = randomBytes(32).toString('hex'), runtimePassword = randomBytes(32).toString('hex');
    config = { version: 1, adminPassword, runtimePassword, runtimeUrl: connection('saitu_clean_runtime', runtimePassword, 'saitu_clean'),
      runId: `saitu-local-${randomBytes(16).toString('hex')}`, phase: values.AI_SPEND_PHASE || 'calibration', capMicros: Math.floor(Math.min(total, funded) * 1e6),
      consentSalt: randomBytes(32).toString('hex'), signingSecret: randomBytes(32).toString('hex'), logSecret: randomBytes(32).toString('hex') };
    if (!['calibration', 'formal', 'repair', 'performance', 'reserve'].includes(config.phase)) throw new Error('Invalid local budget phase');
    await save(CONFIG, config);
  }
  if (!await exists(path.join(DATA, 'PG_VERSION'))) {
    if (await exists(DATA)) throw new Error('数据库初始化未完成；请检查 .local/logs，不自动重置数据。');
    const passwordFile = path.join(LOCAL, 'private/admin-password');
    await writeFile(passwordFile, config.adminPassword, { mode: 0o600 });
    await mkdir(path.dirname(DATA), { recursive: true, mode: 0o700 });
    await exec(path.join(PG, 'initdb'), ['-D', DATA, '--username=postgres', '--pwfile', passwordFile, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C'], { timeout: 35000, maxBuffer: 2e6 });
    await writeFile(path.join(DATA, 'saitu.conf'), "listen_addresses = '127.0.0.1'\nport = 5433\nunix_socket_directories = ''\nmin_wal_size = '32MB'\nmax_wal_size = '128MB'\n", { mode: 0o600 });
    await writeFile(path.join(DATA, 'postgresql.conf'), "\ninclude = 'saitu.conf'\n", { flag: 'a', mode: 0o600 });
  }
  await ensureDatabase();
  const host = await adminClient('postgres');
  try {
    if (!(await host.query("select 1 from pg_roles where rolname='saitu_clean_runtime'")).rowCount)
      await host.query(`create role saitu_clean_runtime login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${pg.escapeLiteral(config.runtimePassword)}`);
    if (!(await host.query("select 1 from pg_database where datname='saitu_clean'")).rowCount) await host.query('create database saitu_clean');
  } finally { await host.end(); }
  const client = await adminClient();
  try {
    await client.query('begin');
    await migrate(client); await grantRuntime(client, 'saitu_clean', 'saitu_clean_runtime');
    await client.query('insert into ai_spend_budgets(run_id,hard_limit_micros) values($1,$2) on conflict do nothing', [config.runId, config.capMicros]);
    await client.query('insert into ai_spend_authority(singleton,run_id) values(true,$1) on conflict do nothing', [config.runId]);
    const authority = (await client.query('select run_id from ai_spend_authority where singleton=true')).rows[0];
    if (authority?.run_id !== config.runId) throw new Error('Local authority differs; refusing reset');
    await client.query('insert into saitu_local_runtime_grants(run_id,phase,effort_policy,effort_policy_sha256,hard_limit_micros) values($1,$2,$3::jsonb,$4,$5) on conflict do nothing',
      [config.runId, config.phase, JSON.stringify(DEFAULT_EFFORT_POLICY), effortPolicySha256(DEFAULT_EFFORT_POLICY), config.capMicros]);
    await initializeDiscoveryRuntimeGrant(client, config.runId);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { await client.end(); }
  const currentValues = await settings();
  await updateSettings({ DATABASE_URL: config.runtimeUrl, NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3190', AI_SPEND_RUN_ID: config.runId,
    SAITU_DISCOVERY_SPEND_RUN_ID: discoveryRunId(config.runId),
    AI_SPEND_LIMIT_CNY: currentValues.AI_SPEND_LIMIT_CNY || String(config.capMicros / 1e6),
    AI_SPEND_FUNDED_CNY: currentValues.AI_SPEND_FUNDED_CNY || String(config.capMicros / 1e6),
    AI_SPEND_PHASE: config.phase, AI_CONSENT_SALT: config.consentSalt, AI_CONVERSATION_SIGNING_SECRET: config.signingSecret, LOG_HASH_SECRET: config.logSecret,
    SAITU_STANDALONE_LOCAL: '1', SAITU_AI_EXECUTION_MODE: 'finite', AI_TEST_MODE: '0', ALLOW_AI_MOCK: '0',
    AI_SPEND_AUTHORIZED_EFFORT: null, AI_SPEND_POLICY_SHA256: null, AI_SPEND_EFFORT_CONDITION_SHA256: null, AI_SPEND_HIGH_CONDITION_SHA256: null });
  console.log('独立数据库已准备好（127.0.0.1:5433）；未调用真实 AI。');
  return config;
}
