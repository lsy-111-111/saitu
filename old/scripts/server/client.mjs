import { readFile, readdir, mkdir, cp, lstat, writeFile, rm, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const host = process.env.SAITU_SSH_HOST?.trim();
const pinnedFingerprint = process.env.SAITU_SSH_HOST_FINGERPRINT?.trim();
const local = path.join(root, '.local/server');
const knownHosts = path.join(local, 'known_hosts');
const key = process.env.SAITU_SSH_KEY_FILE?.trim();
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const excludedDirectories = new Set(['.git', '.local', '.runtime', 'node_modules', 'dist', 'test-results', 'playwright-report', 'coverage']);
const excludedFile = name => /^\.env(?:\.|$)/.test(name) && name !== '.env.example'
  || /\.(?:pem|key|p12|pfx|log|tsbuildinfo)$/i.test(name) || name.startsWith('._') || name === '.DS_Store' || name === 'release-source-manifest.json';
function run(binary, args, { input, capture = false, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'], ...options });
    let output = '', errors = '';
    if (capture) { child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; }); }
    if (input !== undefined) child.stdin.end(input);
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`Command failed: ${binary} (${code})${capture ? ': ' + errors.slice(-1000) : ''}`)));
  });
}
async function ensureHost() {
  // Public source has no default production destination or private key path.
  if (!host || !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)
    || !pinnedFingerprint || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(pinnedFingerprint)
    || !key || !path.isAbsolute(key))
    throw new Error('Set SAITU_SSH_HOST (user@hostname), SAITU_SSH_HOST_FINGERPRINT and an absolute SAITU_SSH_KEY_FILE before server operations.');
  await mkdir(local, { recursive: true, mode: 0o700 });
  let known;
  try { known = await readFile(knownHosts, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!known) {
    known = await run('ssh-keyscan', ['-T', '8', '-t', 'ed25519', host.slice(host.indexOf('@') + 1)], { capture: true });
    const fingerprint = await run('ssh-keygen', ['-lf', '-'], { input: known, capture: true });
    if (!fingerprint.includes(pinnedFingerprint)) throw new Error('SERVER_HOST_KEY_CHANGED');
    await writeFile(knownHosts, known + '\n', { mode: 0o600 });
  }
  const fingerprint = await run('ssh-keygen', ['-lf', knownHosts], { capture: true });
  if (!fingerprint.includes(pinnedFingerprint)) throw new Error('SERVER_HOST_KEY_CHANGED');
}
const sshOptions = () => ['-i', key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
const remote = (command, input) => run('ssh', [...sshOptions(), host, command], { input });
async function snapshot(id) {
  const directory = path.join(local, 'packages', id), files = [];
  await mkdir(directory, { recursive: true, mode: 0o700 });
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = entry.name, filename = path.join(relative, name);
      if (entry.isDirectory() && (excludedDirectories.has(name) || name.startsWith('.next') || name === '.cache')) continue;
      if (excludedFile(name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Snapshot refuses symbolic link: ${filename}`);
      if (entry.isDirectory()) { await visit(filename); continue; }
      if (!entry.isFile()) continue;
      const destination = path.join(directory, filename);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(root, filename), destination);
      const contents = await readFile(destination);
      files.push({ path: filename.split(path.sep).join('/'), sha256: createHash('sha256').update(contents).digest('hex'), bytes: contents.length });
    }
  }
  await visit();
  files.sort((left, right) => left.path.localeCompare(right.path));
  await writeFile(path.join(directory, 'release-source-manifest.json'), JSON.stringify({ schemaVersion: 'saitu.release-source.v1', releaseId: id, createdAt: new Date().toISOString(), files }, null, 2) + '\n');
  const archive = path.join(local, 'packages', `${id}.tar.gz`);
  await run('tar', [...(process.platform === 'darwin' ? ['--no-xattrs'] : []), '-czf', archive, '-C', directory, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  await rm(directory, { recursive: true, force: true });
  return archive;
}
const [command, requestedId] = process.argv.slice(2);
if (command !== 'package') await ensureHost();
if (command === 'deploy') {
  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  console.log(`Preparing immutable source snapshot ${id} (includes uncommitted project changes).`);
  const archive = await snapshot(id);
  const remoteArchive = `/tmp/saitu-${id}.tar.gz`, directory = `/opt/resume-ai/releases/${id}`;
  await run('scp', [...sshOptions(), archive, `${host}:${remoteArchive}`]);
  const prepare = `test ! -e ${shellQuote(directory)} && sudo install -d -o root -g root -m 0755 ${shellQuote(directory)} && sudo tar --no-same-owner --no-same-permissions -xzf ${shellQuote(remoteArchive)} -C ${shellQuote(directory)} && sudo chmod 0755 ${shellQuote(directory)} && rm -f ${shellQuote(remoteArchive)} && sudo /opt/saitu-tools/node/bin/node ${shellQuote(directory + '/scripts/server/release.mjs')} prepare ${id}`;
  await remote(prepare);
  const values = parseEnv(await readFile(path.join(root, '.env.local'), 'utf8'));
  if (!values.AI_API_KEY?.trim()) throw new Error('Local AI_API_KEY is absent; production activation was not attempted.');
  await remote(`sudo /opt/saitu-tools/node/bin/node ${shellQuote(directory + '/scripts/server/initialize.mjs')} set-api-key`, values.AI_API_KEY.trim() + '\n');
  await remote(`sudo /opt/saitu-tools/node/bin/node ${shellQuote(directory + '/scripts/server/release.mjs')} activate ${id}`);
  console.log(`Published ${id}. Website: https://gzhanchuang.com`);
} else if (command === 'server-status') {
  await remote('sudo /opt/saitu-tools/node/bin/node /opt/resume-ai/current/scripts/server/release.mjs status');
} else if (command === 'rollback') {
  if (!/^20\d{6}T\d{6}Z$/.test(requestedId || '')) throw new Error('Provide the successful release ID to restore.');
  await remote(`sudo /opt/saitu-tools/node/bin/node /opt/resume-ai/current/scripts/server/release.mjs rollback ${requestedId}`);
} else if (command === 'package') {
  const id = requestedId || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  if (!/^20\d{6}T\d{6}Z$/.test(id)) throw new Error('Invalid release ID.');
  console.log(await snapshot(id));
} else throw new Error('Usage: ./saitu deploy | server-status | rollback RELEASE_ID');
