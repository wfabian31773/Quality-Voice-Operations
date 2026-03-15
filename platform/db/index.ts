import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

let _pool: Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

function getPoolUrl(): string {
  const env = process.env.APP_ENV ?? 'development';

  if (env === 'development') {
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

function getPoolConfig(): ConstructorParameters<typeof Pool>[0] {
  const env = process.env.APP_ENV ?? 'development';
  const connectionString = getPoolUrl();

  if (env === 'development') {
    return {
      connectionString,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    };
  }

  return {
    connectionString,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: { rejectUnauthorized: false },
  };
}

export function getPlatformPool(): Pool {
  if (!_pool) {
    _pool = new Pool(getPoolConfig());

    _pool.on('error', (err) => {
      console.error('[PLATFORM DB] Pool error:', err.message);
    });
  }
  return _pool;
}

export function getPlatformDb(): ReturnType<typeof drizzle> {
  if (!_db) {
    _db = drizzle(getPlatformPool(), { logger: process.env.APP_ENV === 'development' });
  }
  return _db;
}

export async function withTenantContext<T>(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  return fn();
}

export async function withPrivilegedClient<T>(
  fn: (client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> }) => Promise<T>,
): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
    console.log('[PLATFORM DB] Connection pool closed.');
  }
}
