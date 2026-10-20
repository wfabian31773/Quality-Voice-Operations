// @vitest-environment node
// Read actions against a throwaway local Postgres (migrations 001..122), run
// as the NOBYPASSRLS tester role inside a tenant-bound transaction, the way
// runAction's withTenantClient runs them in production.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMemoryStore, runAction, type ActionContext, type TenantTx } from '../../index';

const ADMIN_URL_RAW = process.env.DATABASE_URL ?? process.env.DATABASE_URL_PRIVILEGED ?? 'postgresql://ubuntu@127.0.0.1:5432/postgres';

function adminUrl(database?: string): string | null {
  try {
    const u = new URL(ADMIN_URL_RAW);
    // Throwaway local databases only.
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) return null;
    if (database) u.pathname = `/${database}`;
    return u.toString();
  } catch {
    return null;
  }
}

async function probeReachable(): Promise<boolean> {
  const url = adminUrl();
  if (!url) return false;
  const probe = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
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

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

function migrationsThrough(maxPrefix: string): { name: string; sql: string }[] {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_/.test(f) && f.endsWith('.sql')).sort();
  // Same ordering fix as platform/actions/scheduling/postgres.integration.test.ts.
  const iPins = files.indexOf('063_call_saved_view_pins.sql');
  const iPinOrder = files.indexOf('063_call_saved_views_pin_order.sql');
  if (iPins >= 0 && iPinOrder >= 0 && iPins < iPinOrder) {
    files.splice(iPinOrder, 1);
    files.splice(iPins, 0, '063_call_saved_views_pin_order.sql');
  }
  return files
    .filter((name) => name.slice(0, 3) <= maxPrefix)
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl()! });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/**
 * One transaction per file, like scripts/run-migrations.ts. Other integration
 * files build their own databases in parallel, and role DDL (migration 120)
 * is cluster-wide, so a concurrent-update error is retried.
 */
