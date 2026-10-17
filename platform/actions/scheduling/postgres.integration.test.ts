// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool, type PoolClient } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TenantTx } from '../core/types';
import { bookingOverlapKind, expireStaleHolds } from './holds';

const ADMIN_URL_RAW = process.env.DATABASE_URL ?? process.env.DATABASE_URL_PRIVILEGED ?? 'postgresql://ubuntu@127.0.0.1:5432/postgres';

interface ParsedConn {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
  search: string;
}

function parseConnection(url: string): ParsedConn | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      user: decodeURIComponent(u.username || 'postgres'),
      password: decodeURIComponent(u.password || ''),
      host: u.hostname || '127.0.0.1',
      port: u.port ? Number(u.port) : 5432,
      database: u.pathname.replace(/^\//, '') || 'postgres',
      search: u.search ?? '',
    };
  } catch {
    return null;
  }
}

function buildUrl(conn: ParsedConn, database: string): string {
  const userPart = encodeURIComponent(conn.user);
  const passPart = conn.password ? `:${encodeURIComponent(conn.password)}` : '';
  return `postgresql://${userPart}${passPart}@${conn.host}:${conn.port}/${database}${conn.search}`;
}

const adminConn = parseConnection(ADMIN_URL_RAW);

async function probeReachable(): Promise<boolean> {
  if (!adminConn) return false;
  const probe = new Client({
    connectionString: buildUrl(adminConn, adminConn.database),
    connectionTimeoutMillis: 2_000,
  });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

const dbReachable = await probeReachable();
const skipReason = !dbReachable ? 'Postgres unreachable — skipping scheduling v2 integration tests' : null;

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const MIGRATION_122 = fs.readFileSync(path.join(MIGRATIONS_DIR, '122_scheduling_v2.sql'), 'utf8');

function loadMigrationsThrough(maxPrefix: string): { name: string; sql: string }[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_/.test(f) && f.endsWith('.sql'))
    .sort();

  const A_PIN_ORDER = '063_call_saved_views_pin_order.sql';
  const A_PINS = '063_call_saved_view_pins.sql';
  const iPins = files.indexOf(A_PINS);
  const iPinOrder = files.indexOf(A_PIN_ORDER);
  if (iPins >= 0 && iPinOrder >= 0 && iPins < iPinOrder) {
    files.splice(iPinOrder, 1);
    files.splice(iPins, 0, A_PIN_ORDER);
  }

  return files
    .filter((name) => name.slice(0, 3) <= maxPrefix)
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
    }));
}

async function applyMigrations(client: Client | Pool, migrations: { name: string; sql: string }[]): Promise<void> {
  for (const m of migrations) {
    try {
      await client.query(m.sql);
    } catch (err) {
      throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
    }
  }
}

async function adminQuery(sql: string): Promise<void> {
  if (!adminConn) throw new Error('no admin conn');
  const admin = new Client({ connectionString: buildUrl(adminConn, adminConn.database) });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

async function createDatabase(name: string, template?: string): Promise<Pool> {
  if (!adminConn) throw new Error('no admin conn');
  await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await adminQuery(template ? `CREATE DATABASE "${name}" TEMPLATE "${template}"` : `CREATE DATABASE "${name}"`);
  return new Pool({ connectionString: buildUrl(adminConn, name), max: 8 });
}

async function dropDatabase(name: string, pool?: Pool): Promise<void> {
  if (pool) await pool.end().catch(() => {});
  if (!adminConn) return;
  await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

/** Apply 122 the way scripts/run-migrations.ts does: one transaction per file. */
async function applyInTransaction(pool: Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function ensureRlsTester(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$ BEGIN
      CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester`);
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_rls_tester`);
  await pool.query(`GRANT platform_rls_tester TO CURRENT_USER`);
}

/** Runs as the NOBYPASSRLS tester role inside a tenant-bound transaction. */
async function withTenantTx<T>(pool: Pool, tenantId: string, fn: (tx: TenantTx, client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE platform_rls_tester');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(client as unknown as TenantTx, client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function insertTenant(pool: Pool, label: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
    [id, label, `${label.toLowerCase()}-${id.slice(0, 8)}`],
  );
  return id;
}

async function insertProvider(pool: Pool, tenantId: string, name = 'Marco'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO scheduling_providers (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, name],
  );
  return rows[0].id;
}

async function insertResource(pool: Pool, tenantId: string, name = 'Chair 1'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO scheduling_resources (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, name],
  );
  return rows[0].id;
}

