import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPLICATION_ROOT = '/opt/resume-ai';
export const ENV_FILE = '/etc/saitu/saitu.env';
export const NODE = '/opt/saitu-tools/node/bin/node';
export const PNPM = '/opt/saitu-tools/node/bin/pnpm';
export const RELEASE_PATTERN = /^20\d{6}T\d{6}Z$/;
export const sourceRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export function requireRoot() { if (process.getuid?.() !== 0) throw new Error('SERVER_ROOT_REQUIRED'); }
export function releaseDirectory(id) { if (!RELEASE_PATTERN.test(id ?? '')) throw new Error('INVALID_RELEASE_ID'); return `${APPLICATION_ROOT}/releases/${id}`; }
export async function readEnvironment() {
  const values = parseEnv(await readFile(ENV_FILE, 'utf8'));
  if (values.SAITU_RUNTIME_MODE !== 'server' || values.NEXT_PUBLIC_SITE_URL !== 'https://gzhanchuang.com') throw new Error('SERVER_ENVIRONMENT_INVALID');
  return { ...process.env, ...values, PATH: `/opt/saitu-tools/node/bin:/usr/bin:/bin`, HOME: '/var/lib/saitu/build-home' };
}
export async function atomicWrite(filename, contents, mode = 0o600) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o750 });
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode }); await chmod(temporary, mode); await rename(temporary, filename);
}
export function serializeEnvironment(values) {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(String(value))) throw new Error('INVALID_ENVIRONMENT_VALUE');
    return `${key}=${JSON.stringify(String(value))}`;
  }).join('\n') + '\n';
}
export function execute(binary, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
    if (options.input !== undefined) child.stdin.end(options.input);
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`SERVER_COMMAND_FAILED:${path.basename(binary)}:${code}`)));
  });
}
export async function captured(binary, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '', errors = '';
    if (options.input !== undefined) child.stdin.end(options.input);
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`SERVER_COMMAND_FAILED:${path.basename(binary)}:${code}:${errors.slice(-800)}`)));
  });
}