async function applyMigration(pool: Pool, m: { name: string; sql: string }): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('COMMIT');
      return;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const message = (err as Error).message;
      if (attempt >= 5 || !/tuple concurrently (updated|deleted)|deadlock detected/.test(message)) {
        throw new Error(`Migration ${m.name} failed: ${message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    } finally {
      client.release();
    }
  }
}

const MON_0800 = new Date('2026-10-19T12:00:00Z'); // Mon Oct 19 2026, 8:00 AM EDT

describe.skipIf(!dbReachable)('scheduling read actions on Postgres (RLS-bound loaders)', () => {
  const DB = `qvo_pr08_reads_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let pool: Pool;
  let shopA: string;
  let shopB: string;
  const ids: Record<string, string> = {};

  /** Tenant-bound transaction as the NOBYPASSRLS tester role. */
  async function withTenantTx<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_rls_tester');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn(client as unknown as TenantTx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function insert(table: string, row: Record<string, unknown>): Promise<string> {
    const cols = Object.keys(row);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(row),
    );
    return rows[0]?.id;
  }

  async function seedShop(label: string, staffName: string): Promise<string> {
    const tenantId = randomUUID();
    await pool.query(`INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`, [tenantId, label, `${label}-${tenantId.slice(0, 8)}`]);
    const cut = await insert('scheduling_appointment_types', { tenant_id: tenantId, name: `${label} cut`, duration_minutes: 30, price_kind: 'from', price_cents: 4500 });
    const beard = await insert('scheduling_appointment_types', { tenant_id: tenantId, name: `${label} beard`, duration_minutes: 15, buffer_minutes: 5 });
    await insert('scheduling_appointment_types', { tenant_id: tenantId, name: `${label} retired`, is_active: false });
    const staff = await insert('scheduling_providers', { tenant_id: tenantId, name: staffName });
    const other = await insert('scheduling_providers', { tenant_id: tenantId, name: `${staffName} Jr` });
    for (const [p, t] of [[staff, cut], [staff, beard], [other, cut]]) {
      await pool.query(`INSERT INTO scheduling_provider_services (tenant_id, provider_id, appointment_type_id) VALUES ($1, $2, $3)`, [tenantId, p, t]);
    }
    for (const day of [1, 2, 3, 4, 5, 6]) {
      await pool.query(`INSERT INTO scheduling_business_hours (tenant_id, day_of_week, open_time, close_time) VALUES ($1, $2, '09:00', '17:00')`, [tenantId, day]);
    }
    ids[`${label}:cut`] = cut;
    ids[`${label}:beard`] = beard;
    ids[`${label}:staff`] = staff;
    ids[`${label}:other`] = other;
    return tenantId;
  }

  beforeAll(async () => {
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await adminQuery(`CREATE DATABASE "${DB}"`);
    pool = new Pool({ connectionString: adminUrl(DB)!, max: 4 });
    for (const m of migrationsThrough('122')) await applyMigration(pool, m);
    await applyMigration(pool, {
      name: 'platform_rls_tester role',
      sql: `
        DO $$ BEGIN
          CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester;
        GRANT platform_rls_tester TO CURRENT_USER;
      `,
    });

    shopA = await seedShop('a', 'Marco');
    shopB = await seedShop('b', 'Bea');

    // Shop A, Tue Oct 20: Marco has a confirmed 9:00 with a 15-minute buffer,
    // a live hold at 9:45 and an expired hold at 10:15. Shop B's booking at
    // 10:30 must never leak into shop A's results.
    const marco = ids['a:staff'];
    const booking = (tenantId: string, providerId: string, start: string, end: string, extra: Record<string, unknown> = {}) =>
      insert('bookings', { tenant_id: tenantId, title: 'Cut', start_time: start, end_time: end, provider_id: providerId, ...extra });
    await booking(shopA, marco, '2026-10-20T13:00:00Z', '2026-10-20T13:30:00Z', { blocked_until: '2026-10-20T13:45:00Z' });
    await booking(shopA, marco, '2026-10-20T13:45:00Z', '2026-10-20T14:15:00Z', { status: 'held', hold_expires_at: '2026-10-19T12:04:00Z' });
    await booking(shopA, marco, '2026-10-20T14:15:00Z', '2026-10-20T14:45:00Z', { status: 'held', hold_expires_at: '2026-10-19T11:00:00Z' });
    await booking(shopA, marco, '2026-10-20T14:15:00Z', '2026-10-20T14:45:00Z', { status: 'cancelled' });
    await booking(shopB, ids['b:staff'], '2026-10-20T14:45:00Z', '2026-10-20T15:15:00Z');
    // Holiday for shop B only on Wed Oct 21.
    await insert('scheduling_overrides', { tenant_id: shopB, override_date: '2026-10-21', is_available: false });
  }, 600_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => {});
  }, 60_000);

  function ctx(tenantId: string): ActionContext {
    return { tenantId, actor: { type: 'agent', id: 'agent-1' }, now: MON_0800, tenantTimezone: 'America/New_York' };
  }

  async function read(tenantId: string, name: string, input: unknown) {
    const store = createMemoryStore();
    return runAction(name, ctx(tenantId), input, { store, withTenantTx });
  }

  it('lists only the tenant\'s active services and staff', async () => {
    const services = await read(shopA, 'scheduling.list_services', {});
    expect(services.ok && services.data).toEqual([
      { id: ids['a:beard'], name: 'a beard', durationMin: 15, priceText: null, staffIds: [ids['a:staff']] },
      { id: ids['a:cut'], name: 'a cut', durationMin: 30, priceText: 'from $45', staffIds: expect.arrayContaining([ids['a:staff'], ids['a:other']]) },
    ]);
    const staff = await read(shopA, 'scheduling.list_staff', { serviceId: ids['a:beard'] });
    // No weekly schedule: Marco follows the shop's Mon–Sat 9 to 5.
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    expect(staff.ok && staff.data).toEqual([
      {
        id: ids['a:staff'],
        displayName: 'Marco',
        serviceIds: [ids['a:beard'], ids['a:cut']],
        workingDays: days,
        hours: Object.fromEntries(days.map((d) => [d, '09:00-17:00'])),
      },
    ]);
  });

  it("treats another tenant's ids as unknown (RLS + tenant filter)", async () => {
    const service = await read(shopA, 'scheduling.check_availability', { serviceIds: [ids['b:cut']] });
    expect(service.ok ? null : service.error.code).toBe('NOT_FOUND');
    const staff = await read(shopA, 'scheduling.list_services', { staffId: ids['b:staff'] });
    expect(staff.ok ? null : staff.error.code).toBe('NOT_FOUND');
  });

  it('honors confirmed bookings + buffer and live holds, ignores expired holds and cancelled rows', async () => {
    const result = await read(shopA, 'scheduling.check_availability', {
      serviceIds: [ids['a:cut']],
      staffId: ids['a:staff'],
      date: '2026-10-20',
      partOfDay: 'morning',
      limit: 5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { slots: { start: string; spoken: string }[] };
    // 9:00 booked (blocked to 9:45), 9:45–10:15 held: first free start 10:15.
    expect(data.slots[0]).toMatchObject({ start: '2026-10-20T14:15:00.000Z', spoken: 'tomorrow at 10:15 AM' });
    expect(data.slots.map((s) => s.start)).not.toContain('2026-10-20T13:00:00.000Z');
  });

  it("does not see another tenant's holiday", async () => {
    const a = await read(shopA, 'scheduling.check_availability', { serviceIds: [ids['a:cut']], date: '2026-10-21', limit: 1 });
    expect(a.ok && (a.data as { slots: unknown[] }).slots).toHaveLength(1);
    const b = await read(shopB, 'scheduling.check_availability', { serviceIds: [ids['b:cut']], date: '2026-10-21' });
    expect(b.ok && b.data).toEqual({ slots: [], reasonIfNone: 'closed', nextOpenDate: '2026-10-22' });
  });

  it('never writes: booking rows are unchanged after the reads', async () => {
    const { rows } = await pool.query(`SELECT status, COUNT(*)::int AS n FROM bookings WHERE tenant_id = $1 GROUP BY status ORDER BY status`, [shopA]);
    expect(rows).toEqual([
      { status: 'cancelled', n: 1 },
      { status: 'confirmed', n: 1 },
      { status: 'held', n: 2 },
    ]);
  });
});
