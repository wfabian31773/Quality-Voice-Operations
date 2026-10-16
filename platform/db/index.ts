import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { getScopedTenantId, isPrivilegedScope, runWithRestrictedScope } from './tenantScope';

export {
  runWithTenantScope,
  runWithPrivilegedScope,
  runWithRestrictedScope,
  getScopedTenantId,
  isPrivilegedScope,
} from './tenantScope';

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

type AnyQuery = (...args: unknown[]) => Promise<unknown>;

const SET_TENANT_SQL = `SELECT set_config('app.tenant_id', $1, true)`;
const TX_BEGIN = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const TX_END = /^\s*(COMMIT|END|ABORT)\b|^\s*ROLLBACK\b(?!\s+TO\b)/i;

/** Callback-style and submittable (cursor / stream) queries are never rewritten. */
function isPassThroughQuery(args: unknown[]): boolean {
  const [first] = args;
  const isSubmittable =
    typeof first === 'object' && first !== null && typeof (first as { submit?: unknown }).submit === 'function';
  return isSubmittable || args.some((a) => typeof a === 'function');
}

function sqlText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null && typeof (arg as { text?: unknown }).text === 'string') {
    return (arg as { text: string }).text;
  }
  return '';
}

/**
 * Bind a checked-out client to `tenantId` until it is released: right
 * after BEGIN it runs SET LOCAL app.tenant_id, and a statement outside a
 * transaction runs in its own BEGIN / SET LOCAL / COMMIT. Callers that
 * also call withTenantContext just set the same value again.
 */
function bindClientToTenant(client: PoolClient, tenantId: string): PoolClient {
  const hadOwnQuery = Object.prototype.hasOwnProperty.call(client, 'query');
  const ownQuery = client.query;
  const raw = client.query.bind(client) as AnyQuery;
  const release = client.release;
  let inTransaction = false;

  const query: AnyQuery = (...args) => {
    if (isPassThroughQuery(args)) return raw(...args);
    const text = sqlText(args[0]);
    if (TX_BEGIN.test(text)) {
      return (async () => {
        const result = await raw(...args);
        inTransaction = true;
        await raw(SET_TENANT_SQL, [tenantId]);
        return result;
      })();
    }
    if (TX_END.test(text)) {
      inTransaction = false;
      return raw(...args);
    }
    if (inTransaction) return raw(...args);
    return (async () => {
      await raw('BEGIN');
      try {
        await raw(SET_TENANT_SQL, [tenantId]);
        const result = await raw(...args);
        await raw('COMMIT');
        return result;
      } catch (err) {
        await raw('ROLLBACK').catch(() => {});
        throw err;
      }
    })();
  };

  client.query = query as PoolClient['query'];
  client.release = ((err?: Error | boolean) => {
    if (hadOwnQuery) client.query = ownQuery;
    else delete (client as { query?: unknown }).query;
    client.release = release;
    return release(err);
  }) as PoolClient['release'];
  return client;
}

/**
 * Route restricted-pool work by scope (`./tenantScope`):
 *   - tenant scope (authenticated tenant request): `query()` and checked-out
 *     clients are bound to app.tenant_id, so RLS is enforced once the pool
 *     connects as qvo_app (NOBYPASSRLS).
 *   - restricted scope: the plain restricted pool (isolation suite).
 *   - privileged scope or no scope (webhooks, public routes, voice gateway,
 *     platform admins, schedulers): `query()` / `connect()` go to the
 *     privileged pool, which is how they ran before the role switch.
 * Callback-style and submittable queries are never rewritten, and nothing
 * is rerouted when the privileged pool is this pool (no
 * DATABASE_URL_PRIVILEGED).
 */
export function bindPoolQueriesToTenantScope(pool: Pool, privilegedPool: () => Pool = () => pool): Pool {
  const unboundQuery = pool.query.bind(pool) as AnyQuery;
  const unboundConnect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  const privilegedTarget = (): Pool | null => {
    if (!isPrivilegedScope()) return null;
    const target = privilegedPool();
    return target === pool ? null : target;
  };

  const connectBound = async (tenantId: string): Promise<PoolClient> =>
    bindClientToTenant((await unboundConnect()) as PoolClient, tenantId);

  const query: AnyQuery = (...args) => {
    const target = privilegedTarget();
    if (target) return (target.query as unknown as AnyQuery)(...args);
    const tenantId = getScopedTenantId();
    if (!tenantId || isPassThroughQuery(args)) return unboundQuery(...args);
    return (async () => {
      const client = await connectBound(tenantId);
      try {
        return await (client.query as unknown as AnyQuery)(...args);
      } finally {
        client.release();
      }
    })();
  };

  const connect = (...args: unknown[]): unknown => {
    if (args.length > 0) return unboundConnect(...args);
    const target = privilegedTarget();
    if (target) return target.connect();
    const tenantId = getScopedTenantId();
    return tenantId ? connectBound(tenantId) : unboundConnect();
  };

  Object.assign(pool, { query, connect });
  return pool;
}

/**
 * Restricted (qvo_app) pool. Inside `runWithTenantScope` its queries and
 * checked-out clients are bound to that tenant; outside a tenant or
 * restricted scope they are sent to the privileged pool (see
 * bindPoolQueriesToTenantScope).
 */
export function getPlatformPool(): Pool {
  if (!_pool) {
    _pool = bindPoolQueriesToTenantScope(new Pool(getPoolConfig(getRestrictedPoolUrl())), getPrivilegedPool);
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

/**
 * Health / readiness probe. Runs `sql` on the restricted (qvo_app) pool
 * itself, not the privileged pool that unscoped calls are routed to, and
 * `SELECT 1` on the privileged pool, so a broken URL for either fails the
 * probe. Returns the restricted-pool result.
 */
export async function pingDatabasePools(sql = 'SELECT 1'): Promise<{ rows: Record<string, unknown>[] }> {
  const pool = getPlatformPool();
  const result = await runWithRestrictedScope(() => pool.query(sql));
  const privileged = getPrivilegedPool();
  if (privileged !== pool) await privileged.query('SELECT 1');
  return result;
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
  await client.query(SET_TENANT_SQL, [tenantId]);
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
