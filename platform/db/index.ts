import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

let _pool: Pool | null = null;
let _privilegedPool: Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;
let _privilegedFallbackWarned = false;

function isDevelopmentEnv(): boolean {
  return (process.env.APP_ENV ?? 'development') === 'development';
}

/**
 * Restricted application pool URL.
 * After rollout this is `qvo_app` (NOBYPASSRLS) via DATABASE_URL (dev)
 * or PLATFORM_DB_POOL_URL (prod/staging).
 */
export function getRestrictedPoolUrl(): string {
  if (isDevelopmentEnv()) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        '[PLATFORM DB] DATABASE_URL is not set. ' +
        'The Replit PostgreSQL database must be available for local development.',
      );
    }
    return url;
  }

  const url = process.env.PLATFORM_DB_POOL_URL;
  if (!url) {
    throw new Error(
      '[PLATFORM DB] PLATFORM_DB_POOL_URL is not set. ' +
      'Configure the Supabase transaction pooler URL (port 6543) for production/staging.',
    );
  }
  return url;
}

/**
 * Privileged (BYPASSRLS / postgres) pool URL.
 * Falls back to the restricted URL with a one-shot loud warning so local
 * and pre-rollout environments keep working.
 */
export function getPrivilegedPoolUrl(): string {
  const privileged = process.env.DATABASE_URL_PRIVILEGED;
  if (privileged) return privileged;

  if (!_privilegedFallbackWarned) {
    _privilegedFallbackWarned = true;
    console.warn(
      '[PLATFORM DB] DATABASE_URL_PRIVILEGED is not set — falling back to the default pool URL. ' +
      'If that role has rolbypassrls (e.g. postgres), RLS is NOT enforced for application queries. ' +
      'If that role is qvo_app (NOBYPASSRLS), privileged jobs, migrations, and webhooks will fail. ' +
      'Set DATABASE_URL_PRIVILEGED to the current postgres URL, then point DATABASE_URL / PLATFORM_DB_POOL_URL at qvo_app.',
    );
  }

  return getRestrictedPoolUrl();
}

function getPoolConfig(connectionString: string): ConstructorParameters<typeof Pool>[0] {
  const config: ConstructorParameters<typeof Pool>[0] = {
    connectionString,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };

  if (!isDevelopmentEnv()) {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

function attachPoolErrorHandler(pool: Pool, label: string): void {
  pool.on('error', (err) => {
    console.error(`[PLATFORM DB] ${label} pool error:`, err.message);
  });
}

/** Restricted pool. Tenant-scoped request handlers must SET LOCAL app.tenant_id. */
export function getPlatformPool(): Pool {
  if (!_pool) {
    _pool = new Pool(getPoolConfig(getRestrictedPoolUrl()));
    attachPoolErrorHandler(_pool, 'restricted');
  }
  return _pool;
}

/**
 * Privileged pool for migrations, workers, platform-admin, seeds, and
 * webhooks that resolve a tenant from inbound data.
 */
export function getPrivilegedPool(): Pool {
  if (_privilegedPool) return _privilegedPool;

  const privilegedUrl = getPrivilegedPoolUrl();
  let restrictedUrl = '';
  try {
    restrictedUrl = getRestrictedPoolUrl();
  } catch {
    restrictedUrl = '';
  }

  if (restrictedUrl && privilegedUrl === restrictedUrl) {
    _privilegedPool = getPlatformPool();
    return _privilegedPool;
  }

  _privilegedPool = new Pool(getPoolConfig(privilegedUrl));
  attachPoolErrorHandler(_privilegedPool, 'privileged');
  return _privilegedPool;
}

export function getPlatformDb(): ReturnType<typeof drizzle> {
  if (!_db) {
    _db = drizzle(getPlatformPool(), { logger: process.env.APP_ENV === 'development' });
  }
  return _db;
}

/**
 * Bind the current transaction to a tenant. The third argument to
 * set_config is `true` (equivalent to SET LOCAL) so the setting lasts
 * only for the open transaction. Callers MUST already be inside BEGIN.
 */
export async function withTenantContext<T>(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  return fn();
}

type QueryClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

/**
 * Open a restricted-pool transaction, SET LOCAL app.tenant_id, run `fn`,
 * then commit. Tenant-scoped request handlers should use this (or
 * withTenantContext on an already-open transaction) before querying
 * RLS-protected tables.
 */
export async function withTenantClient<T>(
  tenantId: string,
  fn: (client: QueryClient) => Promise<T>,
): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const result = await fn(client as unknown as QueryClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function withPrivilegedClient<T>(
  fn: (client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> }) => Promise<T>,
): Promise<T> {
  const pool = getPrivilegedPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Belt-and-suspenders for table owners without BYPASSRLS. Superusers
    // and rolbypassrls roles ignore RLS regardless.
    await client.query('SET LOCAL row_security = off');
    const result = await fn(client as unknown as Parameters<typeof fn>[0]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePlatformPool(): Promise<void> {
  const privilegedAliased = _privilegedPool !== null && _privilegedPool === _pool;

  if (_privilegedPool && !privilegedAliased) {
    await _privilegedPool.end();
  }
  _privilegedPool = null;

  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
    console.log('[PLATFORM DB] Connection pool closed.');
  }
}

/** Test-only: clear the one-shot fallback warning so URL helper tests stay isolated. */
export function resetPrivilegedFallbackWarningForTests(): void {
  _privilegedFallbackWarned = false;
}
