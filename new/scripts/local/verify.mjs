import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import pg from 'pg';
import { ROOT, LOCAL, NODE, CONFIG, exists, json, run, inheritedEnvironment, save } from './shared.mjs';
import { ensureDatabase, adminClient } from './database.mjs';

async function checkLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(filename);
      if (!target.startsWith(ROOT + path.sep)) throw new Error(`External dependency link: ${path.relative(ROOT, filename)}`);
    } else if (entry.isDirectory() && entry.name !== '.git') await checkLinks(filename);
  }
}
export async function verify() {
  // Verification must not migrate the application database or refresh the
  // grant used by an already running web/worker build. All test DDL below is
  // confined to a fresh, randomly named database and its restricted role.
  if (!await exists(CONFIG)) throw new Error('请先运行 ./saitu setup 初始化本机环境；离线验证不会初始化或更新当前服务授权。');
  await ensureDatabase();
  const config = await json(CONFIG);
  const id = randomBytes(8).toString('hex'), database = `resume_ai_test_${id}`, role = `resume_ai_test_runtime_${id}`;
  const password = randomBytes(32).toString('hex'), host = await adminClient('postgres');
  const startedAt = new Date().toISOString();
  try {
    await host.query(`create role ${pg.escapeIdentifier(role)} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${pg.escapeLiteral(password)}`);
    await host.query(`create database ${pg.escapeIdentifier(database)}`);
    const adminUrl = new URL(`postgresql://postgres@127.0.0.1:5433/${database}`); adminUrl.password = config.adminPassword;
    const runtimeUrl = new URL(`postgresql://${role}@127.0.0.1:5433/${database}`); runtimeUrl.password = password;
    const env = { ...inheritedEnvironment(), NODE_ENV: 'test', PATH: `${path.dirname(NODE)}:${process.env.PATH || '/usr/bin:/bin'}`,
      AI_API_KEY: '', OPENAI_API_KEY: '', DATABASE_URL: '', AI_SPEND_RUN_ID: '', RUN_DEEPSEEK_LIVE: '0', RUN_DEEPSEEK_NORMALIZE_LIVE: '0',
      SAITU_LOCAL_TEST_DATABASE: '1', RUN_V7_DATABASE_TESTS: '1', V7_TEST_ADMIN_DATABASE_URL: adminUrl.href, V7_TEST_RUNTIME_DATABASE_URL: runtimeUrl.href,
      NODE_OPTIONS: `--import=${JSON.stringify(path.join(ROOT, 'scripts/local/no-external-network.mjs'))}` };
    console.log('验证独立路径、类型、lint、核心测试和真实隔离数据库；外部网络被禁止。');
    await checkLinks(path.join(ROOT, 'node_modules')); await checkLinks(path.join(ROOT, '.runtime'));
    for (const name of ['.env.local', '.local/private/database.json']) {
      if ((await lstat(path.join(ROOT, name))).mode & 0o077) throw new Error(`Private file permissions: ${name}`);
    }
    await run(NODE, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false'], env);
    await run(NODE, ['node_modules/eslint/bin/eslint.js', 'src', 'tests', '--ext', '.ts,.tsx', '--max-warnings=0'], env);
    await run(NODE, ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2'], env);
    await mkdir(path.join(LOCAL, 'checks'), { recursive: true, mode: 0o700 });
    await save(path.join(LOCAL, 'checks/core.json'), { startedAt, completedAt: new Date().toISOString(), passed: true, externalNetwork: 'blocked', paidAiCalls: 0, liveAiVerified: false });
    console.log('核心验证通过；真实 AI 连通性和输出效果未实测。');
  } finally {
    await host.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()', [database]);
    await host.query(`drop database if exists ${pg.escapeIdentifier(database)}`);
    await host.query(`drop role if exists ${pg.escapeIdentifier(role)}`);
    await host.end();
  }
}