async function insertAppointmentType(pool: Pool, tenantId: string, name = 'Cut'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO scheduling_appointment_types (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, name],
  );
  return rows[0].id;
}

interface BookingSeed {
  tenantId: string;
  start: string;
  end: string;
  status?: string;
  providerId?: string | null;
  resourceId?: string | null;
  blockedUntil?: string;
  holdExpiresAt?: string;
  idempotencyKey?: string;
}

function insertBooking(db: Pool | PoolClient, b: BookingSeed) {
  const cols = ['tenant_id', 'title', 'start_time', 'end_time', 'status', 'provider_id', 'resource_id'];
  const vals: unknown[] = [b.tenantId, 'Cut', b.start, b.end, b.status ?? 'confirmed', b.providerId ?? null, b.resourceId ?? null];
  if (b.blockedUntil !== undefined) { cols.push('blocked_until'); vals.push(b.blockedUntil); }
  if (b.holdExpiresAt !== undefined) { cols.push('hold_expires_at'); vals.push(b.holdExpiresAt); }
  if (b.idempotencyKey !== undefined) { cols.push('idempotency_key'); vals.push(b.idempotencyKey); }
  const params = vals.map((_, i) => `$${i + 1}`).join(', ');
  return db.query<{ id: string; blocked_until: Date; status: string }>(
    `INSERT INTO bookings (${cols.join(', ')}) VALUES (${params}) RETURNING *`,
    vals,
  );
}

async function pgErrorOf(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; constraint?: string; message: string };
  }
  throw new Error('expected the query to fail');
}

