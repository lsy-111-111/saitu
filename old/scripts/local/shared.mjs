import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_EFFORT_POLICY, effortPolicySha256 } from '../../src/lib/ai/effort-policy.mjs';
import { discoveryRunId } from '../../src/lib/ai/discovery-policy.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export const LOCAL = path.join(ROOT, '.local');
export const NODE = path.join(ROOT, '.runtime/node/bin/node');
export const PG = path.join(ROOT, '.runtime/postgres/bin');
export const DATA = path.join(LOCAL, 'postgres/data');
export const CONFIG = path.join(LOCAL, 'private/database.json');
export const exec = promisify(execFile);
export const exists = filename => access(filename).then(() => true, () => false);
export const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
export async function save(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export const settings = async () => parseEnv(await readFile(path.join(ROOT, '.env.local'), 'utf8').catch(() => ''));
export async function updateSettings(changes) {
  const current = { ...await settings(), ...changes };
  for (const key of Object.keys(current)) if (current[key] === null) delete current[key];
  await writeFile(path.join(ROOT, '.env.local'), Object.entries(current).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n', { mode: 0o600 });
}
export function inheritedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AI_|SAITU_|SUPABASE_|DATABASE_URL$|FEATURE_|NEXT_|NODE_OPTIONS$|NODE_PATH$|APP_RELEASE_DIR$|ALLOW_AI_MOCK$|RUN_.*LIVE|V7_TEST_)/.test(key)));
}
export async function environment(mode = 'production') {
  const config = await json(CONFIG);
  const values = await settings();
  const env = { ...inheritedEnvironment(), ...values, NODE_ENV: mode,
    PATH: `${path.dirname(NODE)}:${path.join(ROOT, 'node_modules/.bin')}:${process.env.PATH || '/usr/bin:/bin'}`,
    NEXT_TELEMETRY_DISABLED: '1', SAITU_STANDALONE_LOCAL: '1', SAITU_AI_EXECUTION_MODE: 'finite',
    SAITU_V7_EFFORT_POLICY: JSON.stringify(DEFAULT_EFFORT_POLICY), SAITU_V7_EFFORT_POLICY_SHA256: effortPolicySha256(DEFAULT_EFFORT_POLICY),
    SAITU_V7_DETAIL_LAYOUT: 'single', NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${mode === 'development' ? 3191 : 3190}`,
    DATABASE_URL: config.runtimeUrl, AI_SPEND_RUN_ID: config.runId, AI_SPEND_PHASE: config.phase,
    SAITU_DISCOVERY_SPEND_RUN_ID: discoveryRunId(config.runId),
    AI_TEST_MODE: '0', ALLOW_AI_MOCK: '0', NEXT_PUBLIC_AI_TEST_MODE: '0', E2E_ALLOW_EPHEMERAL_SECURITY_STATE: '0',
    APP_RELEASE_DIR: ROOT, SAITU_V7_WORKER_ACTIVE_LINK: path.join(LOCAL, 'current'),
    SAITU_V7_WORKER_HEALTH_FILE: path.join(LOCAL, 'worker-health.json'), NEXT_DIST_DIR: mode === 'development' ? '.next-dev' : '.next' };
  for (const key of ['SAITU_LOCAL_PREVIEW_CONFIG', 'SAITU_V7_SOURCE_SHA256', 'SAITU_DISCOVERY_SOURCE_SHA256', 'AI_SPEND_AUTHORIZED_EFFORT', 'AI_SPEND_POLICY_SHA256', 'AI_SPEND_HIGH_CONDITION_SHA256', 'AI_SPEND_EFFORT_CONDITION_SHA256', 'SAITU_LOCAL_TEST_DATABASE']) delete env[key];
  if (mode === 'production') {
    env.SAITU_V7_LOCAL_PREVIEW = '1';
    if (await exists(path.join(ROOT, 'dist/decision-worker/manifest.json'))) {
      const manifest = await json(path.join(ROOT, 'dist/decision-worker/manifest.json'));
      env.SAITU_V7_SOURCE_SHA256 = manifest.sourceSha256;
      env.SAITU_DISCOVERY_SOURCE_SHA256 = manifest.sourceSha256;
    }
  } else delete env.SAITU_V7_LOCAL_PREVIEW;
  return env;
}
export function run(binary, args, env, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: ROOT, env, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error(`Command failed (${code ?? signal}): ${path.basename(binary)}`)));
  });
}
export async function sanitizedError(error) {
  let message = error instanceof Error ? error.message : String(error);
  const values = await settings();
  for (const [key, value] of Object.entries(values)) if (/KEY|SECRET|SALT|DATABASE_URL/.test(key) && value) message = message.split(value).join('[REDACTED]');
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[DATABASE_URL]').slice(0, 2000);
}
