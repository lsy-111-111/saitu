import { readFile, readdir, lstat, realpath, symlink, rename, rm, mkdir, writeFile, access, chown } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { APPLICATION_ROOT, NODE, PNPM, ENV_FILE, requireRoot, releaseDirectory, readEnvironment, execute, captured, atomicWrite, serializeEnvironment } from './common.mjs';

requireRoot();
const requestedCommand = process.argv[2];
if (!process.argv.includes('--deployment-lock-held') && ['prepare', 'activate', 'rollback', 'install-services'].includes(requestedCommand)) {
  await execute('flock', ['--nonblock', '/var/lib/saitu/deploy.lock', NODE, fileURLToPath(import.meta.url), ...process.argv.slice(2), '--deployment-lock-held']);
  process.exit(0);
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const maintenance = '/var/lib/saitu/maintenance';
const exists = filename => access(filename).then(() => true, () => false);
const currentId = async () => realpath(`${APPLICATION_ROOT}/current`).then(value => path.basename(value), () => null);
const identity = async () => ({ uid: Number(await captured('id', ['-u', 'saitu'])), gid: Number(await captured('id', ['-g', 'saitu'])) });
const databaseQuery = sql => captured('sudo', ['-u', 'postgres', '--', '/usr/lib/postgresql/17/bin/psql', '-Atq', '-v', 'ON_ERROR_STOP=1', '-d', 'saitu_production', '-c', sql]);

async function verifySource(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'release-source-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 'saitu.release-source.v1' || !Array.isArray(manifest.files)) throw new Error('RELEASE_SOURCE_MANIFEST_INVALID');
  const allowed = new Set(['release-source-manifest.json', ...manifest.files.map(entry => entry.path)]);
  async function inspect(relative = '') {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const filename = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await inspect(filename);
      else if (!entry.isFile() || !allowed.has(filename)) throw new Error(`UNLISTED_RELEASE_FILE:${filename}`);
    }
  }
  await inspect();
  for (const entry of manifest.files) {
    if (!entry.path || path.isAbsolute(entry.path) || entry.path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('RELEASE_FILE_INVALID');
    const filename = path.join(directory, entry.path);
    if (!(await lstat(filename)).isFile()) throw new Error('RELEASE_SYMLINK_REJECTED');
    const actual = createHash('sha256').update(await readFile(filename)).digest('hex');
    if (actual !== entry.sha256) throw new Error(`RELEASE_FILE_CHANGED:${entry.path}`);
  }
}
async function verifyBuild(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'dist/decision-worker/manifest.json'), 'utf8'));
  const binding = await readFile(path.join(directory, '.next/decision-worker-binding.json'));
  const parsed = JSON.parse(binding);
  const worker = await readFile(path.join(directory, 'dist/decision-worker/worker.mjs'));
  const workerHash = createHash('sha256').update(worker).digest('hex');
  const buildId = (await readFile(path.join(directory, '.next/BUILD_ID'), 'utf8')).trim();
  if (manifest.artifactSha256 !== workerHash || parsed.workerArtifactSha256 !== workerHash || parsed.sourceSha256 !== manifest.sourceSha256
    || parsed.nextBuildId !== buildId || manifest.nextBuildId !== buildId || createHash('sha256').update(binding).digest('hex') !== manifest.nextBindingSha256)
    throw new Error('WEB_WORKER_BUILD_MISMATCH');
  return manifest;
}
async function installServices(directory) {
  const templates = path.join(directory, 'ops/server');
  for (const filename of await readdir(templates)) {
    if (/^saitu-.*\.(service|timer)$/.test(filename)) await execute('install', ['-o', 'root', '-g', 'root', '-m', '0644', path.join(templates, filename), `/etc/systemd/system/${filename}`]);
  }
  await execute('systemctl', ['daemon-reload']);
}
async function initialize(directory) { await execute(NODE, [path.join(directory, 'scripts/server/initialize.mjs')]); }
async function prepare(id) {
  const directory = releaseDirectory(id);
  if (await exists(path.join(directory, '.release-ready'))) throw new Error('RELEASE_ALREADY_BUILT');
  await verifySource(directory);
  const account = await identity();
  // A local snapshot is private while being assembled. Published source has
  // no environment secrets and must be traversable by the postgres migrator.
  await execute('chmod', ['-R', 'u=rwX,go=rX', directory]);
  await execute('chown', ['-R', 'saitu:saitu', directory]);
  const base = { ...process.env, PATH: '/opt/saitu-tools/node/bin:/usr/bin:/bin', HOME: '/var/lib/saitu/build-home', NODE_ENV: 'development',
    // Only the bundled CPU tokenizer is used; this server has no CUDA workload.
    ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip' };
  await execute(PNPM, ['install', '--frozen-lockfile', '--prod=false'], { cwd: directory, env: base, ...account });
  if (!await exists(ENV_FILE)) await initialize(directory);
  const env = { ...await readEnvironment(), APP_RELEASE_DIR: directory };
  // Build does not use the Mac-only control script or preload its environment.
  await execute(NODE, ['scripts/competitions/v7/build-worker.mjs', '--with-next', 'node_modules/next/dist/bin/next'], { cwd: directory, env, ...account });
  const manifest = await verifyBuild(directory);
  await mkdir(`/var/cache/resume-ai/${id}/next-cache`, { recursive: true, mode: 0o750 });
  await execute('chown', ['-R', 'saitu:saitu', `/var/cache/resume-ai/${id}`]);
  await rm(path.join(directory, '.next/cache'), { recursive: true, force: true });
  await symlink(`/var/cache/resume-ai/${id}/next-cache`, path.join(directory, '.next/cache'));
  await execute('chown', ['-hR', 'root:saitu', directory]);
  await execute('chmod', ['-R', 'go-w', directory]);
  await atomicWrite(`/etc/saitu/releases/${id}.env`, serializeEnvironment({ APP_RELEASE_DIR: directory,
    SAITU_V7_WORKER_HEALTH_FILE: `/var/cache/resume-ai/${id}/decision-worker-health.json`,
    SAITU_V7_SOURCE_SHA256: manifest.sourceSha256, SAITU_DISCOVERY_SOURCE_SHA256: manifest.sourceSha256 }), 0o640);
  await chown(`/etc/saitu/releases/${id}.env`, 0, account.gid);
  await writeFile(path.join(directory, '.release-ready'), new Date().toISOString() + '\n', { mode: 0o644 });
  await installServices(directory);
  console.log(`Release built and verified: ${id}`);
}
async function setCurrent(id) {
  const temporary = `${APPLICATION_ROOT}/.current-${process.pid}`;
  await rm(temporary, { force: true }); await symlink(releaseDirectory(id), temporary); await rename(temporary, `${APPLICATION_ROOT}/current`);
}
async function pauseAndDrain() {
  await writeFile(maintenance, new Date().toISOString() + '\n', { mode: 0o644 });
  await databaseQuery('begin; select pg_advisory_xact_lock(724310896145225::bigint); commit;');
  const until = Date.now() + 185000;
  while (Number(await databaseQuery("select count(*) from competition_discovery_runs where status in ('queued','running')")) > 0) {
    if (Date.now() >= until) throw new Error('TASK_DRAIN_TIMEOUT');
    await delay(1500);
  }
}
async function stop(id) {
  if (!id) return;
  await execute('systemctl', ['disable', '--now', `saitu-web@${id}.service`, `saitu-worker@${id}.service`]);
}
async function start(id) {
  await execute('systemctl', ['enable', '--now', `saitu-worker@${id}.service`, `saitu-web@${id}.service`]);
}
async function waitReady() {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:3190/api/health/ready', { headers: { Host: 'gzhanchuang.com', 'X-Forwarded-Proto': 'https' }, signal: AbortSignal.timeout(3000) });
      if (response.ok && (await response.json()).ready === true) return;
    } catch { /* Wait for both processes to become ready. */ }
    await delay(1000);
  }
  throw new Error('RELEASE_READINESS_FAILED');
}
async function pruneReleases(active) {
  const successes = [];
  for (const id of await readdir(`${APPLICATION_ROOT}/releases`)) {
    if (/^20\d{6}T\d{6}Z$/.test(id) && await exists(path.join(releaseDirectory(id), '.release-success'))) successes.push(id);
  }
  const keep = new Set([active, ...successes.sort().reverse().slice(0, 5)]);
  for (const id of successes) if (!keep.has(id)) {
    await rm(releaseDirectory(id), { recursive: true, force: true });
    await rm(`/var/cache/resume-ai/${id}`, { recursive: true, force: true });
    await rm(`/etc/saitu/releases/${id}.env`, { force: true });
  }
}
async function activate(id, rollback = false) {
  const directory = releaseDirectory(id), previous = await currentId();
  if (!await exists(path.join(directory, '.release-ready'))) throw new Error('RELEASE_NOT_PREPARED');
  if (rollback && !await exists(path.join(directory, '.release-success'))) throw new Error('ROLLBACK_REQUIRES_SUCCESSFUL_RELEASE');
  await verifyBuild(directory);
  if (id === previous) { await waitReady(); console.log(`Already active: ${id}`); return; }
  let stoppedPrevious = false;
  try {
    await pauseAndDrain();
    if (previous) await execute('/bin/bash', [path.join(releaseDirectory(previous), 'scripts/server/backup.sh')]);
    if (!rollback) await initialize(directory);
    stoppedPrevious = true; await stop(previous);
    await installServices(directory); await setCurrent(id); await start(id); await waitReady();
    await execute('systemctl', ['enable', '--now', 'saitu-retention.timer', 'saitu-backup.timer']);
    await writeFile(path.join(directory, '.release-success'), new Date().toISOString() + '\n', { mode: 0o644 });
    await rm(maintenance, { force: true });
    await pruneReleases(id);
    console.log(`Active release: ${id}`);
  } catch (error) {
    if (stoppedPrevious) {
      await stop(id).catch(() => undefined);
      if (previous) { await setCurrent(previous); await start(previous); await waitReady(); }
    }
    // A healthy previous release can resume; otherwise keep maintenance set.
    if (previous) await rm(maintenance, { force: true });
    throw error;
  }
}
async function status() {
  const id = await currentId();
  console.log(JSON.stringify({ activeRelease: id, maintenance: await exists(maintenance) }));
  if (id) {
    await execute('systemctl', ['--no-pager', '--full', 'status', `saitu-web@${id}.service`, `saitu-worker@${id}.service`]).catch(() => undefined);
    await execute('systemctl', ['list-timers', '--no-pager', 'saitu-backup.timer', 'saitu-retention.timer']);
    try {
      const healthy = JSON.parse(await readFile(`/var/cache/resume-ai/${id}/decision-worker-health.json`, 'utf8'));
      console.log(JSON.stringify({ worker: { status: healthy.status, databaseReady: healthy.databaseReady, concurrency: healthy.concurrency, inFlight: healthy.inFlight, updatedAt: healthy.updatedAt, governor: healthy.governor } }));
    } catch { console.log(JSON.stringify({ worker: { status: 'health-file-unavailable' } })); }
    try {
      const pending = await databaseQuery("select json_build_object('queued',count(*) filter(where status='queued'),'running',count(*) filter(where status='running')) from competition_discovery_runs where status in ('queued','running')");
      console.log(JSON.stringify({ tasks: JSON.parse(pending) }));
    } catch { console.log(JSON.stringify({ tasks: { status: 'database-unavailable' } })); }
  }
  const backups = (await readdir('/var/backups/saitu')).filter(name => /^20\d{6}T\d{6}Z$/.test(name)).sort();
  console.log(JSON.stringify({ latestBackup: backups.at(-1) ?? null, backupCount: backups.length }));
  if (await exists('/etc/letsencrypt/live/gzhanchuang.com/cert.pem')) await execute('openssl', ['x509', '-in', '/etc/letsencrypt/live/gzhanchuang.com/cert.pem', '-noout', '-enddate']);
}
const [command, id] = process.argv.slice(2);
if (command === 'prepare') await prepare(id);
else if (command === 'activate') await activate(id);
else if (command === 'rollback') await activate(id, true);
else if (command === 'status') await status();
else if (command === 'install-services') await installServices(root);
else if (command === 'verify-source') await verifySource(releaseDirectory(id));
else throw new Error('Usage: release.mjs prepare|activate|rollback|verify-source RELEASE_ID, or status|install-services');