describe.skipIf(skipReason !== null)('scheduling v2 (migration 122) postgres integration', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const BASE_DB = `qvo_s122_base_${suffix}`;
  const MAIN_DB = `qvo_s122_main_${suffix}`;
  const PRECHECK_DB = `qvo_s122_pre_${suffix}`;
  let pool: Pool;
  let precheckPool: Pool;
  let legacy: {
    tenantId: string;
    providerId: string;
    rows: Record<string, unknown>[];
  };

  beforeAll(async () => {
    // Build the current schema (001..121) once and clone it per scenario.
    const base = await createDatabase(BASE_DB);
    try {
      await applyMigrations(base, loadMigrationsThrough('121'));
    } finally {
      await base.end();
    }

    pool = await createDatabase(MAIN_DB, BASE_DB);
    precheckPool = await createDatabase(PRECHECK_DB, BASE_DB);

    // Legacy data on the current schema: overlapping rows that 122 must
    // tolerate (pending/cancelled/completed, other provider, no provider).
    const tenantId = await insertTenant(pool, 'Legacy');
    const providerId = await insertProvider(pool, tenantId);
    const otherProvider = await insertProvider(pool, tenantId, 'Dana');
    const slot = { start: '2026-12-01T15:00:00Z', end: '2026-12-01T15:30:00Z' };
    await insertBooking(pool, { tenantId, ...slot, status: 'confirmed', providerId });
    await insertBooking(pool, { tenantId, ...slot, status: 'pending', providerId });
    await insertBooking(pool, { tenantId, ...slot, status: 'cancelled', providerId });
    await insertBooking(pool, { tenantId, ...slot, status: 'completed', providerId });
    await insertBooking(pool, { tenantId, ...slot, status: 'confirmed', providerId: otherProvider });
    await insertBooking(pool, { tenantId, ...slot, status: 'confirmed', providerId: null });
    await insertBooking(pool, { tenantId, ...slot, status: 'confirmed', providerId: null });
    const { rows } = await pool.query(`SELECT * FROM bookings WHERE tenant_id = $1 ORDER BY id`, [tenantId]);
    legacy = { tenantId, providerId, rows };

    await applyInTransaction(pool, MIGRATION_122);
    await ensureRlsTester(pool);
  }, 600_000);

  afterAll(async () => {
    await dropDatabase(MAIN_DB, pool);
    await dropDatabase(PRECHECK_DB, precheckPool);
    await dropDatabase(BASE_DB);
  }, 60_000);

  describe('applying the migration', () => {
    it('applies on a copy of the current schema without changing existing booking values', async () => {
      const { rows } = await pool.query(`SELECT * FROM bookings WHERE tenant_id = $1 ORDER BY id`, [legacy.tenantId]);
      expect(rows).toHaveLength(legacy.rows.length);
      rows.forEach((row, i) => {
        const before = legacy.rows[i];
        for (const [col, value] of Object.entries(before)) {
          expect(row[col], `bookings.${col}`).toEqual(value);
        }
        expect(row.blocked_until).toEqual(row.end_time);
        expect(row.hold_expires_at).toBeNull();
        expect(row.idempotency_key).toBeNull();
      });
    });

    it('is re-runnable', async () => {
      await applyInTransaction(pool, MIGRATION_122);
      const { rows } = await pool.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'bookings'::regclass
            AND conname IN ('bookings_no_provider_overlap', 'bookings_no_resource_overlap')
          ORDER BY conname`,
      );
      expect(rows.map((r) => r.conname)).toEqual(['bookings_no_provider_overlap', 'bookings_no_resource_overlap']);
    });

    it('applies on a clean Postgres via the full migration chain', async () => {
      const name = `qvo_s122_clean_${suffix}`;
      const clean = await createDatabase(name, BASE_DB);
      try {
        await applyInTransaction(clean, MIGRATION_122);
        const { rows } = await clean.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
            WHERE relname IN ('scheduling_provider_services', 'scheduling_business_hours')
            ORDER BY relname`,
        );
        expect(rows).toEqual([
          { relname: 'scheduling_business_hours', relrowsecurity: true, relforcerowsecurity: true },
          { relname: 'scheduling_provider_services', relrowsecurity: true, relforcerowsecurity: true },
        ]);
      } finally {
        await dropDatabase(name, clean);
      }
    });
  });

  describe('pre-check', () => {
    async function expectAbort(seed: (tenantId: string) => Promise<string[]>, pattern: RegExp): Promise<void> {
      const tenantId = await insertTenant(precheckPool, 'Pre');
      const ids = await seed(tenantId);
      const err = await pgErrorOf(applyInTransaction(precheckPool, MIGRATION_122));
      expect(err.message).toMatch(pattern);
      for (const id of ids) expect(err.message).toContain(id);
      // Nothing from 122 survived the abort.
      const { rows } = await precheckPool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'blocked_until'`,
      );
      expect(rows).toHaveLength(0);
      // Clean up the seed so the next scenario starts from no overlaps.
      await precheckPool.query(`DELETE FROM bookings WHERE tenant_id = $1`, [tenantId]);
    }

    it('aborts on a seeded provider overlap and lists the rows', async () => {
      await expectAbort(async (tenantId) => {
        const providerId = await insertProvider(precheckPool, tenantId);
        const a = await insertBooking(precheckPool, { tenantId, start: '2026-12-02T15:00:00Z', end: '2026-12-02T16:00:00Z', providerId });
        const b = await insertBooking(precheckPool, { tenantId, start: '2026-12-02T15:30:00Z', end: '2026-12-02T16:30:00Z', providerId });
        return [a.rows[0].id, b.rows[0].id, providerId];
      }, /1 overlapping held\/confirmed booking pair/);
    });

    it('aborts on a seeded shared-resource overlap across providers', async () => {
      await expectAbort(async (tenantId) => {
        const resourceId = await insertResource(precheckPool, tenantId);
        const p1 = await insertProvider(precheckPool, tenantId, 'A');
        const p2 = await insertProvider(precheckPool, tenantId, 'B');
        const a = await insertBooking(precheckPool, { tenantId, start: '2026-12-02T15:00:00Z', end: '2026-12-02T16:00:00Z', providerId: p1, resourceId });
        const b = await insertBooking(precheckPool, { tenantId, start: '2026-12-02T15:30:00Z', end: '2026-12-02T16:30:00Z', providerId: p2, resourceId });
        return [a.rows[0].id, b.rows[0].id, resourceId];
      }, /resource/);
    });

    it('aborts on a held/confirmed booking that ends before it starts', async () => {
      await expectAbort(async (tenantId) => {
        const providerId = await insertProvider(precheckPool, tenantId);
        const a = await insertBooking(precheckPool, { tenantId, start: '2026-12-02T16:00:00Z', end: '2026-12-02T15:00:00Z', providerId });
        return [a.rows[0].id];
      }, /end before they start/);
    });

    it('passes when overlaps are only pending/cancelled/completed or back-to-back', async () => {
      const tenantId = await insertTenant(precheckPool, 'PreOk');
      const providerId = await insertProvider(precheckPool, tenantId);
      const slot = { start: '2026-12-03T15:00:00Z', end: '2026-12-03T16:00:00Z' };
      await insertBooking(precheckPool, { tenantId, ...slot, providerId });
      await insertBooking(precheckPool, { tenantId, ...slot, providerId, status: 'pending' });
      await insertBooking(precheckPool, { tenantId, ...slot, providerId, status: 'cancelled' });
      await insertBooking(precheckPool, { tenantId, ...slot, providerId, status: 'completed' });
      await insertBooking(precheckPool, { tenantId, start: slot.end, end: '2026-12-03T17:00:00Z', providerId });
      await expect(applyInTransaction(precheckPool, MIGRATION_122)).resolves.toBeUndefined();
    });
  });

  describe('no-double-booking constraint', () => {
    let tenantId: string;
    let day = 0;
    // Each test gets its own day so rows never collide across tests.
    const at = (hhmm: string) => `2027-01-${String(day).padStart(2, '0')}T${hhmm}:00Z`;

    beforeAll(async () => {
      tenantId = await insertTenant(pool, 'Shop');
    });

    async function nextDay() {
      day += 1;
      return insertProvider(pool, tenantId);
    }

    it('rejects an overlapping held/confirmed booking for the same provider with 23P01', async () => {
      const providerId = await nextDay();
      await insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId });

      const confirmed = await pgErrorOf(insertBooking(pool, { tenantId, start: at('15:15'), end: at('15:45'), providerId }));
      expect(confirmed.code).toBe('23P01');
      expect(bookingOverlapKind(confirmed)).toBe('provider');

      const held = await pgErrorOf(insertBooking(pool, {
        tenantId, start: at('15:00'), end: at('15:30'), providerId, status: 'held', holdExpiresAt: at('23:00'),
      }));
      expect(held.code).toBe('23P01');
    });

    it('allows back-to-back bookings', async () => {
      const providerId = await nextDay();
      await insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId });
      await expect(insertBooking(pool, { tenantId, start: at('15:30'), end: at('16:00'), providerId })).resolves.toBeTruthy();
    });

    it('does not let cancelled or completed rows block', async () => {
      const providerId = await nextDay();
      await insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId, status: 'cancelled' });
      await insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId, status: 'completed' });
      await expect(insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId })).resolves.toBeTruthy();
    });

    it('frees the slot when a confirmed booking is cancelled', async () => {
      const providerId = await nextDay();
      const { rows } = await insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId });
      await pool.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [rows[0].id]);
      await expect(insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId })).resolves.toBeTruthy();
    });

    it('does not let a different provider block', async () => {
      const providerId = await nextDay();
      const other = await insertProvider(pool, tenantId, 'Dana');
      await insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId });
      await expect(insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId: other })).resolves.toBeTruthy();
    });

    it('blocks inside the buffer (blocked_until) and allows after it', async () => {
      const providerId = await nextDay();
      await insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), blockedUntil: at('15:45'), providerId });
      const err = await pgErrorOf(insertBooking(pool, { tenantId, start: at('15:40'), end: at('16:10'), providerId }));
      expect(err.code).toBe('23P01');
      await expect(insertBooking(pool, { tenantId, start: at('15:45'), end: at('16:15'), providerId })).resolves.toBeTruthy();
    });

    it('stops blocking with an expired hold once expireStaleHolds runs (RLS-bound tx)', async () => {
      const providerId = await nextDay();
      const live = await insertProvider(pool, tenantId, 'Live');
      const { rows: stale } = await insertBooking(pool, {
        tenantId, start: at('15:00'), end: at('15:30'), providerId, status: 'held', holdExpiresAt: '2020-01-01T00:00:00Z',
      });
      const { rows: fresh } = await insertBooking(pool, {
        tenantId, start: at('15:00'), end: at('15:30'), providerId: live, status: 'held', holdExpiresAt: '2099-01-01T00:00:00Z',
      });

      // Expired but not yet swept: still blocks.
      const err = await pgErrorOf(insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId }));
      expect(err.code).toBe('23P01');

      const result = await withTenantTx(pool, tenantId, async (tx, client) => {
        const expired = await expireStaleHolds(tx, tenantId, providerId);
        await insertBooking(client, { tenantId, start: at('15:00'), end: at('15:30'), providerId });
        return expired;
      });
      expect(result.expiredBookingIds).toEqual([stale[0].id]);

      // A live hold for another provider is untouched and still blocks.
      const untouched = await withTenantTx(pool, tenantId, (tx) => expireStaleHolds(tx, tenantId, live));
      expect(untouched.expiredBookingIds).toEqual([]);
      const { rows } = await pool.query(
        `SELECT id, status, cancellation_reason FROM bookings WHERE id = ANY($1) ORDER BY id`,
        [[stale[0].id, fresh[0].id]],
      );
      expect(rows.find((r) => r.id === stale[0].id)).toMatchObject({ status: 'cancelled', cancellation_reason: 'hold_expired' });
      expect(rows.find((r) => r.id === fresh[0].id)).toMatchObject({ status: 'held' });
    });

    it('uses the injected clock and leaves other tenants alone', async () => {
      const providerId = await nextDay();
      const otherTenant = await insertTenant(pool, 'Other');
      const otherProvider = await insertProvider(pool, otherTenant);
      const { rows: mine } = await insertBooking(pool, {
        tenantId, start: at('15:00'), end: at('15:30'), providerId, status: 'held', holdExpiresAt: at('10:00'),
      });
      await insertBooking(pool, {
        tenantId: otherTenant, start: at('15:00'), end: at('15:30'), providerId: otherProvider, status: 'held', holdExpiresAt: at('10:00'),
      });

      const before = await withTenantTx(pool, tenantId, (tx) => expireStaleHolds(tx, tenantId, providerId, { now: new Date(at('09:59')) }));
      expect(before.expiredBookingIds).toEqual([]);
      // Even a forged tenant/provider pair can't reach the other tenant's row through RLS.
      const forged = await withTenantTx(pool, tenantId, (tx) => expireStaleHolds(tx, otherTenant, otherProvider, { now: new Date(at('11:00')) }));
      expect(forged.expiredBookingIds).toEqual([]);
      const after = await withTenantTx(pool, tenantId, (tx) => expireStaleHolds(tx, tenantId, providerId, { now: new Date(at('10:00')) }));
      expect(after.expiredBookingIds).toEqual([mine[0].id]);
      const { rows } = await pool.query(`SELECT status FROM bookings WHERE tenant_id = $1 AND status = 'held'`, [otherTenant]);
      expect(rows).toHaveLength(1);
    });

    it('rejects an overlapping booking on the same shared resource across providers', async () => {
      const providerId = await nextDay();
      const other = await insertProvider(pool, tenantId, 'Dana');
      const resourceId = await insertResource(pool, tenantId);
      await insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId, resourceId });
      const err = await pgErrorOf(insertBooking(pool, { tenantId, start: at('15:15'), end: at('15:45'), providerId: other, resourceId }));
      expect(err.code).toBe('23P01');
      expect(bookingOverlapKind(err)).toBe('resource');
      // Resource-only bookings (no provider) are covered too.
      const noProvider = await pgErrorOf(insertBooking(pool, { tenantId, start: at('15:10'), end: at('15:20'), providerId: null, resourceId }));
      expect(bookingOverlapKind(noProvider)).toBe('resource');
      // Expired holds on the resource are released by expireStaleHolds({ resourceId }).
      await insertBooking(pool, {
        tenantId, start: at('17:00'), end: at('17:30'), providerId: other, resourceId, status: 'held', holdExpiresAt: '2020-01-01T00:00:00Z',
      });
      const released = await withTenantTx(pool, tenantId, (tx) => expireStaleHolds(tx, tenantId, providerId, { resourceId }));
      expect(released.expiredBookingIds).toHaveLength(1);
      await expect(insertBooking(pool, { tenantId, start: at('17:00'), end: at('17:30'), providerId, resourceId })).resolves.toBeTruthy();
    });

    it('lets exactly one of two concurrent inserts for the same slot win', async () => {
      const providerId = await nextDay();
      const attempt = async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await insertBooking(client, { tenantId, start: at('15:00'), end: at('15:30'), providerId });
          await new Promise((resolve) => setTimeout(resolve, 50));
          await client.query('COMMIT');
          return 'ok';
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          return (err as { code?: string }).code;
        } finally {
          client.release();
        }
      };
      const results = await Promise.all([attempt(), attempt()]);
      expect(results.sort()).toEqual(['23P01', 'ok']);
    });

    it('requires hold_expires_at on held rows and accepts the held status', async () => {
      const providerId = await nextDay();
      const err = await pgErrorOf(insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), providerId, status: 'held' }));
      expect(err.code).toBe('23514');
      const { rows } = await insertBooking(pool, {
        tenantId, start: at('15:00'), end: at('15:30'), providerId, status: 'held', holdExpiresAt: at('14:05'),
      });
      expect(rows[0].status).toBe('held');
    });

    it('defaults blocked_until to end_time and keeps the buffer when end_time moves', async () => {
      const providerId = await nextDay();
      const { rows: plain } = await insertBooking(pool, { tenantId, start: at('09:00'), end: at('09:30'), providerId });
      expect(plain[0].blocked_until.toISOString()).toBe(new Date(at('09:30')).toISOString());

      const { rows } = await insertBooking(pool, { tenantId, start: at('15:00'), end: at('15:30'), blockedUntil: at('15:45'), providerId });
      const moved = await pool.query<{ blocked_until: Date }>(
        `UPDATE bookings SET start_time = $2, end_time = $3 WHERE id = $1 RETURNING blocked_until`,
        [rows[0].id, at('16:00'), at('16:30')],
      );
      expect(moved.rows[0].blocked_until.toISOString()).toBe(new Date(at('16:45')).toISOString());

      const err = await pgErrorOf(pool.query(`UPDATE bookings SET blocked_until = $2 WHERE id = $1`, [rows[0].id, at('16:00')]));
      expect(err.code).toBe('23514');
    });

    it('enforces idempotency_key uniqueness per tenant only', async () => {
      const providerId = await nextDay();
      const otherTenant = await insertTenant(pool, 'Idem');
      await insertBooking(pool, { tenantId, start: at('09:00'), end: at('09:30'), providerId, idempotencyKey: 'tok-1' });
      const dup = await pgErrorOf(insertBooking(pool, { tenantId, start: at('10:00'), end: at('10:30'), providerId, idempotencyKey: 'tok-1' }));
      expect(dup.code).toBe('23505');
      await expect(insertBooking(pool, { tenantId: otherTenant, start: at('09:00'), end: at('09:30'), idempotencyKey: 'tok-1' })).resolves.toBeTruthy();
    });
  });

  describe('catalog tables', () => {
    it('validates price_kind and price amounts', async () => {
      const tenantId = await insertTenant(pool, 'Price');
      const typeId = await insertAppointmentType(pool, tenantId);
      const { rows } = await pool.query(`SELECT price_kind, price_cents FROM scheduling_appointment_types WHERE id = $1`, [typeId]);
      expect(rows[0]).toEqual({ price_kind: 'hidden', price_cents: null });

      const set = (kind: string, cents: number | null, max: number | null) =>
        pool.query(`UPDATE scheduling_appointment_types SET price_kind = $2, price_cents = $3, price_max_cents = $4 WHERE id = $1`, [typeId, kind, cents, max]);
      await expect(set('fixed', 4500, null)).resolves.toBeTruthy();
      await expect(set('from', 4500, null)).resolves.toBeTruthy();
      await expect(set('range', 4500, 6000)).resolves.toBeTruthy();
      expect((await pgErrorOf(set('free', null, null))).code).toBe('23514');
      expect((await pgErrorOf(set('fixed', null, null))).code).toBe('23514');
      expect((await pgErrorOf(set('range', 6000, 4500))).code).toBe('23514');
      expect((await pgErrorOf(set('fixed', -1, null))).code).toBe('23514');
    });

    it('rejects a provider_services link to another tenant\'s provider or service', async () => {
      const tenantA = await insertTenant(pool, 'LinkA');
      const tenantB = await insertTenant(pool, 'LinkB');
      const providerA = await insertProvider(pool, tenantA);
      const typeA = await insertAppointmentType(pool, tenantA);
      const providerB = await insertProvider(pool, tenantB);
      const typeB = await insertAppointmentType(pool, tenantB);
      await expect(pool.query(
        `INSERT INTO scheduling_provider_services (tenant_id, provider_id, appointment_type_id) VALUES ($1, $2, $3)`,
        [tenantA, providerA, typeA],
      )).resolves.toBeTruthy();
      for (const [provider, type] of [[providerB, typeA], [providerA, typeB]]) {
        const err = await pgErrorOf(pool.query(
          `INSERT INTO scheduling_provider_services (tenant_id, provider_id, appointment_type_id) VALUES ($1, $2, $3)`,
          [tenantA, provider, type],
        ));
        expect(err.code).toBe('23503');
      }
    });

    it('rejects business hours that close before they open', async () => {
      const tenantId = await insertTenant(pool, 'Hours');
      const err = await pgErrorOf(pool.query(
        `INSERT INTO scheduling_business_hours (tenant_id, day_of_week, open_time, close_time) VALUES ($1, 1, '17:00', '09:00')`,
        [tenantId],
      ));
      expect(err.code).toBe('23514');
    });
  });

  describe('RLS on the new tables', () => {
    async function seedTwoTenants() {
      const tenantA = await insertTenant(pool, 'RlsA');
      const tenantB = await insertTenant(pool, 'RlsB');
      const seed = async (tenantId: string) => {
        const providerId = await insertProvider(pool, tenantId);
        const typeId = await insertAppointmentType(pool, tenantId);
        await pool.query(
          `INSERT INTO scheduling_provider_services (tenant_id, provider_id, appointment_type_id) VALUES ($1, $2, $3)`,
          [tenantId, providerId, typeId],
        );
        await pool.query(
          `INSERT INTO scheduling_business_hours (tenant_id, day_of_week, open_time, close_time) VALUES ($1, 2, '09:00', '17:00')`,
          [tenantId],
        );
        return { providerId, typeId };
      };
      return { tenantA, tenantB, a: await seed(tenantA), b: await seed(tenantB) };
    }

    it('confirms the tester role cannot bypass RLS', async () => {
      const { rows } = await pool.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'platform_rls_tester'`);
      expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    });

    for (const table of ['scheduling_provider_services', 'scheduling_business_hours'] as const) {
      it(`denies cross-tenant reads and writes on ${table}`, async () => {
        const { tenantA, tenantB, b } = await seedTwoTenants();

        await withTenantTx(pool, tenantA, async (tx) => {
          const { rows } = await tx.query(`SELECT tenant_id FROM ${table}`);
          expect(rows.length).toBeGreaterThan(0);
          expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);

          const updated = await tx.query(`UPDATE ${table} SET created_at = created_at WHERE tenant_id = $1`, [tenantB]);
          expect(updated.rowCount).toBe(0);
          const deleted = await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantB]);
          expect(deleted.rowCount).toBe(0);
        });

        const insert = table === 'scheduling_provider_services'
          ? (tx: TenantTx) => tx.query(
            `INSERT INTO scheduling_provider_services (tenant_id, provider_id, appointment_type_id) VALUES ($1, $2, $3)`,
            [tenantB, b.providerId, b.typeId],
          )
          : (tx: TenantTx) => tx.query(
            `INSERT INTO scheduling_business_hours (tenant_id, day_of_week, open_time, close_time) VALUES ($1, 3, '09:00', '17:00')`,
            [tenantB],
          );
        const err = await pgErrorOf(withTenantTx(pool, tenantA, insert));
        expect(err.code).toBe('42501');

        const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [tenantB]);
        expect(rows).toHaveLength(1);
      });

      it(`returns no rows from ${table} without a tenant setting`, async () => {
        await seedTwoTenants();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE platform_rls_tester');
          const { rows } = await client.query(`SELECT 1 FROM ${table}`);
          expect(rows).toHaveLength(0);
        } finally {
          await client.query('ROLLBACK').catch(() => {});
          client.release();
        }
      });
    }
  });
});
