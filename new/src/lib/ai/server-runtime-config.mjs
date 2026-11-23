/** Deployment identity is deliberately narrower than general environment config. */
export const SERVER_SITE_ORIGIN = 'https://gzhanchuang.com';
export const SERVER_DATABASE_NAME = 'saitu_production';

export function isServerRuntime(environment = process.env) {
  const mode = environment.SAITU_RUNTIME_MODE;
  if (mode === 'server') return true;
  if (mode === undefined || mode === '' || mode === 'local') return false;
  throw new Error('INVALID_SAITU_RUNTIME_MODE');
}

export function readServerRuntimeConfiguration(environment = process.env) {
  if (!isServerRuntime(environment) || environment.SAITU_AI_EXECUTION_MODE !== 'finite'
    || environment.SAITU_STANDALONE_LOCAL === '1') throw new Error('SERVER_RUNTIME_CONFIGURATION_REQUIRED');
  let database, origin;
  try {
    database = new URL(environment.DATABASE_URL ?? '');
    origin = new URL(environment.NEXT_PUBLIC_SITE_URL ?? '');
  } catch { throw new Error('SERVER_RUNTIME_CONFIGURATION_REQUIRED'); }
  const isolatedTest = environment.NODE_ENV === 'test' && environment.SAITU_LOCAL_TEST_DATABASE === '1'
    && database.port === '5433'
    && /^saitu_v7_(?:backend|durable)_[a-f0-9]{32}$/.test(database.pathname.slice(1));
  if (origin.href !== `${SERVER_SITE_ORIGIN}/`
    || !['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1'
    || database.search || database.hash || !database.username
    || (!isolatedTest && (database.port !== '5432' || database.pathname !== `/${SERVER_DATABASE_NAME}`)))
    throw new Error('SERVER_RUNTIME_CONFIGURATION_REQUIRED');
  return { origin: SERVER_SITE_ORIGIN, databaseName: database.pathname.slice(1) };
}
