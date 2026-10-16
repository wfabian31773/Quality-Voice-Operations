import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEYS = [
  'APP_ENV',
  'DATABASE_URL',
  'PLATFORM_DB_POOL_URL',
  'DATABASE_URL_PRIVILEGED',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { closePlatformPool, resetPrivilegedFallbackWarningForTests } = await import('./index');
  resetPrivilegedFallbackWarningForTests();
  await closePlatformPool();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('pool URL helpers', () => {
  it('uses DATABASE_URL in development for the restricted pool', async () => {
    process.env.DATABASE_URL = 'postgresql://qvo_app:pw@localhost:5432/qvo';
    const { getRestrictedPoolUrl } = await import('./index');
    expect(getRestrictedPoolUrl()).toBe('postgresql://qvo_app:pw@localhost:5432/qvo');
  });

  it('uses PLATFORM_DB_POOL_URL outside development', async () => {
    process.env.APP_ENV = 'production';
    process.env.PLATFORM_DB_POOL_URL = 'postgresql://qvo_app:pw@db.example.com:6543/postgres';
    const { getRestrictedPoolUrl } = await import('./index');
    expect(getRestrictedPoolUrl()).toBe('postgresql://qvo_app:pw@db.example.com:6543/postgres');
  });

  it('prefers DATABASE_URL_PRIVILEGED for the privileged pool', async () => {
    process.env.DATABASE_URL = 'postgresql://qvo_app:pw@localhost:5432/qvo';
    process.env.DATABASE_URL_PRIVILEGED = 'postgresql://postgres:secret@localhost:5432/qvo';
    const { getPrivilegedPoolUrl } = await import('./index');
    expect(getPrivilegedPoolUrl()).toBe('postgresql://postgres:secret@localhost:5432/qvo');
  });

  it('falls back to the restricted URL with a loud warning', async () => {
    process.env.DATABASE_URL = 'postgresql://postgres:pw@localhost:5432/qvo';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getPrivilegedPoolUrl, resetPrivilegedFallbackWarningForTests } = await import('./index');
    resetPrivilegedFallbackWarningForTests();
    expect(getPrivilegedPoolUrl()).toBe('postgresql://postgres:pw@localhost:5432/qvo');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('DATABASE_URL_PRIVILEGED'))).toBe(true);
  });
});

describe('bindPoolQueriesToTenantScope', () => {
  function fakePool() {
    const clientQuery = vi.fn(async (sql: string, _values?: unknown[]) => (sql.startsWith('SELECT t') ? { rows: [{ id: 'r1' }] } : { rows: [] }));
    const release = vi.fn();
    const poolQuery = vi.fn(async () => ({ rows: [{ unbound: true }] }));
    const pool = { query: poolQuery, connect: vi.fn(async () => ({ query: clientQuery, release })) };
    return { pool, poolQuery, clientQuery, release };
  }

  it('passes through unchanged outside a tenant scope', async () => {
    const { bindPoolQueriesToTenantScope } = await import('./index');
    const f = fakePool();
    const pool = bindPoolQueriesToTenantScope(f.pool as never);
    const result = await pool.query('SELECT t FROM tickets WHERE tenant_id = $1', ['t1']);
    expect(result.rows).toEqual([{ unbound: true }]);
    expect(f.pool.connect).not.toHaveBeenCalled();
  });

  it('binds app.tenant_id with SET LOCAL inside a tenant scope', async () => {
    const { bindPoolQueriesToTenantScope, runWithTenantScope } = await import('./index');
    const f = fakePool();
    const pool = bindPoolQueriesToTenantScope(f.pool as never);
    const result = await runWithTenantScope('tenant-a', () =>
      pool.query('SELECT t FROM tickets WHERE tenant_id = $1', ['tenant-a']),
    );
    expect(result.rows).toEqual([{ id: 'r1' }]);
    expect(f.poolQuery).not.toHaveBeenCalled();
    expect(f.clientQuery.mock.calls.map((c) => c[0])).toEqual([
      'BEGIN',
      `SELECT set_config('app.tenant_id', $1, true)`,
      'SELECT t FROM tickets WHERE tenant_id = $1',
      'COMMIT',
    ]);
    expect(f.clientQuery.mock.calls[1][1]).toEqual(['tenant-a']);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back, releases and rethrows when the bound query fails', async () => {
    const { bindPoolQueriesToTenantScope, runWithTenantScope } = await import('./index');
    const f = fakePool();
    f.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT boom') throw new Error('boom');
      return { rows: [] };
    });
    const pool = bindPoolQueriesToTenantScope(f.pool as never);
    await expect(runWithTenantScope('tenant-a', () => pool.query('SELECT boom'))).rejects.toThrow('boom');
    expect(f.clientQuery.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('leaves callback-style and submittable queries alone', async () => {
    const { bindPoolQueriesToTenantScope, runWithTenantScope } = await import('./index');
    const f = fakePool();
    const pool = bindPoolQueriesToTenantScope(f.pool as never) as unknown as { query: (...a: unknown[]) => unknown };
    const cb = vi.fn();
    const cursor = { submit: vi.fn() };
    await runWithTenantScope('tenant-a', async () => {
      pool.query('SELECT 1', [], cb);
      pool.query(cursor);
    });
    expect(f.poolQuery).toHaveBeenCalledTimes(2);
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
});
