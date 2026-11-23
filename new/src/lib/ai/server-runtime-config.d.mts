export const SERVER_SITE_ORIGIN: 'https://gzhanchuang.com';
export const SERVER_DATABASE_NAME: 'saitu_production';
export function isServerRuntime(environment?: Readonly<Record<string, string | undefined>>): boolean;
export function readServerRuntimeConfiguration(environment?: Readonly<Record<string, string | undefined>>): {
  origin: typeof SERVER_SITE_ORIGIN; databaseName: string;
};
