// @vitest-environment node
// Admin booking writers against real Postgres with migration 122's
// no-double-booking constraints: overlaps are a 409, and a failed
// reschedule leaves the original booking untouched.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Client, Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const h = vi.hoisted(() => ({
  pool: null as unknown,
  user: { userId: '', tenantId: '', email: 'admin@example.com', role: 'operations_manager', isPlatformAdmin: false },
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = h.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => h.pool,
  withTenantContext: async (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }, tenantId: string, fn: () => Promise<unknown>) => {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return fn();
  },
}));
vi.mock('../../../platform/notifications/dispatchPush', () => ({ fireDispatchPush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../platform/integrations/connectors', () => ({
  connectorService: { dispatchEvent: vi.fn().mockResolvedValue({ dispatched: 0, results: [] }), emit: vi.fn().mockResolvedValue(undefined) },
}));

import router from './scheduling';

const ADMIN_URL_RAW = process.env.DATABASE_URL ?? process.env.DATABASE_URL_PRIVILEGED ?? 'postgresql://ubuntu@127.0.0.1:5432/postgres';

function urlFor(database: string): string | null {
  try {
    const u = new URL(ADMIN_URL_RAW);
    u.pathname = `/${database}`;
    return u.toString();
  } catch {
    return null;
  }
}

const adminUrl = (() => {
  try {
    return new URL(ADMIN_URL_RAW).toString();
  } catch {
    return null;
  }
})();

async function adminQuery(sql: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl!, connectionTimeoutMillis: 2_000 });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

async function probeReachable(): Promise<boolean> {
  if (!adminUrl) return false;
  try {
    await adminQuery('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

const dbReachable = await probeReachable();

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

function migrationsThrough(maxPrefix: string): { name: string; sql: string }[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_/.test(f) && f.endsWith('.sql'))
    .sort();
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

function app() {
  const a = express();
  a.use(express.json());
  a.use(router);
  return a;
}

describe.skipIf(!dbReachable)('admin booking routes vs 122 no-double-booking constraints (postgres)', () => {
  const DB = `qvo_s122_routes_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let pool: Pool;
  let tenantId: string;
  let providerId: string;
  let day = 0;
  // Each test gets its own day so rows never collide across tests.
  const at = (hhmm: string) => `2027-02-${String(day).padStart(2, '0')}T${hhmm}:00.000Z`;

  async function insertBooking(start: string, end: string, status = 'confirmed'): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO bookings (tenant_id, title, start_time, end_time, status, provider_id)
       VALUES ($1, 'Cut', $2, $3, $4, $5) RETURNING id`,
      [tenantId, start, end, status, providerId],
    );
    return rows[0].id;
  }

  async function bookingsOnDay(): Promise<Array<{ id: string; status: string; start_time: Date }>> {
    const { rows } = await pool.query(
      `SELECT id, status, start_time FROM bookings
        WHERE tenant_id = $1 AND start_time >= $2 AND start_time < $3::timestamptz + INTERVAL '1 day'
        ORDER BY start_time, id`,
      [tenantId, at('00:00'), at('00:00')],
    );
    return rows;
  }

  beforeAll(async () => {
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await adminQuery(`CREATE DATABASE "${DB}"`);
    pool = new Pool({ connectionString: urlFor(DB)!, max: 8 });
    for (const m of migrationsThrough('122')) {
      try {
        await pool.query(m.sql);
      } catch (err) {
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
    }
    h.pool = pool;

    tenantId = randomUUID();
    await pool.query(`INSERT INTO tenants (id, name, slug, status) VALUES ($1, 'Shop', $2, 'active')`, [tenantId, `shop-${tenantId.slice(0, 8)}`]);
    const userId = randomUUID();
    await pool.query(`INSERT INTO users (id, tenant_id, email) VALUES ($1, $2, 'admin@example.com')`, [userId, tenantId]);
    h.user.userId = userId;
    h.user.tenantId = tenantId;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_providers (tenant_id, name) VALUES ($1, 'Marco') RETURNING id`,
      [tenantId],
    );
    providerId = rows[0].id;
  }, 600_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    if (adminUrl) await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  }, 60_000);

  it('override reschedule into a taken slot returns 409 and leaves the original booking confirmed', async () => {
    day += 1;
    const original = await insertBooking(at('15:00'), at('15:30'));
    const taken = await insertBooking(at('16:00'), at('16:30'));

    const res = await request(app()).post(`/scheduling/bookings/${original}/transition`).send({
      action: 'reschedule',
      new_start_time: at('16:00'),
      new_end_time: at('16:30'),
      override_reason: 'manager override',
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'That time slot is no longer available', reason: 'slot_unavailable' });
    const rows = await bookingsOnDay();
    expect(rows.map((r) => [r.id, r.status])).toEqual([[original, 'confirmed'], [taken, 'confirmed']]);
    const { rows: audit } = await pool.query(`SELECT 1 FROM scheduling_audit_log WHERE booking_id = $1`, [original]);
    expect(audit).toHaveLength(0);
  });

  it('reschedule into a free slot still commits both rows', async () => {
    day += 1;
    const original = await insertBooking(at('15:00'), at('15:30'));

    const res = await request(app()).post(`/scheduling/bookings/${original}/transition`).send({
      action: 'reschedule',
      new_start_time: at('17:00'),
      new_end_time: at('17:30'),
    });

    expect(res.status).toBe(200);
    expect(res.body.previous_booking_id).toBe(original);
    const rows = await bookingsOnDay();
    expect(rows.map((r) => [r.id, r.status])).toEqual([[original, 'rescheduled'], [res.body.booking.id, 'confirmed']]);
  });

  it('confirming a pending booking into a taken slot returns 409 and leaves it pending', async () => {
    day += 1;
    await insertBooking(at('15:00'), at('15:30'));
    const pending = await insertBooking(at('15:00'), at('15:30'), 'pending');

    const res = await request(app()).post(`/scheduling/bookings/${pending}/transition`).send({ action: 'confirm' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('slot_unavailable');
    const { rows } = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [pending]);
    expect(rows[0].status).toBe('pending');
  });

  it('create with allow_double_book = true into a taken slot returns 409', async () => {
    day += 1;
    await insertBooking(at('15:00'), at('15:30'));
    await pool.query(`DELETE FROM scheduling_booking_rules WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`INSERT INTO scheduling_booking_rules (tenant_id, allow_double_book) VALUES ($1, true)`, [tenantId]);

    try {
      const res = await request(app()).post('/scheduling/bookings').send({
        title: 'Double', start_time: at('15:15'), end_time: at('15:45'), provider_id: providerId,
      });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'That time slot is no longer available', reason: 'slot_unavailable' });
      expect(await bookingsOnDay()).toHaveLength(1);
    } finally {
      await pool.query(`DELETE FROM scheduling_booking_rules WHERE tenant_id = $1`, [tenantId]);
    }
  });

  it('update that makes a pending booking confirmed in a taken slot returns 409', async () => {
    day += 1;
    await insertBooking(at('15:00'), at('15:30'));
    const pending = await insertBooking(at('15:00'), at('15:30'), 'pending');

    const res = await request(app()).put(`/scheduling/bookings/${pending}`).send({ status: 'confirmed' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('slot_unavailable');
    const { rows } = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [pending]);
    expect(rows[0].status).toBe('pending');
  });
});
