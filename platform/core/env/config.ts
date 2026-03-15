export type AppEnvironment = 'development' | 'staging' | 'production';

export interface PlatformConfig {
  env: AppEnvironment;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databaseUrl: string;
  buildVersion: string;
}

export function getPlatformConfig(): PlatformConfig {
  const env = (process.env.APP_ENV ?? 'development') as AppEnvironment;

  let databaseUrl = '';
  if (env === 'development') {
    databaseUrl = process.env.DATABASE_URL ?? '';
    if (!databaseUrl) {
      console.warn('[PLATFORM CONFIG] DATABASE_URL is not set. Running without platform database.');
    }
  } else {
    databaseUrl = process.env.PLATFORM_DB_POOL_URL ?? '';
    if (!databaseUrl) {
      throw new Error('[PLATFORM CONFIG] PLATFORM_DB_POOL_URL is not set for production/staging.');
    }
  }

  return {
    env,
    port: Number(process.env.PORT ?? 8000),
    logLevel: (process.env.LOG_LEVEL ?? 'info') as PlatformConfig['logLevel'],
    databaseUrl,
    buildVersion: process.env.BUILD_VERSION ?? 'local',
  };
}

export function isProduction(): boolean {
  return process.env.APP_ENV === 'production';
}

export function isDevelopment(): boolean {
  return process.env.APP_ENV !== 'production' && process.env.APP_ENV !== 'staging';
}
