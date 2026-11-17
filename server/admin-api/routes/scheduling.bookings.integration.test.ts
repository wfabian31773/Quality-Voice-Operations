// @vitest-environment node
// Owner/staff booking writers against real Postgres: phone-call holds, UI
// idempotency, concurrent transitions, and cross-tenant 404s.
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

/** Role DDL (015) is cluster-wide, so a parallel suite can collide; retry. */
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
      if (/pg_authid_rolname_index|duplicate_object|already exists/.test(message)) {
        return;
      }
      if (attempt >= 5 || !/tuple concurrently (updated|deleted)|deadlock detected/.test(message)) {
        throw new Error(`Migration ${m.name} failed: ${message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    } finally {
      client.release();
    }
  }
}

describe.skipIf(!dbReachable)('admin booking writes: holds, idempotency, races, isolation (postgres)', () => {
  const DB = `qvo_sbook_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let pool: Pool;
  let tenantId: string;
  let otherTenantId: string;
  let userId: string;
  let providerId: string;
  let otherProviderId: string;
  let day = 0;
  const at = (hhmm: string) => `2027-02-${String(day).padStart(2, '0')}T${hhmm}:00.000Z`;

  async function insertBooking(
    start: string,
    end: string,
    extras: Record<string, unknown> = {},
    tenant = tenantId,
    provider = providerId,
  ): Promise<string> {
    const row: Record<string, unknown> = {
      tenant_id: tenant,
      title: 'Cut',
      start_time: start,
      end_time: end,
      status: 'confirmed',
      provider_id: provider,
      ...extras,
    };
    const names = Object.keys(row);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO bookings (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      names.map((k) => row[k]),
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await adminQuery(`CREATE DATABASE "${DB}"`);
    pool = new Pool({ connectionString: urlFor(DB)!, max: 8 });
    for (const m of migrationsThrough('122')) {
      await applyMigration(pool, m);
    }
    h.pool = pool;

    tenantId = randomUUID();
    otherTenantId = randomUUID();
    await pool.query(`INSERT INTO tenants (id, name, slug, status, timezone) VALUES ($1, 'Shop A', $2, 'active', 'America/New_York')`, [tenantId, `shop-a-${tenantId.slice(0, 8)}`]);
    await pool.query(`INSERT INTO tenants (id, name, slug, status, timezone) VALUES ($1, 'Shop B', $2, 'active', 'America/New_York')`, [otherTenantId, `shop-b-${otherTenantId.slice(0, 8)}`]);
    userId = randomUUID();
    await pool.query(`INSERT INTO users (id, tenant_id, email) VALUES ($1, $2, 'admin@example.com')`, [userId, tenantId]);
    h.user.userId = userId;
    h.user.tenantId = tenantId;
    const { rows: aProv } = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_providers (tenant_id, name) VALUES ($1, 'Marco') RETURNING id`,
      [tenantId],
    );
    providerId = aProv[0].id;
    const { rows: bProv } = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_providers (tenant_id, name) VALUES ($1, 'Dee') RETURNING id`,
      [otherTenantId],
    );
    otherProviderId = bProv[0].id;
  }, 600_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    if (adminUrl) await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
  }, 60_000);

  it('create into a live phone-call hold returns 409 CONFLICT with expiry (spec §1.6 #10)', async () => {
    day += 1;
    const expires = `2027-02-${String(day).padStart(2, '0')}T20:34:00.000Z`;
    await insertBooking(at('20:00'), at('20:30'), {
      status: 'held',
      hold_expires_at: expires,
      booking_source: 'ai_agent',
      contact_phone: '555-0142',
    });

    const res = await request(app()).post('/scheduling/bookings').send({
      title: 'Walk-in', start_time: at('20:00'), end_time: at('20:30'), provider_id: providerId,
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'CONFLICT',
      heldBy: 'phone_call',
      holdExpiresAt: expires,
    });
    expect(res.body.error).toMatch(/Held by a phone call until 3:34 PM/);
    const { rows } = await pool.query(
      `SELECT id FROM bookings WHERE tenant_id = $1 AND start_time = $2 AND status = 'confirmed'`,
      [tenantId, at('20:00')],
    );
    expect(rows).toHaveLength(0);
  });

  it('confirm into a live phone-call hold returns 409 and leaves the pending booking pending', async () => {
    day += 1;
    const expires = `2027-02-${String(day).padStart(2, '0')}T20:34:00.000Z`;
    await insertBooking(at('20:00'), at('20:30'), {
      status: 'held', hold_expires_at: expires, booking_source: 'ai_agent', contact_phone: '555-0142',
    });
    const pending = await insertBooking(at('20:00'), at('20:30'), { status: 'pending', title: 'Pending cut' });

    const res = await request(app()).post(`/scheduling/bookings/${pending}/transition`).send({ action: 'confirm' });

    expect(res.status).toBe(409);
    expect(res.body.heldBy).toBe('phone_call');
    const { rows } = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [pending]);
    expect(rows[0].status).toBe('pending');
  });

  it('idempotent double POST with the same UI key inserts one row', async () => {
    day += 1;
    const payload = {
      title: 'Trim', start_time: at('11:00'), end_time: at('11:30'), provider_id: providerId,
      contact_name: 'Luis', contact_phone: '555-0142',
    };
    const first = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', `click-${day}`).send(payload);
    const second = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', `click-${day}`).send(payload);

    expect([201, 200]).toContain(first.status);
    expect(first.status).toBe(201);
    expect([200, 201]).toContain(second.status);
    expect(second.body.booking.id).toBe(first.body.booking.id);
    const { rows } = await pool.query(
      `SELECT id FROM bookings WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, `ui:click-${day}`],
    );
    expect(rows).toHaveLength(1);
    const { rows: audit } = await pool.query(
      `SELECT action, changed_by FROM scheduling_audit_log WHERE booking_id = $1 AND action = 'created'`,
      [first.body.booking.id],
    );
    expect(audit).toEqual([{ action: 'created', changed_by: userId }]);
  });

  it('concurrent POSTs with the same UI key insert one row', async () => {
    day += 1;
    const payload = {
      title: 'Trim', start_time: at('12:00'), end_time: at('12:30'), provider_id: providerId,
    };
    const key = `click-race-${day}`;
    const [aRes, bRes] = await Promise.all([
      request(app()).post('/scheduling/bookings').set('Idempotency-Key', key).send(payload),
      request(app()).post('/scheduling/bookings').set('Idempotency-Key', key).send(payload),
    ]);
    const statuses = [aRes.status, bRes.status].sort();
    expect(statuses).toEqual([200, 201]);
    expect(aRes.body.booking.id).toBe(bRes.body.booking.id);
    const { rows } = await pool.query(
      `SELECT id FROM bookings WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, `ui:${key}`],
    );
    expect(rows).toHaveLength(1);
  });

  it('same Idempotency-Key with a different body returns 409 and does not insert', async () => {
    day += 1;
    const key = `click-diff-${day}`;
    const first = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', key).send({
      title: 'Trim', start_time: at('13:00'), end_time: at('13:30'), provider_id: providerId,
    });
    expect(first.status).toBe(201);
    const second = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', key).send({
      title: 'Beard', start_time: at('13:00'), end_time: at('13:30'), provider_id: providerId,
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const { rows } = await pool.query(
      `SELECT title FROM bookings WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, `ui:${key}`],
    );
    expect(rows).toEqual([{ title: 'Trim' }]);
  });

  it('two concurrent cancels: one wins and the other gets 409', async () => {
    day += 1;
    const bookingId = await insertBooking(at('15:00'), at('15:30'));
    const [aRes, bRes] = await Promise.all([
      request(app()).post(`/scheduling/bookings/${bookingId}/transition`).send({ action: 'cancel' }),
      request(app()).post(`/scheduling/bookings/${bookingId}/transition`).send({ action: 'cancel' }),
    ]);
    const statuses = [aRes.status, bRes.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = aRes.status === 200 ? aRes : bRes;
    const loser = aRes.status === 200 ? bRes : aRes;
    expect(winner.body.booking.status).toBe('cancelled');
    expect(loser.body.reason ?? loser.body.error).toBeTruthy();
    const { rows } = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
    expect(rows[0].status).toBe('cancelled');
    const { rows: audit } = await pool.query(
      `SELECT action, changed_by FROM scheduling_audit_log WHERE booking_id = $1 AND action = 'cancel'`,
      [bookingId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].changed_by).toBe(userId);
  });

  it('tenant B booking ids 404 on update, transition, and delete and leave the row unchanged', async () => {
    day += 1;
    const foreign = await insertBooking(
      at('16:00'), at('16:30'), { title: 'B only', contact_phone: '555-0188' }, otherTenantId, otherProviderId,
    );
    const before = await pool.query(`SELECT title, status FROM bookings WHERE id = $1`, [foreign]);

    const updated = await request(app()).put(`/scheduling/bookings/${foreign}`).send({ title: 'Hijack' });
    const transitioned = await request(app()).post(`/scheduling/bookings/${foreign}/transition`).send({ action: 'cancel' });
    const deleted = await request(app()).delete(`/scheduling/bookings/${foreign}`);

    expect(updated.status).toBe(404);
    expect(transitioned.status).toBe(404);
    expect(deleted.status).toBe(404);
    const after = await pool.query(`SELECT title, status FROM bookings WHERE id = $1`, [foreign]);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]).toMatchObject({ title: 'B only', status: 'confirmed' });
  });
});
