#!/usr/bin/env node
import path from 'node:path';
import { open, unlink, symlink, mkdir, rmdir, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, LOCAL, NODE, exec, exists, json, save, environment, inheritedEnvironment, run, sanitizedError } from './shared.mjs';
import { setup, ensureDatabase, stopDatabase, databaseRunning, portFree } from './database.mjs';

const recordsFile = path.join(LOCAL, 'processes.json');
const healthFile = path.join(LOCAL, 'worker-health.json');
async function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  return exec('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command=']).then(r => r.stdout.trim() || null, () => null);
}
async function matches(record) { return Boolean(record?.identity && await identity(record.pid) === record.identity); }
const records = () => json(recordsFile).catch(() => ({}));
async function paidAiValidationEvidence() {
  const directory = path.join(LOCAL, 'checks', 'discovery-live');
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const batches = entries.filter(entry => entry.isDirectory() && /^\d{8}T\d{6}(?:\d{3})?Z(?:-\d+)?$/.test(entry.name))
    .map(entry => entry.name);
  const summaries = [];
  for (const batch of batches) {
    const evidencePath = path.join(directory, batch, 'summary.json');
    const evidence = await json(evidencePath).catch(() => null);
    if (evidence?.schemaVersion !== 'saitu.discovery-live-summary.v1' || !Array.isArray(evidence.cases)
      || typeof evidence.completedAt !== 'string' || !Number.isFinite(Date.parse(evidence.completedAt))) continue;
    summaries.push({ evidence, evidencePath });
  }
  summaries.sort((a, b) => Date.parse(b.evidence.completedAt) - Date.parse(a.evidence.completedAt)
    || b.evidencePath.localeCompare(a.evidencePath));
  const latest = summaries[0];
  if (latest) {
    const { evidence, evidencePath } = latest;
    const testedCases = evidence.cases.length;
    const totalCases = Array.isArray(evidence.selectedCaseIds) ? evidence.selectedCaseIds.length : testedCases;
    return { lastCheckedAt: evidence.completedAt,
      completedCases: evidence.cases.filter(value => value?.status === 'complete').length,
      testedCases, totalCases,
      remainingCases: Array.isArray(evidence.remainingCaseIds) ? evidence.remainingCaseIds.length : Math.max(0, totalCases - testedCases),
      interrupted: evidence.interrupted === true,
      observedHostedSearch: evidence.observedHostedSearch === true
        || evidence.cases.some(value => value?.webSearchUsed === true || value?.acrossAttemptsToolEventCount > 0),
      manualContentReview: 'required', evidencePath };
  }
  return 'not_performed';
}
async function state() {
  const value = await records();
  const health = await json(healthFile).catch(() => null);
  const web = await matches(value.web), worker = await matches(value.worker), database = await databaseRunning();
  return { mode: value.mode ?? null, origin: value.origin ?? 'http://127.0.0.1:3190', web, worker, database,
    running: Boolean(web && worker && database && health?.status === 'active' && health.databaseReady && Date.now() - Date.parse(health.updatedAt) < 10000),
    workerState: worker ? health?.status ?? 'starting' : 'stopped', paidAiValidation: await paidAiValidationEvidence() };
}
async function signal(record, event) {
  if (await matches(record)) { try { process.kill(-record.pid, event); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}
async function stop(keepDatabase = false) {
  const value = await records();
  await signal(value.web, 'SIGTERM');
  await unlink(path.join(LOCAL, 'current')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  // No new jobs can dispatch after the active link is removed. Let existing work settle.
  // Discovery has a 180-second absolute deadline, including one retry. Drain
  // already dispatched work before shutting down the database it settles into.
  for (let i = 0; i < 190 && await matches(value.worker); i++) {
    const health = await json(healthFile).catch(() => null);
    if (!health?.inFlight) break;
    if (i === 189) throw new Error('后台任务仍在完成中，未强制结束；请稍后再次停止。');
    await delay(1000);
  }
  await signal(value.worker, 'SIGTERM');
  for (let i = 0; i < 30; i++) {
    if (!await matches(value.web) && !await matches(value.worker)) break;
    if (i === 29) throw new Error('进程仍在停止中；保留数据库，请稍后检查状态。');
    await delay(500);
  }
  await unlink(recordsFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!keepDatabase) await stopDatabase();
  console.log('本副本服务已停止，数据已保留。');
}
async function build() {
  const current = await state();
  if (current.web || current.worker) throw new Error('请先停止本副本，或使用 ./saitu rebuild。');
  if (!await exists(path.join(LOCAL, 'private/database.json'))) await setup();
  const env = await environment('production');
  Object.assign(env, { AI_API_KEY: '', DATABASE_URL: '', AI_SPEND_RUN_ID: '', SAITU_V7_LOCAL_PREVIEW: '', NEXT_DIST_DIR: '.next' });
  delete env.SAITU_V7_SOURCE_SHA256;
  console.log('构建网页与后台任务；不会调用真实 AI。');
  await run(NODE, ['scripts/competitions/v7/build-worker.mjs', '--with-next', 'node_modules/next/dist/bin/next'], env);
}
async function verifyBuild() {
  const manifest = await json(path.join(ROOT, 'dist/decision-worker/manifest.json'));
  const binding = await json(path.join(ROOT, '.next/decision-worker-binding.json'));
  const buildId = (await readFile(path.join(ROOT, '.next/BUILD_ID'), 'utf8')).trim();
  const digest = createHash('sha256').update(await readFile(path.join(ROOT, 'dist/decision-worker/worker.mjs'))).digest('hex');
  const env = await environment('production'); delete env.SAITU_V7_SOURCE_SHA256;
  const source = (await exec(NODE, ['scripts/competitions/v7/build-worker.mjs', '--binding-only'], { cwd: ROOT, env, maxBuffer: 2e6 })).stdout.trim();
  if (manifest.sourceSha256 !== source || binding.sourceSha256 !== source || manifest.artifactSha256 !== digest
    || binding.workerArtifactSha256 !== digest || manifest.nextBuildId !== buildId || binding.nextBuildId !== buildId)
    throw new Error('源码或构建已变化，请双击“重建并启动.command”。');
}
async function launch(name, args, env) {
  const handle = await open(path.join(LOCAL, 'logs', `${name}.log`), 'a', 0o600);
  try {
    const child = spawn(NODE, args, { cwd: ROOT, env, detached: true, stdio: ['ignore', handle.fd, handle.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { pid: child.pid, identity: await identity(child.pid) };
  } finally { await handle.close(); }
}
async function start(mode = 'production', openBrowser = false) {
  const current = await state();
  if (current.running && current.mode === mode) {
    console.log(`已经运行：${current.origin}`);
    if (openBrowser) await exec('/usr/bin/open', [current.origin]);
    return;
  }
  if (current.web || current.worker) await stop(true);
  await setup(); await ensureDatabase();
  if (mode === 'production') {
    if (!await exists(path.join(ROOT, '.next/BUILD_ID'))) await build();
    await verifyBuild();
  }
  const port = mode === 'development' ? 3191 : 3190;
  await portFree(port);
  await unlink(path.join(LOCAL, 'current')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await symlink('..', path.join(LOCAL, 'current'));
  await unlink(healthFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const env = await environment(mode); env.SAITU_LOCAL_PROCESS_MODE = mode;
  const preload = path.join(ROOT, 'scripts/local/env.mjs');
  const value = { mode, origin: `http://127.0.0.1:${port}` };
  value.worker = await launch('worker', mode === 'development'
    ? ['--watch', '--watch-path=src', '--watch-path=db/migrations', '--watch-path=scripts/competitions/v7/worker-entry.ts', '--import', preload, 'scripts/local/dev-worker.mjs']
    : ['--import', preload, 'dist/decision-worker/worker.mjs'], env);
  await save(recordsFile, value);
  value.web = await launch('web', ['--import', preload, 'node_modules/next/dist/bin/next', mode === 'development' ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(port)], env);
  await save(recordsFile, value);
  for (let i = 0; i < 90; i++) {
    // Next changes its process title; refresh only identities of the freshly launched PIDs.
    value.web.identity = await identity(value.web.pid); value.worker.identity = await identity(value.worker.pid);
    await save(recordsFile, value);
    if (!value.web.identity || !value.worker.identity) throw new Error('启动进程已退出，请查看 .local/logs。');
    const ready = await state();
    const response = ready.running ? await fetch(`${value.origin}/`, { signal: AbortSignal.timeout(3000) }).catch(() => null) : null;
    if (response?.status === 200) {
      console.log(`赛途已启动：${value.origin}（${mode === 'development' ? '开发模式' : '构建版'}）`);
      if (openBrowser) await exec('/usr/bin/open', [value.origin]);
      return;
    }
    await delay(1000);
  }
  throw new Error('启动超时，请运行 ./saitu status 并查看 .local/logs。');
}
async function locked(callback) {
  await mkdir(LOCAL, { recursive: true, mode: 0o700 });
  const lock = path.join(LOCAL, 'control.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await json(path.join(lock, 'owner.json')).catch(() => null);
    if (!owner || await matches(owner)) throw new Error('另一个启动或停止操作正在进行，请稍后再试。');
    await unlink(path.join(lock, 'owner.json')); await rmdir(lock); await mkdir(lock, { mode: 0o700 });
  }
  await save(path.join(lock, 'owner.json'), { pid: process.pid, identity: await identity(process.pid) });
  try { return await callback(); }
  finally { await unlink(path.join(lock, 'owner.json')); await rmdir(lock); }
}
const [command = 'status', ...args] = process.argv.slice(2);
try {
  process.chdir(ROOT);
  if (command === 'status') console.log(JSON.stringify(await state(), null, 2));
  else if (command === 'verify') {
    const { verify } = await import('./verify.mjs'); await verify();
  } else if (command === 'pnpm') {
    await run(NODE, ['.runtime/pnpm/bin/pnpm.mjs', ...args], { ...inheritedEnvironment(), PATH: `${path.dirname(NODE)}:${process.env.PATH || '/usr/bin:/bin'}` });
  } else await locked(async () => {
    if (command === 'setup') await setup();
    else if (command === 'build') await build();
    else if (command === 'stop') await stop();
    else if (command === 'start' || command === 'dev') await start(command === 'dev' ? 'development' : 'production', args.includes('--open'));
    else if (command === 'rebuild') { await stop(true); await build(); await start('production', args.includes('--open')); }
    else throw new Error('用法：./saitu setup|build|start|stop|status|dev|rebuild|verify|pnpm');
  });
} catch (error) { console.error(await sanitizedError(error)); process.exitCode = 1; }
