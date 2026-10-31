// @vitest-environment node
// Scheduling write actions (PR-13) and find_bookings + the agent identity
// rules (PR-14) through runAction against a throwaway local Postgres (all
// migrations), with the real postgres action store (action_proposals /
// action_idempotency) and every transaction running as the NOBYPASSRLS
// tester role bound to app.tenant_id, like withTenantClient.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, Pool, type PoolClient } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  postgresActionStore,
  runAction,
  toHttpHandler,
  type ActionContext,
  type ActionResult,
  type TenantTx,
} from '../index';
import { createPiiLookupHashRecord } from '../../security/PiiLookupHash';
import { bookPrepareAction } from './book';
import { runHoldSweepCycle, type HoldSweepDeps } from './holdSweeper';

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

function allMigrations(): { name: string; sql: string }[] {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_/.test(f) && f.endsWith('.sql')).sort();
  // Same ordering fix as platform/actions/scheduling/postgres.integration.test.ts.
  const iPins = files.indexOf('063_call_saved_view_pins.sql');
  const iPinOrder = files.indexOf('063_call_saved_views_pin_order.sql');
  if (iPins >= 0 && iPinOrder >= 0 && iPins < iPinOrder) {
    files.splice(iPinOrder, 1);
    files.splice(iPins, 0, '063_call_saved_views_pin_order.sql');
  }
  return files.map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
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

/** One transaction per file; role DDL (migration 120) is cluster-wide, so concurrent-update errors retry. */
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

const TZ = 'America/New_York';
const NOW = new Date('2026-10-19T12:00:00Z'); // Mon Oct 19 2026, 8:00 AM EDT
const minutes = (n: number) => n * 60_000;

/** Local wall time on a 2026-10 day, EDT (UTC-4). */
function edt(day: number, hhmm: string): string {
  return `2026-10-${String(day).padStart(2, '0')}T${hhmm}:00-04:00`;
}

type Shop = {
  tenantId: string;
  cut: string;
  beard: string;
  shave: string;
  color: string;
  marco: string;
  andre: string;
  retired: string;
};

describe.skipIf(!dbReachable)('scheduling write actions on Postgres (PR-13)', () => {
  const DB = `qvo_pr13_writes_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let pool: Pool;
  let seq = 0;

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

  async function seedShop(label: string): Promise<Shop> {
    const tenantId = randomUUID();
    await pool.query(`INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`, [tenantId, label, `${label}-${tenantId.slice(0, 8)}`]);
    const service = (name: string, extra: Record<string, unknown>) =>
      insert('scheduling_appointment_types', { tenant_id: tenantId, name, ...extra });
    const cut = await service("Men's cut", { duration_minutes: 30, price_kind: 'from', price_cents: 3500 });
    const beard = await service('Beard trim', { duration_minutes: 15, buffer_minutes: 5, price_kind: 'fixed', price_cents: 2000 });
    const shave = await service('Hot towel shave', { duration_minutes: 30 });
    const color = await service('Color', { duration_minutes: 60, is_active: false });
    const marco = await insert('scheduling_providers', { tenant_id: tenantId, name: 'Marco' });
    const andre = await insert('scheduling_providers', { tenant_id: tenantId, name: 'Andre' });
    const retired = await insert('scheduling_providers', { tenant_id: tenantId, name: 'Rex', is_active: false });
    for (const [p, t] of [[marco, cut], [marco, beard], [marco, shave], [marco, color], [andre, cut], [retired, cut]]) {
      await pool.query(`INSERT INTO scheduling_provider_services (tenant_id, provider_id, appointment_type_id) VALUES ($1, $2, $3)`, [tenantId, p, t]);
    }
    for (const day of [1, 2, 3, 4, 5, 6]) {
      await pool.query(`INSERT INTO scheduling_business_hours (tenant_id, day_of_week, open_time, close_time) VALUES ($1, $2, '09:00', '17:00')`, [tenantId, day]);
    }
    await insert('scheduling_booking_rules', {
      tenant_id: tenantId, min_lead_time_hours: 2, max_lead_time_days: 30, cancellation_window_hours: 24,
    });
    return { tenantId, cut, beard, shave, color, marco, andre, retired };
  }

  beforeAll(async () => {
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`);
    await adminQuery(`CREATE DATABASE "${DB}"`);
    pool = new Pool({ connectionString: adminUrl(DB)!, max: 8 });
    for (const m of allMigrations()) await applyMigration(pool, m);
    await applyMigration(pool, {
      name: 'platform_rls_tester role',
      sql: `
        DO $$ BEGIN
          CREATE ROLE platform_rls_tester NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_rls_tester;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_rls_tester;
        GRANT platform_rls_tester TO CURRENT_USER;
      `,
    });
  }, 600_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminQuery(`DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`).catch(() => {});
  }, 60_000);

  function ctx(tenantId: string, extra: Partial<ActionContext> = {}): ActionContext {
    return { tenantId, actor: { type: 'agent', id: 'agent-1' }, now: NOW, tenantTimezone: TZ, callId: 'CA-1', ...extra };
  }

  const ADMIN_BOT = { type: 'mcp' as const, id: 'bot', scopes: ['qvo:admin'] };

  /** Prepares get a fresh idempotency key per call; commits key on their token (core default). */
  function act(name: string, c: ActionContext, input: unknown, withTx = withTenantTx): Promise<ActionResult> {
    const idempotencyKey = c.idempotencyKey ?? (name.endsWith('.commit') ? undefined : `key-${++seq}`);
    return runAction(name, { ...c, idempotencyKey }, input, { store: postgresActionStore, withTenantTx: withTx });
  }

  function data<T = Record<string, unknown>>(result: ActionResult): T {
    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
    return result.data as T;
  }

  function errorOf(result: ActionResult) {
    if (result.ok) throw new Error('expected a failure');
    return result.error;
  }

  const LUIS = { name: 'Luis', phone: '(555) 555-0142' };

  function bookInput(shop: Shop, start: string, extra: Record<string, unknown> = {}) {
    return { serviceIds: [shop.cut], staffId: shop.marco, start, customer: LUIS, ...extra };
  }

  async function bookingRows(tenantId: string) {
    const { rows } = await pool.query(
      `SELECT id, status, provider_id, start_time, end_time, blocked_until, hold_expires_at, cancellation_reason,
              idempotency_key, contact_name, contact_phone, booking_source, intake_data
         FROM bookings WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return rows;
  }

  async function live(tenantId: string) {
    return (await bookingRows(tenantId)).filter((r) => r.status === 'held' || r.status === 'confirmed');
  }

  /** A confirmed booking made through the actions (so it carries its services). */
  async function confirmedBooking(shop: Shop, start: string, c: Partial<ActionContext> = {}): Promise<string> {
    const prepared = data<{ confirmationToken: string }>(await act('scheduling.book.prepare', ctx(shop.tenantId, c), bookInput(shop, start)));
    const committed = data<{ bookingId: string }>(await act('scheduling.book.commit', ctx(shop.tenantId, c), { confirmationToken: prepared.confirmationToken }));
    return committed.bookingId;
  }

  describe('scheduling.book.prepare / commit', () => {
    it('holds the slot, reads it back, and confirms it (held → confirmed)', async () => {
      const shop = await seedShop('happy');
      const prepared = await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '10:00'), {
        serviceIds: [shop.cut, shop.beard],
        customer: { ...LUIS, email: 'luis@example.com' },
        notes: 'Keep the top long',
      }));
      const p = data<Record<string, string>>(prepared);
      expect(p).toMatchObject({
        staffId: shop.marco,
        staffName: 'Marco',
        start: '2026-10-20T14:00:00.000Z',
        end: '2026-10-20T14:45:00.000Z',
        expiresAt: '2026-10-19T12:05:00.000Z',
        priceText: 'from $35 plus $20',
        replacedHoldIds: [],
      });
      expect(p.readback).toBe(
        "Men's cut and Beard trim with Marco, tomorrow at 10 AM, for Luis, phone ending in 0142. The price is from $35 plus $20.",
      );
      expect(prepared.ok && prepared.readback).toBe(p.readback);

      const [held] = await bookingRows(shop.tenantId);
      expect(held).toMatchObject({
        id: p.holdId,
        status: 'held',
        provider_id: shop.marco,
        idempotency_key: p.confirmationToken,
        contact_name: 'Luis',
        contact_phone: '+15555550142',
        booking_source: 'ai_agent',
      });
      expect(held.hold_expires_at.toISOString()).toBe('2026-10-19T12:05:00.000Z');
      // blocked_until = end + buffer (beard trim's 5 minutes).
      expect(held.blocked_until.toISOString()).toBe('2026-10-20T14:50:00.000Z');
      expect(held.intake_data).toEqual({ qvo: { serviceIds: [shop.cut, shop.beard], session: 'CA-1' } });

      const committed = await act('scheduling.book.commit', ctx(shop.tenantId, { now: new Date(NOW.getTime() + minutes(1)) }), { confirmationToken: p.confirmationToken });
      expect(committed).toMatchObject({
        ok: true,
        data: {
          bookingId: p.holdId,
          status: 'confirmed',
          confirmationChannel: 'none',
          readback: "Confirmed: Men's cut and Beard trim with Marco, tomorrow at 10 AM, for Luis.",
        },
        effects: [{ type: 'booking.confirmed' }],
      });
      const [row] = await bookingRows(shop.tenantId);
      expect(row).toMatchObject({ id: p.holdId, status: 'confirmed', hold_expires_at: null });
      const audit = await pool.query(`SELECT action, previous_status, new_status FROM scheduling_audit_log WHERE booking_id = $1`, [p.holdId]);
      expect(audit.rows).toEqual([{ action: 'created', previous_status: 'held', new_status: 'confirmed' }]);
    });

    it("assigns the engine's staff member for 'any' and says when the shop will confirm the price", async () => {
      const shop = await seedShop('any');
      const anyCut = data(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '10:00'), { staffId: 'any' })));
      // Least busy, then name order: Andre before Marco.
      expect(anyCut).toMatchObject({ staffId: shop.andre, staffName: 'Andre', priceText: 'from $35' });
      const shave = data(await act('scheduling.book.prepare', ctx(shop.tenantId, { callId: 'CA-2' }), bookInput(shop, edt(20, '10:00'), {
        serviceIds: [shop.shave], staffId: 'any',
      })));
      expect(shave).toMatchObject({ staffId: shop.marco, priceText: 'the shop will confirm the price' });
      expect(shave.readback).toMatch(/The shop will confirm the price\.$/);
    });

    it.each([
      ['an off-grid start', (s: Shop) => bookInput(s, edt(20, '10:07')), 'start'],
      ['an unknown service', (s: Shop) => bookInput(s, edt(20, '10:00'), { serviceIds: ['nope'] }), 'serviceIds'],
      ['an inactive service', (s: Shop) => bookInput(s, edt(20, '10:00'), { serviceIds: [s.color] }), 'serviceIds'],
      ['a staff member who does not do the service', (s: Shop) => bookInput(s, edt(20, '10:00'), { serviceIds: [s.beard], staffId: s.andre }), 'staffId'],
      ['a start inside the minimum lead time', (s: Shop) => bookInput(s, edt(19, '09:00')), 'start'],
      ['a start past the max booking days', (s: Shop) => ({ ...bookInput(s, '2026-11-24T10:00:00-05:00') }), 'start'],
      ['a start in the past', (s: Shop) => bookInput(s, edt(16, '10:00')), 'start'],
      ['an invalid phone', (s: Shop) => bookInput(s, edt(20, '10:00'), { customer: { name: 'Luis', phone: '12345' } }), 'customer.phone'],
      ['a name over 80 characters', (s: Shop) => bookInput(s, edt(20, '10:00'), { customer: { ...LUIS, name: 'x'.repeat(81) } }), 'customer.name'],
      ['four services', (s: Shop) => bookInput(s, edt(20, '10:00'), { serviceIds: [s.cut, s.beard, s.shave, s.color] }), 'serviceIds'],
      ['a start without an offset', (s: Shop) => bookInput(s, '2026-10-20T10:00:00'), 'start'],
    ])('rejects %s with VALIDATION_FAILED and holds nothing', async (_label, build, field) => {
      const shop = await seedShop('invalid');
      const error = errorOf(await act('scheduling.book.prepare', ctx(shop.tenantId), build(shop)));
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED', field });
      expect(await bookingRows(shop.tenantId)).toEqual([]);
    });

    it('returns NOT_FOUND for an unknown or inactive staff member', async () => {
      const shop = await seedShop('nostaff');
      for (const staffId of ['ghost', shop.retired]) {
        const error = errorOf(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '10:00'), { staffId })));
        expect(error).toMatchObject({ code: 'NOT_FOUND', field: 'staffId', callerSafeMessage: "I couldn't find that staff member." });
      }
    });

    it('returns CONFLICT with up to 3 nearby alternatives over a confirmed booking or a live hold', async () => {
      const shop = await seedShop('conflict');
      await insert('bookings', {
        tenant_id: shop.tenantId, title: 'Cut', provider_id: shop.marco, status: 'confirmed',
        start_time: edt(20, '11:00'), end_time: edt(20, '11:30'),
      });
      const overBooking = errorOf(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '11:15'))));
      expect(overBooking.code).toBe('CONFLICT');
      expect(overBooking.callerSafeMessage).toBe("That time isn't available. I can offer the closest open times.");
      const alternatives = overBooking.alternatives as Array<{ start: string; staffId: string; spoken: string }>;
      expect(alternatives.map((a) => a.start)).toEqual(['2026-10-20T14:30:00.000Z', '2026-10-20T15:30:00.000Z', '2026-10-20T15:45:00.000Z']);
      expect(alternatives.every((a) => a.staffId === shop.marco)).toBe(true);
      expect(alternatives[0].spoken).toBe('tomorrow at 10:30 AM');

      // Another caller's live hold blocks the same way.
      data(await act('scheduling.book.prepare', ctx(shop.tenantId, { callId: 'CA-other' }), bookInput(shop, edt(20, '14:00'))));
      const overHold = errorOf(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '14:00'))));
      expect(overHold.code).toBe('CONFLICT');
      expect((overHold.alternatives as Array<{ start: string }>).map((a) => a.start)).not.toContain('2026-10-20T18:00:00.000Z');
      expect((await live(shop.tenantId)).length).toBe(2);
    });

    it('maps CONFLICT to HTTP 409 and VALIDATION_FAILED to 400 through the HTTP adapter', async () => {
      const shop = await seedShop('http');
      const handler = toHttpHandler(bookPrepareAction, { store: postgresActionStore, withTenantTx });
      const base = {
        tenantId: shop.tenantId,
        actor: { type: 'user' as const, id: 'u-1', role: 'operations_manager' },
        tenantTimezone: TZ,
        now: NOW,
      };
      await insert('bookings', {
        tenant_id: shop.tenantId, title: 'Cut', provider_id: shop.marco, status: 'confirmed',
        start_time: edt(20, '11:00'), end_time: edt(20, '11:30'),
      });
      const taken = await handler({ ...base, headers: { 'Idempotency-Key': 'ui-1' }, body: bookInput(shop, edt(20, '11:00')) });
      expect(taken.status).toBe(409);
      const offGrid = await handler({ ...base, headers: { 'Idempotency-Key': 'ui-2' }, body: bookInput(shop, edt(20, '11:05')) });
      expect(offGrid.status).toBe(400);
    });

    it('re-takes the same slot when the hold ran out but nobody took it', async () => {
      const shop = await seedShop('retake');
      const p = data<{ confirmationToken: string; holdId: string }>(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '10:00'))));
      const later = ctx(shop.tenantId, { now: new Date(NOW.getTime() + minutes(7)) });
      const committed = data(await act('scheduling.book.commit', later, { confirmationToken: p.confirmationToken }));
      expect(committed).toMatchObject({ bookingId: p.holdId, status: 'confirmed' });
      expect((await live(shop.tenantId)).map((r) => r.status)).toEqual(['confirmed']);
    });

    it('re-takes a hold the sweeper already released', async () => {
      const shop = await seedShop('swept');
      const p = data<{ confirmationToken: string; holdId: string }>(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '10:00'))));
      // Swept as of 12:06 (expireStaleHolds is what the sweeper runs).
      await pool.query(`UPDATE bookings SET status = 'cancelled', cancellation_reason = 'hold_expired' WHERE id = $1`, [p.holdId]);
      const committed = data(await act('scheduling.book.commit', ctx(shop.tenantId, { now: new Date(NOW.getTime() + minutes(7)) }), { confirmationToken: p.confirmationToken }));
      expect(committed).toMatchObject({ bookingId: p.holdId, status: 'confirmed' });
    });

    it('returns CONFLICT (hold lost) with alternatives when someone took the slot after the hold ran out', async () => {
      const shop = await seedShop('lost');
      const mine = data<{ confirmationToken: string; holdId: string }>(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '10:00'))));
      const sixLater = new Date(NOW.getTime() + minutes(6));
      // The other caller's prepare expires my stale hold and takes the slot.
      const theirs = data(await act('scheduling.book.prepare', ctx(shop.tenantId, { callId: 'CA-2', now: sixLater }), bookInput(shop, edt(20, '10:00'), {
        customer: { name: 'Ana', phone: '+15555550188' },
      })));
      expect(theirs.staffId).toBe(shop.marco);
      const lost = errorOf(await act('scheduling.book.commit', ctx(shop.tenantId, { now: new Date(NOW.getTime() + minutes(7)) }), { confirmationToken: mine.confirmationToken }));
      expect(lost.code).toBe('CONFLICT');
      expect(lost.callerSafeMessage).toMatch(/hold ran out/);
      expect((lost.alternatives as unknown[]).length).toBeGreaterThan(0);
      const rows = await bookingRows(shop.tenantId);
      expect(rows.find((r) => r.id === mine.holdId)).toMatchObject({ status: 'cancelled', cancellation_reason: 'hold_expired' });
      expect((await live(shop.tenantId)).map((r) => r.contact_name)).toEqual(['Ana']);
    });

    it('rejects a token after its proposal expired', async () => {
      const shop = await seedShop('expired');
      const p = data<{ confirmationToken: string }>(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '10:00'))));
      const late = errorOf(await act('scheduling.book.commit', ctx(shop.tenantId, { now: new Date(NOW.getTime() + minutes(16)) }), { confirmationToken: p.confirmationToken }));
      expect(late).toMatchObject({ code: 'CONFIRMATION_INVALID', message: 'Confirmation token has expired' });
    });

    it('replays a commit retried with the same token: one booking, same result (spec §1.6 #9)', async () => {
      const shop = await seedShop('retry');
      const p = data<{ confirmationToken: string }>(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '10:00'))));
      const first = await act('scheduling.book.commit', ctx(shop.tenantId), { confirmationToken: p.confirmationToken });
      const retry = await act('scheduling.book.commit', ctx(shop.tenantId, { now: new Date(NOW.getTime() + 2_000) }), { confirmationToken: p.confirmationToken });
      expect(first.ok).toBe(true);
      expect(retry).toEqual(first);
      expect((await live(shop.tenantId)).map((r) => r.status)).toEqual(['confirmed']);
      const audits = await pool.query(`SELECT COUNT(*)::int AS n FROM scheduling_audit_log WHERE tenant_id = $1`, [shop.tenantId]);
      expect(audits.rows[0].n).toBe(1);
      // The token is bound to its call: another call can't use it.
      const otherCall = errorOf(await act('scheduling.book.commit', ctx(shop.tenantId, { callId: 'CA-9' }), { confirmationToken: p.confirmationToken }));
      expect(['CONFIRMATION_INVALID', 'IDEMPOTENCY_KEY_REUSED']).toContain(otherCall.code);
      expect((await live(shop.tenantId)).length).toBe(1);
    });

    it('releases the earlier hold when the caller corrects the booking (spec §1.6 #6)', async () => {
      const shop = await seedShop('correction');
      const first = data<{ confirmationToken: string; holdId: string }>(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '15:30'))));
      // Another call's hold is not touched by this call's correction.
      const other = data<{ holdId: string }>(await act('scheduling.book.prepare', ctx(shop.tenantId, { callId: 'CA-other' }), bookInput(shop, edt(20, '10:00'), { staffId: shop.andre })));
      const second = data<{ confirmationToken: string; holdId: string; replacedHoldIds: string[] }>(
        await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '16:00'), { serviceIds: [shop.cut, shop.beard] })),
      );
      expect(second.replacedHoldIds).toEqual([first.holdId]);
      const rows = await bookingRows(shop.tenantId);
      expect(rows.find((r) => r.id === first.holdId)).toMatchObject({ status: 'cancelled', cancellation_reason: 'hold_superseded' });
      expect(rows.find((r) => r.id === other.holdId)).toMatchObject({ status: 'held' });

      const stale = errorOf(await act('scheduling.book.commit', ctx(shop.tenantId), { confirmationToken: first.confirmationToken }));
      expect(stale.code).toBe('CONFIRMATION_INVALID');
      data(await act('scheduling.book.commit', ctx(shop.tenantId), { confirmationToken: second.confirmationToken }));
      const mine = (await live(shop.tenantId)).filter((r) => r.contact_name === 'Luis' && r.provider_id === shop.marco);
      expect(mine.map((r) => [r.status, r.start_time.toISOString()])).toEqual([['confirmed', '2026-10-20T20:00:00.000Z']]);
    });

    it('lets a correction re-prepare the same slot its own hold occupies', async () => {
      const shop = await seedShop('sameslot');
      data(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '10:00'))));
      const again = data(await act('scheduling.book.prepare', ctx(shop.tenantId), bookInput(shop, edt(20, '10:00'), { serviceIds: [shop.shave] })));
      expect(again.staffId).toBe(shop.marco);
      expect((await live(shop.tenantId)).length).toBe(1);
    });

    it('reads back in Spanish when the call carries locale es', async () => {
      const shop = await seedShop('es');
      const es = ctx(shop.tenantId, { locale: 'es' });
      const p = data<{ readback: string; priceText: string; confirmationToken: string }>(
        await act('scheduling.book.prepare', es, bookInput(shop, edt(20, '15:30'))),
      );
      expect(p.readback).toMatch(/^Men's cut con Marco, mañana, 3:30 p\. ?m\., para Luis, teléfono que termina en 0142\. El precio es desde 35 dólares\.$/);
      expect(p.priceText).toBe('desde 35 dólares');
      const c = data<{ readback: string }>(await act('scheduling.book.commit', es, { confirmationToken: p.confirmationToken }));
      expect(c.readback).toMatch(/^Confirmado: Men's cut con Marco, mañana, 3:30 p\. ?m\., para Luis\.$/);
      const unpriced = data<{ readback: string; priceText: string }>(
        await act('scheduling.book.prepare', ctx(shop.tenantId, { locale: 'es-MX', callId: 'CA-2' }), bookInput(shop, edt(21, '10:00'), { serviceIds: [shop.shave] })),
      );
      expect(unpriced.priceText).toBe('el negocio le confirmará el precio');
      expect(unpriced.readback).toMatch(/El negocio le confirmará el precio\.$/);
      const conflict = errorOf(await act('scheduling.book.prepare', ctx(shop.tenantId, { locale: 'es', callId: 'CA-3' }), bookInput(shop, edt(20, '15:30'))));
      expect(conflict.callerSafeMessage).toBe('Ese horario no está disponible. Le puedo ofrecer los horarios libres más cercanos.');
    });

    it("names the service by the shop's Spanish alias on an es call, and by the catalog name in English", async () => {
      // Oct 22 2026 call: the commit said "Confirmado: Haircut con Dee" after a Spanish read-back.
      const shop = await seedShop('es-name');
      const haircut = await insert('scheduling_appointment_types', {
        tenant_id: shop.tenantId, name: 'Haircut', duration_minutes: 30, price_kind: 'from', price_cents: 3000,
        aliases: ['hair cut', 'corte', 'corte de pelo', 'corte de cabello'],
      });
      await pool.query(`INSERT INTO scheduling_provider_services (tenant_id, provider_id, appointment_type_id) VALUES ($1, $2, $3)`, [shop.tenantId, shop.marco, haircut]);
      const es = ctx(shop.tenantId, { locale: 'es' });
      const p = data<{ readback: string; confirmationToken: string }>(
        await act('scheduling.book.prepare', es, bookInput(shop, edt(20, '15:30'), { serviceIds: [haircut] })),
      );
      expect(p.readback).toMatch(/^corte de pelo con Marco, mañana, 3:30 p\. ?m\., para Luis, teléfono que termina en 0142\. El precio es desde 30 dólares\.$/);
      const c = data<{ bookingId: string; readback: string }>(await act('scheduling.book.commit', es, { confirmationToken: p.confirmationToken }));
      expect(c.readback).toMatch(/^Confirmado: corte de pelo con Marco, mañana, 3:30 p\. ?m\., para Luis\.$/);

      const en = ctx(shop.tenantId, { callId: 'CA-2' });
      const pe = data<{ readback: string; confirmationToken: string }>(
        await act('scheduling.book.prepare', en, bookInput(shop, edt(20, '10:00'), { serviceIds: [haircut] })),
      );
      expect(pe.readback).toBe('Haircut with Marco, tomorrow at 10 AM, for Luis, phone ending in 0142. The price is from $30.');
      const ce = data<{ readback: string }>(await act('scheduling.book.commit', en, { confirmationToken: pe.confirmationToken }));
      expect(ce.readback).toBe('Confirmed: Haircut with Marco, tomorrow at 10 AM, for Luis.');

      // find, reschedule and cancel name it the same way.
      const admin = ctx(shop.tenantId, { actor: ADMIN_BOT, callId: undefined, locale: 'es' });
      const reader = { ...admin, actor: { type: 'mcp' as const, id: 'bot', scopes: ['qvo:read'] } };
      const found = data<{ bookings: { bookingId: string; spoken: string }[] }>(
        await act('scheduling.find_bookings', reader, { phone: LUIS.phone, date: '2026-10-20', time: '15:30' }),
      );
      expect(found.bookings.map((b) => b.spoken)).toEqual([expect.stringMatching(/^corte de pelo con Marco, /)]);
      const rp = data<{ confirmationToken: string; readback: string }>(
        await act('scheduling.reschedule.prepare', admin, { bookingId: c.bookingId, newStart: edt(23, '14:00') }),
      );
      expect(rp.readback).toMatch(/^Vamos a mover la cita de Luis, corte de pelo, de /);
      const moved = data<{ bookingId: string; readback: string }>(await act('scheduling.reschedule.commit', admin, { confirmationToken: rp.confirmationToken }));
      expect(moved.readback).toMatch(/^Listo: la cita de Luis, corte de pelo, ahora es /);
      const cp = data<{ confirmationToken: string; readback: string }>(await act('scheduling.cancel.prepare', admin, { bookingId: moved.bookingId }));
      expect(cp.readback).toMatch(/^Vamos a cancelar la cita de Luis, corte de pelo con Marco, /);
      const cancelled = data<{ readback: string }>(await act('scheduling.cancel.commit', admin, { confirmationToken: cp.confirmationToken }));
      expect(cancelled.readback).toMatch(/^Cancelada: la cita de Luis, corte de pelo con Marco, /);
    });

    it('enforces permissions: agent and qvo:admin allowed, other roles and scopes are not', async () => {
      const shop = await seedShop('perms');
      const input = bookInput(shop, edt(20, '10:00'));
      const staffRole = errorOf(await act('scheduling.book.prepare', ctx(shop.tenantId, { actor: { type: 'user', id: 'u-1', role: 'staff' } }), input));
      expect(staffRole.code).toBe('FORBIDDEN');
      const readScope = errorOf(await act('scheduling.book.prepare', ctx(shop.tenantId, { actor: { type: 'mcp', id: 'bot', scopes: ['qvo:read'] } }), input));
      expect(readScope.code).toBe('FORBIDDEN');
      data(await act('scheduling.book.prepare', ctx(shop.tenantId, { actor: ADMIN_BOT }), input));
      expect(await bookingRows(shop.tenantId)).toHaveLength(1);
    });
  });

  describe('scheduling.reschedule.prepare / commit', () => {
    it('holds the new time without touching the original, then moves it in one transaction', async () => {
      const shop = await seedShop('resched');
      const original = await confirmedBooking(shop, edt(22, '10:00'));
      const admin = ctx(shop.tenantId, { actor: ADMIN_BOT, callId: undefined });
      const p = data<{ confirmationToken: string; holdId: string; readback: string; staffId: string }>(
        await act('scheduling.reschedule.prepare', admin, { bookingId: original, newStart: edt(23, '14:00') }),
      );
      expect(p.readback).toBe("Moving Luis's Men's cut from Thursday at 10 AM with Marco to Friday at 2 PM with Marco.");
      let rows = await bookingRows(shop.tenantId);
      expect(rows.find((r) => r.id === original)).toMatchObject({ status: 'confirmed' });
      expect(rows.find((r) => r.id === p.holdId)).toMatchObject({ status: 'held', contact_name: 'Luis', contact_phone: '+15555550142' });

      const c = data(await act('scheduling.reschedule.commit', admin, { confirmationToken: p.confirmationToken }));
      expect(c).toMatchObject({
        bookingId: p.holdId,
        previousBookingId: original,
        status: 'confirmed',
        start: '2026-10-23T18:00:00.000Z',
        readback: "Done: Luis's Men's cut is now Friday at 2 PM with Marco.",
      });
      rows = await bookingRows(shop.tenantId);
      expect(rows.find((r) => r.id === original)).toMatchObject({ status: 'rescheduled' });
      expect(rows.find((r) => r.id === p.holdId)).toMatchObject({ status: 'confirmed', hold_expires_at: null });
      expect((await live(shop.tenantId)).map((r) => r.id)).toEqual([p.holdId]);
    });

    it('returns OUTSIDE_POLICY with the policy text inside the cancellation window', async () => {
      const shop = await seedShop('window');
      const soon = await confirmedBooking(shop, edt(19, '15:00')); // 7 hours away; window 24 h
      const admin = ctx(shop.tenantId, { actor: ADMIN_BOT });
      const error = errorOf(await act('scheduling.reschedule.prepare', admin, { bookingId: soon, newStart: edt(23, '14:00') }));
      expect(error).toMatchObject({
        code: 'OUTSIDE_POLICY',
        callerSafeMessage: "The shop's policy needs at least 24 hours' notice to change or cancel an appointment. I can take a message for the shop.",
      });
      const es = errorOf(await act('scheduling.reschedule.prepare', { ...admin, locale: 'es' }, { bookingId: soon, newStart: edt(23, '14:00') }));
      expect(es.callerSafeMessage).toMatch(/^La política del negocio pide al menos 24 horas de aviso/);
      expect((await live(shop.tenantId)).map((r) => r.id)).toEqual([soon]);
    });

    it('offers alternatives when the new time is taken; an agent without a verified find gets NOT_FOUND', async () => {
      const shop = await seedShop('resched2');
      const original = await confirmedBooking(shop, edt(22, '10:00'));
      await confirmedBooking(shop, edt(23, '14:00'), { callId: 'CA-2' });
      const admin = ctx(shop.tenantId, { actor: ADMIN_BOT });
      const taken = errorOf(await act('scheduling.reschedule.prepare', admin, { bookingId: original, newStart: edt(23, '14:00') }));
      expect(taken.code).toBe('CONFLICT');
      expect((taken.alternatives as unknown[]).length).toBeGreaterThan(0);
      const agent = errorOf(await act('scheduling.reschedule.prepare', ctx(shop.tenantId), { bookingId: original, newStart: edt(23, '15:00') }));
      expect(agent.code).toBe('NOT_FOUND');
      const missing = errorOf(await act('scheduling.reschedule.prepare', admin, { bookingId: 'nope', newStart: edt(23, '15:00') }));
      expect(missing.code).toBe('NOT_FOUND');
    });
  });

  describe('scheduling.cancel.prepare / commit', () => {
    it('reads back, then cancels', async () => {
      const shop = await seedShop('cancel');
      const booking = await confirmedBooking(shop, edt(22, '10:00'));
      const admin = ctx(shop.tenantId, { actor: ADMIN_BOT });
      const p = data<{ confirmationToken: string; readback: string }>(await act('scheduling.cancel.prepare', admin, { bookingId: booking, reason: 'Out of town' }));
      expect(p.readback).toBe("Cancelling Luis's Men's cut with Marco, Thursday at 10 AM.");
      expect((await live(shop.tenantId)).map((r) => r.status)).toEqual(['confirmed']);
      const c = data(await act('scheduling.cancel.commit', admin, { confirmationToken: p.confirmationToken }));
      expect(c).toMatchObject({ bookingId: booking, status: 'cancelled', readback: "Cancelled: Luis's Men's cut with Marco, Thursday at 10 AM." });
      const [row] = await bookingRows(shop.tenantId);
      expect(row).toMatchObject({ status: 'cancelled', cancellation_reason: 'Out of town' });
      // Retrying the commit replays; a second cancel prepare is refused.
      expect(await act('scheduling.cancel.commit', admin, { confirmationToken: p.confirmationToken })).toMatchObject({ ok: true });
      expect(errorOf(await act('scheduling.cancel.prepare', admin, { bookingId: booking })).code).toBe('VALIDATION_FAILED');
    });

    it('returns OUTSIDE_POLICY inside the cancellation window and leaves the booking alone', async () => {
      const shop = await seedShop('cancelwin');
      const booking = await confirmedBooking(shop, edt(19, '15:00'));
      const error = errorOf(await act('scheduling.cancel.prepare', ctx(shop.tenantId, { actor: ADMIN_BOT }), { bookingId: booking }));
      expect(error.code).toBe('OUTSIDE_POLICY');
      expect(error.callerSafeMessage).toMatch(/24 hours' notice/);
      expect((await live(shop.tenantId)).map((r) => r.status)).toEqual(['confirmed']);
    });

    it('returns CONFLICT if the shop moved the booking between prepare and commit', async () => {
      const shop = await seedShop('cancelmoved');
      const booking = await confirmedBooking(shop, edt(22, '10:00'));
      const admin = ctx(shop.tenantId, { actor: ADMIN_BOT });
      const p = data<{ confirmationToken: string }>(await act('scheduling.cancel.prepare', admin, { bookingId: booking }));
      await pool.query(`UPDATE bookings SET start_time = $2, end_time = $3 WHERE id = $1`, [booking, edt(22, '11:00'), edt(22, '11:30')]);
      expect(errorOf(await act('scheduling.cancel.commit', admin, { confirmationToken: p.confirmationToken })).code).toBe('CONFLICT');
      expect((await bookingRows(shop.tenantId))[0].status).toBe('confirmed');
    });
  });

  describe('scheduling.find_bookings and the agent identity rules (PR-14, spec §0.2.6)', () => {
    const PHONE = '+15555550142';
    const STAFF = { type: 'user' as const, id: 'u-staff', role: 'staff' };

    /** A call_sessions row (the trusted caller ID); callerNumber null = blocked. */
    async function call(tenantId: string, callerNumber: string | null, extra: Record<string, unknown> = {}): Promise<string> {
      const id = `CA-${randomUUID()}`;
      await insert('call_sessions', { id, tenant_id: tenantId, caller_number: callerNumber, ...extra });
      return id;
    }

    /** A booking written straight to the table, as the admin routes or a past call left it. */
    function booking(shop: Shop, start: string, extra: Record<string, unknown> = {}): Promise<string> {
      return insert('bookings', {
        tenant_id: shop.tenantId, title: "Men's cut", provider_id: shop.marco, appointment_type_id: shop.cut,
        status: 'confirmed', contact_name: 'Luis', contact_phone: PHONE,
        start_time: start, end_time: new Date(Date.parse(start) + minutes(30)).toISOString(), ...extra,
      });
    }

    const agentIn = (shop: Shop, callId: string | undefined, extra: Partial<ActionContext> = {}) =>
      ctx(shop.tenantId, { callId, ...extra });

    type Found = { verified: boolean; bookings: Array<Record<string, unknown>>; needs?: string; askId?: string; exit?: string };
    const find = async (c: ActionContext, input: Record<string, unknown>) => data<Found>(await act('scheduling.find_bookings', c, input));
    const ids = (found: Found) => found.bookings.map((b) => b.bookingId);
    // RT-06: a refusal also carries the next askId (and exit after the second miss); never a count.
    const REFUSED_NAME = { verified: false, bookings: [], needs: 'name' };
    const REFUSED_NDT = { verified: false, bookings: [], needs: 'name_date_time' };
    const FIRST_NAME_ASK = { ...REFUSED_NAME, askId: 'ask.bookingName', callerSafeMessage: 'What name is the appointment under?' };
    const refusedWithoutCount = (found: Found, base: Record<string, unknown>) => {
      expect(found).toMatchObject(base);
      expect(found).not.toHaveProperty('matchCount');
    };

    it('caller-ID match plus the name on the booking returns it verified, with a spoken line', async () => {
      const shop = await seedShop('find-ok');
      const id = await booking(shop, edt(22, '10:00'));
      const c = agentIn(shop, await call(shop.tenantId, PHONE));
      expect(await find(c, { phone: '(555) 555-0142', name: 'luís' })).toEqual({
        verified: true,
        bookings: [{
          bookingId: id,
          customerName: 'Luis',
          serviceNames: ["Men's cut"],
          staffId: shop.marco,
          staffName: 'Marco',
          start: '2026-10-22T14:00:00.000Z',
          end: '2026-10-22T14:30:00.000Z',
          spoken: "Men's cut with Marco, Thursday at 10 AM, for Luis.",
        }],
      });
    });

    it('caller-ID match with a wrong name or no name reveals nothing but what to ask for; the second miss exits', async () => {
      const shop = await seedShop('find-name');
      await booking(shop, edt(22, '10:00'));
      const c = agentIn(shop, await call(shop.tenantId, PHONE));
      expect(await find(c, { phone: PHONE, name: 'Ana' })).toEqual(FIRST_NAME_ASK);
      // No count either (RT-06), and the second miss in the call is the exit.
      expect(await find(c, { phone: PHONE })).toEqual({
        ...REFUSED_NAME, askId: 'ask.bookingName', callerSafeMessage: 'I can take a message so someone can call you back.', exit: 'message_ticket',
      });
      // After the exit even the right name finds nothing in this call.
      refusedWithoutCount(await find(c, { phone: PHONE, name: 'Luis' }), { ...REFUSED_NAME, exit: 'message_ticket' });
      // A wrong name looks exactly like a number with no bookings at all.
      const empty = agentIn(shop, await call(shop.tenantId, '+15555550199'));
      expect(await find(empty, { phone: '+15555550199', name: 'Ana' })).toEqual(FIRST_NAME_ASK);
    });

    it('a different, blocked or missing caller ID needs name + date + time; any one wrong or missing reveals nothing', async () => {
      const shop = await seedShop('find-ndt');
      const id = await booking(shop, edt(22, '10:00'));
      const full = { phone: PHONE, name: 'Luis', date: '2026-10-22', time: '10:00' };
      const partials = [
        { ...full, name: 'Ana' },
        { ...full, date: '2026-10-23' },
        { ...full, time: '10:30' },
        { phone: PHONE, name: 'Luis' },
        { phone: PHONE, name: 'Luis', date: '2026-10-22' },
        { phone: PHONE, date: '2026-10-22', time: '10:00' },
      ];
      const contexts = [
        agentIn(shop, await call(shop.tenantId, '+15555550199')), // different caller ID
        agentIn(shop, await call(shop.tenantId, null)), // blocked
        agentIn(shop, await call(shop.tenantId, 'enc:15555550142')), // unreadable (ciphertext, no lookup hash)
        agentIn(shop, 'CA-no-session'), // no call_sessions row
        agentIn(shop, undefined), // no callId
      ];
      for (const c of contexts) {
        expect(ids(await find(c, full))).toEqual([id]);
        for (const partial of partials) refusedWithoutCount(await find(c, partial), REFUSED_NDT);
      }
    });

    it('matches an encrypted caller_number through its caller_lookup_hash', async () => {
      vi.stubEnv('QVO_PII_LOOKUP_HMAC_KEY', 'k'.repeat(48));
      try {
        const shop = await seedShop('find-hash');
        const id = await booking(shop, edt(22, '10:00'));
        const mine = createPiiLookupHashRecord(shop.tenantId, PHONE, 'caller_memory')!;
        const other = createPiiLookupHashRecord(shop.tenantId, '+15555550199', 'caller_memory')!;
        const hashed = (h: typeof mine) => ({ caller_lookup_hash: h.hash, caller_lookup_key_version: h.keyVersion });
        const c = agentIn(shop, await call(shop.tenantId, 'enc:v1:opaque', hashed(mine)));
        expect(ids(await find(c, { phone: PHONE, name: 'Luis' }))).toEqual([id]);
        const d = agentIn(shop, await call(shop.tenantId, 'enc:v1:opaque', hashed(other)));
        refusedWithoutCount(await find(d, { phone: PHONE, name: 'Luis' }), REFUSED_NDT);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('lists only upcoming confirmed bookings: never past, cancelled, held or superseded', async () => {
      const shop = await seedShop('find-excl');
      const upcoming = await booking(shop, edt(22, '10:00'));
      await booking(shop, edt(19, '07:30')); // earlier today
      await booking(shop, edt(16, '10:00')); // last Friday
      await booking(shop, edt(22, '13:00'), { status: 'cancelled' });
      await booking(shop, edt(22, '15:00'), { status: 'held', hold_expires_at: edt(19, '08:05') });
      await booking(shop, edt(23, '10:00'), { status: 'rescheduled' });
      const staff = ctx(shop.tenantId, { actor: STAFF, callId: undefined });
      expect(ids(await find(staff, { phone: PHONE }))).toEqual([upcoming]);
      const c = agentIn(shop, await call(shop.tenantId, PHONE));
      expect(ids(await find(c, { phone: PHONE, name: 'Luis' }))).toEqual([upcoming]);
      refusedWithoutCount(await find(c, { phone: PHONE }), REFUSED_NAME);
    });

    it('two family members on one phone: the first name finds both, the full name one (spec §1.6 #12)', async () => {
      const shop = await seedShop('find-family');
      const dad = await booking(shop, edt(22, '10:00'), { contact_name: 'Luis Garcia' });
      const son = await booking(shop, edt(24, '10:00'), { contact_name: 'Luis Garcia Jr.', provider_id: shop.andre });
      const ana = await booking(shop, edt(23, '10:00'), { contact_name: 'Ana García' });
      const c = agentIn(shop, await call(shop.tenantId, PHONE));
      const both = await find(c, { phone: PHONE, name: 'Luis' });
      expect(both.bookings.map((b) => [b.bookingId, b.customerName, b.staffName])).toEqual([
        [dad, 'Luis Garcia', 'Marco'],
        [son, 'Luis Garcia Jr.', 'Andre'],
      ]);
      expect(ids(await find(c, { phone: PHONE, name: 'luis garcia jr' }))).toEqual([son]);
      expect(ids(await find(c, { phone: PHONE, name: 'ana garcia' }))).toEqual([ana]);
      refusedWithoutCount(await find(c, { phone: PHONE }), REFUSED_NAME);
    });

    it('filters by name, date and time before the result cap: the 25th upcoming booking on one phone is found', async () => {
      const shop = await seedShop('find-many');
      const created: string[] = [];
      for (const day of [20, 21, 22, 23, 24]) {
        for (const at of ['09:00', '09:30', '10:00', '10:30', '11:00']) created.push(await booking(shop, edt(day, at)));
      }
      const last = created[created.length - 1];
      await pool.query(`UPDATE bookings SET contact_name = 'Mateo Ruiz' WHERE id = $1`, [last]);
      const exact = { phone: PHONE, name: 'Mateo', date: '2026-10-24', time: '11:00' };

      const staff = ctx(shop.tenantId, { actor: STAFF, callId: undefined });
      expect(ids(await find(staff, { phone: PHONE }))).toEqual(created.slice(0, 20));
      expect(ids(await find(staff, exact))).toEqual([last]);
      expect(ids(await find(staff, { phone: PHONE, name: 'Mateo' }))).toEqual([last]);

      // Agent, caller ID differs: name + date + time of the last one verifies it, and it can be acted on.
      const c = agentIn(shop, await call(shop.tenantId, '+15555550199'));
      expect(ids(await find(c, exact))).toEqual([last]);
      expect(data(await act('scheduling.cancel.prepare', c, { bookingId: last }))).toMatchObject({ confirmationToken: expect.any(String) });
      // Agent, caller ID matches: the name alone finds it; without a name, nothing (not even a count).
      const mine = agentIn(shop, await call(shop.tenantId, PHONE));
      expect(ids(await find(mine, { phone: PHONE, name: 'Mateo Ruiz' }))).toEqual([last]);
      refusedWithoutCount(await find(mine, { phone: PHONE }), REFUSED_NAME);
    });

    it("tenant A never sees tenant B's bookings on the same phone, nor acts on them", async () => {
      const a = await seedShop('find-iso-a');
      const b = await seedShop('find-iso-b');
      const mine = await booking(a, edt(22, '10:00'));
      const theirs = await booking(b, edt(22, '13:00'));
      const aCall = await call(a.tenantId, PHONE);
      const bCall = await call(b.tenantId, PHONE);
      expect(ids(await find(agentIn(a, aCall), { phone: PHONE, name: 'Luis' }))).toEqual([mine]);
      expect(ids(await find(ctx(a.tenantId, { actor: STAFF }), { phone: PHONE }))).toEqual([mine]);
      // B's call is not A's caller ID.
      refusedWithoutCount(await find(agentIn(a, bCall), { phone: PHONE, name: 'Luis' }), REFUSED_NDT);
      // B verified its own booking in its own call; A can't act on it with either callId.
      expect(ids(await find(agentIn(b, bCall), { phone: PHONE, name: 'Luis' }))).toEqual([theirs]);
      for (const callId of [aCall, bCall]) {
        expect(errorOf(await act('scheduling.cancel.prepare', agentIn(a, callId), { bookingId: theirs })).code).toBe('NOT_FOUND');
        expect(errorOf(await act('scheduling.reschedule.prepare', agentIn(a, callId), { bookingId: theirs, newStart: edt(23, '14:00') })).code).toBe('NOT_FOUND');
      }
      expect((await bookingRows(b.tenantId)).map((r) => r.status)).toEqual(['confirmed']);
    });

    it('staff, UI and MCP get a plain tenant-scoped lookup by phone, with optional filters', async () => {
      const shop = await seedShop('find-staff');
      const thu = await booking(shop, edt(22, '10:00'));
      const fri = await booking(shop, edt(23, '13:00'), { contact_name: 'Mateo' });
      const staff = ctx(shop.tenantId, { actor: STAFF, callId: undefined });
      expect(await find(staff, { phone: '555-555-0142' })).toMatchObject({ verified: true, bookings: [{ bookingId: thu }, { bookingId: fri }] });
      expect(ids(await find(staff, { phone: PHONE, name: 'Mateo' }))).toEqual([fri]);
      expect(ids(await find(staff, { phone: PHONE, date: '2026-10-22', time: '10:00' }))).toEqual([thu]);
      const reader = ctx(shop.tenantId, { actor: { type: 'mcp', id: 'bot', scopes: ['qvo:read'] }, callId: undefined });
      expect(ids(await find(reader, { phone: PHONE }))).toEqual([thu, fri]);
      const noScope = ctx(shop.tenantId, { actor: { type: 'mcp', id: 'bot', scopes: [] } });
      expect(errorOf(await act('scheduling.find_bookings', noScope, { phone: PHONE })).code).toBe('FORBIDDEN');
      expect(errorOf(await act('scheduling.find_bookings', staff, { phone: '12345' }))).toMatchObject({ code: 'VALIDATION_FAILED', field: 'phone' });
      expect(errorOf(await act('scheduling.find_bookings', staff, { phone: PHONE, time: '3:30 PM' }))).toMatchObject({ code: 'VALIDATION_FAILED', field: 'time' });
    });

    describe('agent reschedule / cancel', () => {
      it('moves and cancels after a verified find in the same call', async () => {
        const shop = await seedShop('agent-happy');
        const thu = await booking(shop, edt(22, '10:00'));
        const fri = await booking(shop, edt(23, '10:00'));
        const c = agentIn(shop, await call(shop.tenantId, PHONE));
        expect(ids(await find(c, { phone: PHONE, name: 'Luis' }))).toEqual([thu, fri]);

        const p = data<{ confirmationToken: string; holdId: string; readback: string }>(
          await act('scheduling.reschedule.prepare', c, { bookingId: thu, newStart: edt(22, '14:00') }),
        );
        expect(p.readback).toBe("Moving Luis's Men's cut from Thursday at 10 AM with Marco to Thursday at 2 PM with Marco.");
        expect(data(await act('scheduling.reschedule.commit', c, { confirmationToken: p.confirmationToken }))).toMatchObject({
          bookingId: p.holdId,
          previousBookingId: thu,
          status: 'confirmed',
          start: '2026-10-22T18:00:00.000Z',
          readback: "Done: Luis's Men's cut is now Thursday at 2 PM with Marco.",
        });

        const cp = data<{ confirmationToken: string; readback: string }>(await act('scheduling.cancel.prepare', c, { bookingId: fri, reason: 'Out of town' }));
        expect(cp.readback).toBe("Cancelling Luis's Men's cut with Marco, Friday at 10 AM.");
        expect(data(await act('scheduling.cancel.commit', c, { confirmationToken: cp.confirmationToken }))).toMatchObject({
          bookingId: fri,
          status: 'cancelled',
          readback: "Cancelled: Luis's Men's cut with Marco, Friday at 10 AM.",
        });

        const rows = await bookingRows(shop.tenantId);
        expect(rows.find((r) => r.id === thu)).toMatchObject({ status: 'rescheduled' });
        expect(rows.find((r) => r.id === p.holdId)).toMatchObject({ status: 'confirmed', booking_source: 'ai_agent', contact_phone: PHONE });
        expect(rows.find((r) => r.id === fri)).toMatchObject({ status: 'cancelled', cancellation_reason: 'Out of town' });
      });

      it('refuses a guessed id, one verified in another call, and an agent without a callId, exactly like an unknown id', async () => {
        const shop = await seedShop('agent-refuse');
        const thu = await booking(shop, edt(22, '10:00'));
        const unknown = errorOf(await act('scheduling.cancel.prepare', agentIn(shop, await call(shop.tenantId, PHONE)), { bookingId: 'nope' }));
        expect(unknown).toMatchObject({ code: 'NOT_FOUND', message: 'Booking not found', field: 'bookingId', callerSafeMessage: "I couldn't find that appointment." });
        const refusedBoth = async (c: ActionContext) => {
          expect(errorOf(await act('scheduling.reschedule.prepare', c, { bookingId: thu, newStart: edt(23, '14:00') }))).toEqual(unknown);
          expect(errorOf(await act('scheduling.cancel.prepare', c, { bookingId: thu }))).toEqual(unknown);
        };

        // Guessed: this call never found it, and an unverified find records nothing.
        const guess = agentIn(shop, await call(shop.tenantId, PHONE));
        await refusedBoth(guess);
        expect(await find(guess, { phone: PHONE, name: 'Ana' })).toEqual(FIRST_NAME_ASK);
        await refusedBoth(guess);

        // Verified in call 1; call 2 (same caller, same tenant) and no callId can't use it.
        const call1 = agentIn(shop, await call(shop.tenantId, PHONE));
        expect(ids(await find(call1, { phone: PHONE, name: 'Luis' }))).toEqual([thu]);
        await refusedBoth(agentIn(shop, await call(shop.tenantId, PHONE)));
        await refusedBoth(agentIn(shop, undefined));
        // The verification lasts the call, not forever.
        await refusedBoth({ ...call1, now: new Date(NOW.getTime() + minutes(61)) });

        // The token stays bound to call 1: not another call, not a callId-less agent.
        const p = data<{ confirmationToken: string }>(await act('scheduling.cancel.prepare', call1, { bookingId: thu }));
        const other = errorOf(await act('scheduling.cancel.commit', agentIn(shop, 'CA-other'), { confirmationToken: p.confirmationToken }));
        expect(['CONFIRMATION_INVALID', 'IDEMPOTENCY_KEY_REUSED']).toContain(other.code);
        const noCall = errorOf(await act('scheduling.cancel.commit', agentIn(shop, undefined), { confirmationToken: p.confirmationToken }));
        expect(['CONFIRMATION_INVALID', 'IDEMPOTENCY_KEY_REUSED']).toContain(noCall.code);
        expect(await bookingRows(shop.tenantId)).toMatchObject([{ id: thu, status: 'confirmed' }]);
        // Call 1 itself still can.
        expect(data(await act('scheduling.cancel.commit', call1, { confirmationToken: p.confirmationToken }))).toMatchObject({ status: 'cancelled' });
      });

      it('refuses a verified booking once staff change its contact name or phone; an unchanged one still works', async () => {
        const shop = await seedShop('agent-reassigned');
        const named = await booking(shop, edt(22, '10:00'));
        const phoned = await booking(shop, edt(23, '10:00'));
        const kept = await booking(shop, edt(24, '10:00'));
        const c = agentIn(shop, await call(shop.tenantId, PHONE));
        expect(ids(await find(c, { phone: PHONE, name: 'Luis' }))).toEqual([named, phoned, kept]);
        // The verification row carries no raw name or phone.
        const { rows: proofs } = await pool.query(`SELECT payload::text AS p FROM action_proposals WHERE tenant_id = $1 AND action = 'scheduling.find_bookings'`, [shop.tenantId]);
        expect(proofs).toHaveLength(1);
        expect(proofs[0].p).not.toMatch(/Luis|5555550142/);

        // Staff edit the bookings the way the admin update route does: same id, new contact.
        await pool.query(`UPDATE bookings SET contact_name = 'Ana Ruiz' WHERE id = $1`, [named]);
        await pool.query(`UPDATE bookings SET contact_phone = '+15555550188' WHERE id = $1`, [phoned]);
        const unknown = errorOf(await act('scheduling.cancel.prepare', c, { bookingId: 'nope' }));
        for (const id of [named, phoned]) {
          expect(errorOf(await act('scheduling.cancel.prepare', c, { bookingId: id }))).toEqual(unknown);
          expect(errorOf(await act('scheduling.reschedule.prepare', c, { bookingId: id, newStart: edt(26, '14:00') }))).toEqual(unknown);
        }
        // A cosmetic edit that keeps the same phone digits and name still counts.
        await pool.query(`UPDATE bookings SET contact_phone = '(555) 555-0142', contact_name = 'LUIS' WHERE id = $1`, [kept]);
        expect(data(await act('scheduling.cancel.prepare', c, { bookingId: kept }))).toMatchObject({ confirmationToken: expect.any(String) });
        expect((await bookingRows(shop.tenantId)).map((r) => r.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
      });

      it('refuses an agent commit once staff change the contact name or phone after the prepare; unchanged and staff commits go through', async () => {
        const shop = await seedShop('agent-commit-identity');
        const cancelRenamed = await booking(shop, edt(21, '10:00'));
        const cancelRephoned = await booking(shop, edt(22, '10:00'));
        const moveRenamed = await booking(shop, edt(23, '10:00'));
        const moveRephoned = await booking(shop, edt(24, '10:00'));
        const cancelKept = await booking(shop, edt(26, '10:00'));
        const moveKept = await booking(shop, edt(26, '11:00'));
        const c = agentIn(shop, await call(shop.tenantId, PHONE));
        expect(ids(await find(c, { phone: PHONE, name: 'Luis' }))).toHaveLength(6);
        const changed = {
          code: 'CONFLICT',
          callerSafeMessage: 'That appointment was just changed by the shop. I can check it again or take a message.',
        };
        const snapshot = async (id: string) => (await bookingRows(shop.tenantId)).find((r) => r.id === id);

        // Cancel: staff edit the contact between the agent's prepare and the caller's yes.
        for (const [id, edit] of [[cancelRenamed, `contact_name = 'Ana Ruiz'`], [cancelRephoned, `contact_phone = '+15555550188'`]]) {
          const p = data<{ confirmationToken: string }>(await act('scheduling.cancel.prepare', c, { bookingId: id }));
          await pool.query(`UPDATE bookings SET ${edit} WHERE id = $1`, [id]);
          const before = await snapshot(id);
          expect(errorOf(await act('scheduling.cancel.commit', c, { confirmationToken: p.confirmationToken }))).toMatchObject(changed);
          expect(await snapshot(id)).toEqual(before);
          expect(before).toMatchObject({ status: 'confirmed' });
        }

        // Reschedule: same, and the held new time is never confirmed.
        for (const [id, edit, to] of [
          [moveRenamed, `contact_name = 'Ana Ruiz'`, edt(23, '14:00')],
          [moveRephoned, `contact_phone = '+15555550188'`, edt(24, '14:00')],
        ]) {
          const p = data<{ confirmationToken: string; holdId: string }>(await act('scheduling.reschedule.prepare', c, { bookingId: id, newStart: to }));
          await pool.query(`UPDATE bookings SET ${edit} WHERE id = $1`, [id]);
          const before = await snapshot(id);
          expect(errorOf(await act('scheduling.reschedule.commit', c, { confirmationToken: p.confirmationToken }))).toMatchObject(changed);
          expect(await snapshot(id)).toEqual(before);
          expect(before).toMatchObject({ status: 'confirmed' });
          expect((await snapshot(p.holdId))?.status).not.toBe('confirmed');
        }
        const confirmed = (await bookingRows(shop.tenantId)).filter((r) => r.status === 'confirmed').map((r) => r.id);
        expect(confirmed.sort()).toEqual([cancelRenamed, cancelRephoned, moveRenamed, moveRephoned, cancelKept, moveKept].sort());

        // Unchanged (or only a cosmetic edit of the same digits and name): the agent commit goes through.
        const cp = data<{ confirmationToken: string }>(await act('scheduling.cancel.prepare', c, { bookingId: cancelKept }));
        await pool.query(`UPDATE bookings SET contact_phone = '(555) 555-0142', contact_name = 'LUIS' WHERE id = $1`, [cancelKept]);
        expect(data(await act('scheduling.cancel.commit', c, { confirmationToken: cp.confirmationToken }))).toMatchObject({ bookingId: cancelKept, status: 'cancelled' });
        const mp = data<{ confirmationToken: string; holdId: string }>(await act('scheduling.reschedule.prepare', c, { bookingId: moveKept, newStart: edt(26, '14:00') }));
        expect(data(await act('scheduling.reschedule.commit', c, { confirmationToken: mp.confirmationToken }))).toMatchObject({
          bookingId: mp.holdId,
          previousBookingId: moveKept,
          status: 'confirmed',
        });

        // A staff (MCP admin) commit is not identity-checked: an edit between its prepare and commit is fine.
        const admin = ctx(shop.tenantId, { actor: ADMIN_BOT, callId: undefined });
        const sp = data<{ confirmationToken: string }>(await act('scheduling.cancel.prepare', admin, { bookingId: cancelRenamed }));
        const sm = data<{ confirmationToken: string; holdId: string }>(await act('scheduling.reschedule.prepare', admin, { bookingId: moveRenamed, newStart: edt(23, '15:00') }));
        await pool.query(`UPDATE bookings SET contact_name = 'Ana Ruiz Lopez' WHERE id = ANY($1)`, [[cancelRenamed, moveRenamed]]);
        expect(data(await act('scheduling.cancel.commit', admin, { confirmationToken: sp.confirmationToken }))).toMatchObject({ status: 'cancelled' });
        expect(data(await act('scheduling.reschedule.commit', admin, { confirmationToken: sm.confirmationToken }))).toMatchObject({ previousBookingId: moveRenamed, status: 'confirmed' });

        const rows = await bookingRows(shop.tenantId);
        const statusOf = (id: string) => rows.find((r) => r.id === id)?.status;
        expect([cancelRenamed, cancelRephoned, moveRenamed, moveRephoned, cancelKept, moveKept].map(statusOf))
          .toEqual(['cancelled', 'confirmed', 'rescheduled', 'confirmed', 'cancelled', 'rescheduled']);
      });

      it('keeps the policy: OUTSIDE_POLICY inside the cancellation window and once the time has passed', async () => {
        const shop = await seedShop('agent-policy');
        const imminent = await booking(shop, edt(19, '08:20'), { provider_id: shop.andre }); // 20 minutes away
        const soon = await booking(shop, edt(19, '15:00')); // 7 hours away; window 24 h
        const c = agentIn(shop, await call(shop.tenantId, PHONE));
        expect(ids(await find(c, { phone: PHONE, name: 'Luis' }))).toEqual([imminent, soon]);

        const policy = "The shop's policy needs at least 24 hours' notice to change or cancel an appointment. I can take a message for the shop.";
        expect(errorOf(await act('scheduling.reschedule.prepare', c, { bookingId: soon, newStart: edt(23, '14:00') }))).toMatchObject({ code: 'OUTSIDE_POLICY', callerSafeMessage: policy });
        expect(errorOf(await act('scheduling.cancel.prepare', c, { bookingId: soon }))).toMatchObject({ code: 'OUTSIDE_POLICY', callerSafeMessage: policy });
        const es = errorOf(await act('scheduling.cancel.prepare', { ...c, locale: 'es' }, { bookingId: soon }));
        expect(es.callerSafeMessage).toMatch(/^La política del negocio pide al menos 24 horas de aviso.+Puedo dejarle un mensaje al negocio\.$/);

        // Later in the same call the 8:20 has started.
        const later = { ...c, now: new Date(NOW.getTime() + minutes(25)) };
        const passed = "That appointment has already started or passed, so I can't change it. I can take a message for the shop.";
        expect(errorOf(await act('scheduling.reschedule.prepare', later, { bookingId: imminent, newStart: edt(23, '14:00') }))).toMatchObject({ code: 'OUTSIDE_POLICY', callerSafeMessage: passed });
        expect(errorOf(await act('scheduling.cancel.prepare', later, { bookingId: imminent }))).toMatchObject({ code: 'OUTSIDE_POLICY', callerSafeMessage: passed });
        expect((await live(shop.tenantId)).map((r) => r.id)).toEqual([imminent, soon]);
      });

      it('reschedule into a taken slot returns CONFLICT with alternatives and moves nothing', async () => {
        const shop = await seedShop('agent-taken');
        const thu = await booking(shop, edt(22, '10:00'));
        await booking(shop, edt(23, '14:00'), { contact_name: 'Ana', contact_phone: '+15555550188' });
        const c = agentIn(shop, await call(shop.tenantId, PHONE));
        expect(ids(await find(c, { phone: PHONE, name: 'Luis' }))).toEqual([thu]);
        const taken = errorOf(await act('scheduling.reschedule.prepare', c, { bookingId: thu, newStart: edt(23, '14:00') }));
        expect(taken.code).toBe('CONFLICT');
        expect(taken.callerSafeMessage).toBe("That time isn't available. I can offer the closest open times.");
        const alternatives = taken.alternatives as Array<{ start: string; staffId: string; spoken: string }>;
        expect(alternatives.length).toBeGreaterThan(0);
        expect(alternatives.map((a) => a.start)).not.toContain('2026-10-23T18:00:00.000Z');
        expect((await live(shop.tenantId)).map((r) => [r.id === thu, r.status])).toEqual([[true, 'confirmed'], [false, 'confirmed']]);
      });

      it('reads find, reschedule and cancel back in Spanish for an es call', async () => {
        const shop = await seedShop('agent-es');
        const thu = await booking(shop, edt(22, '10:00'));
        const fri = await booking(shop, edt(23, '10:00'));
        const es = agentIn(shop, await call(shop.tenantId, PHONE), { locale: 'es' });
        const found = await find(es, { phone: PHONE, name: 'Luis' });
        expect(found.bookings[0].spoken).toMatch(/^Men's cut con Marco, .*jueves.*10.*, para Luis\.$/);

        const p = data<{ confirmationToken: string; readback: string }>(await act('scheduling.reschedule.prepare', es, { bookingId: thu, newStart: edt(22, '14:00') }));
        expect(p.readback).toMatch(/^Vamos a mover la cita de Luis, Men's cut, de .*jueves.* con Marco a .*jueves.* con Marco\.$/);
        const moved = data<{ readback: string }>(await act('scheduling.reschedule.commit', es, { confirmationToken: p.confirmationToken }));
        expect(moved.readback).toMatch(/^Listo: la cita de Luis, Men's cut, ahora es .*jueves.* con Marco\.$/);

        const cp = data<{ confirmationToken: string; readback: string }>(await act('scheduling.cancel.prepare', es, { bookingId: fri }));
        expect(cp.readback).toMatch(/^Vamos a cancelar la cita de Luis, Men's cut con Marco, .*viernes.*\.$/);
        const cancelled = data<{ readback: string }>(await act('scheduling.cancel.commit', es, { confirmationToken: cp.confirmationToken }));
        expect(cancelled.readback).toMatch(/^Cancelada: la cita de Luis, Men's cut con Marco, .*viernes.*\.$/);
        const unknown = errorOf(await act('scheduling.cancel.prepare', es, { bookingId: 'nope' }));
        expect(unknown.callerSafeMessage).toBe('No encontré esa cita.');
      });
    });
  });

  describe('tenant isolation', () => {
    it("can't prepare, commit, reschedule or cancel with another tenant's ids", async () => {
      const a = await seedShop('iso-a');
      const b = await seedShop('iso-b');
      const bHold = data<{ confirmationToken: string; holdId: string }>(await act('scheduling.book.prepare', ctx(b.tenantId), bookInput(b, edt(20, '10:00'))));
      const bBooking = await confirmedBooking(b, edt(22, '10:00'), { callId: 'CA-b2' });
      const before = await bookingRows(b.tenantId);

      expect(errorOf(await act('scheduling.book.prepare', ctx(a.tenantId), bookInput(a, edt(20, '10:00'), { serviceIds: [b.cut] }))).code).toBe('VALIDATION_FAILED');
      expect(errorOf(await act('scheduling.book.prepare', ctx(a.tenantId), bookInput(a, edt(20, '10:00'), { staffId: b.marco }))).code).toBe('NOT_FOUND');
      expect(errorOf(await act('scheduling.book.commit', ctx(a.tenantId), { confirmationToken: bHold.confirmationToken })).code).toBe('CONFIRMATION_INVALID');
      const admin = ctx(a.tenantId, { actor: ADMIN_BOT });
      expect(errorOf(await act('scheduling.reschedule.prepare', admin, { bookingId: bBooking, newStart: edt(23, '10:00') })).code).toBe('NOT_FOUND');
      expect(errorOf(await act('scheduling.cancel.prepare', admin, { bookingId: bBooking })).code).toBe('NOT_FOUND');

      expect(await bookingRows(b.tenantId)).toEqual(before);
      expect(await bookingRows(a.tenantId)).toEqual([]);
      // B can still commit its own hold.
      expect((await act('scheduling.book.commit', ctx(b.tenantId), { confirmationToken: bHold.confirmationToken })).ok).toBe(true);
    });
  });

  describe('concurrency', () => {
    it('two concurrent prepares for the same staff and slot: exactly one held, the other CONFLICT (23P01)', async () => {
      const shop = await seedShop('race');
      // Hold each transaction open after its insert so both pass the engine
      // check before either commits; the exclusion constraint decides.
      const slowTx = async <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
        withTenantTx(tenantId, async (tx) => {
          const result = await fn(tx);
          await new Promise((resolve) => setTimeout(resolve, 150));
          return result;
        });
      const results = await Promise.all(
        ['CA-x', 'CA-y'].map((callId, i) =>
          act('scheduling.book.prepare', ctx(shop.tenantId, { callId }), bookInput(shop, edt(20, '10:00'), {
            customer: { name: i === 0 ? 'Luis' : 'Ana', phone: i === 0 ? '+15555550142' : '+15555550188' },
          }), slowTx),
        ),
      );
      const codes = results.map((r) => (r.ok ? 'ok' : r.error.code)).sort();
      expect(codes).toEqual(['CONFLICT', 'ok']);
      const loser = results.find((r) => !r.ok)!;
      // Both passed the engine check; the exclusion constraint (23P01) picked the loser.
      expect(errorOf(loser).message).toBe('Slot was just taken (provider overlap)');
      expect(errorOf(loser).callerSafeMessage).toBe('That time was just taken. I can offer the closest open times.');
      expect((errorOf(loser).alternatives as Array<{ start: string }>).map((a) => a.start)).not.toContain('2026-10-20T14:00:00.000Z');
      const held = await live(shop.tenantId);
      expect(held.map((r) => r.status)).toEqual(['held']);
    });

    describe('hold sweeper vs commit', () => {
      // Clock in the past so the database's NOW() (which the sweeper uses)
      // sees the hold as expired while the action clock still sees it live.
      const PAST = new Date('2020-10-19T12:00:00Z'); // Mon Oct 19 2020, 8:00 AM EDT
      const pastCtx = (shop: Shop, extra: Partial<ActionContext> = {}) => ctx(shop.tenantId, { now: PAST, ...extra });
      const pastInput = (shop: Shop) => bookInput(shop, '2020-10-20T10:00:00-04:00');

      function sweepDeps(): HoldSweepDeps {
        return {
          findStaleGroups: async (limit) => {
            const { rows } = await pool.query(
              `SELECT tenant_id, provider_id, resource_id FROM bookings
                WHERE status = 'held' AND hold_expires_at <= NOW()
                GROUP BY tenant_id, provider_id, resource_id LIMIT $1`,
              [limit],
            );
            return rows.map((r) => ({ tenantId: r.tenant_id, providerId: r.provider_id, resourceId: r.resource_id }));
          },
          withTenantTx,
          logger: { info: () => {}, error: () => {} },
        };
      }

      it('never cancels a row that a commit confirmed while the sweep was waiting on it', async () => {
        const shop = await seedShop('sweeprace');
        const p = data<{ confirmationToken: string; holdId: string }>(await act('scheduling.book.prepare', pastCtx(shop), pastInput(shop)));
        const pending: { sweep?: ReturnType<typeof runHoldSweepCycle> } = {};
        // The commit has confirmed (and locked) the row; start the sweep
        // before it commits. The sweep saw the row as held/expired, blocks on
        // the row lock, then re-checks status = 'held' and skips it.
        const commitThenSweep = async <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
          const client: PoolClient = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SET LOCAL ROLE platform_rls_tester');
            await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
            const result = await fn(client as unknown as TenantTx);
            pending.sweep = runHoldSweepCycle(sweepDeps());
            await new Promise((resolve) => setTimeout(resolve, 200));
            await client.query('COMMIT');
            return result;
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        };
        const committed = await act('scheduling.book.commit', pastCtx(shop, { now: new Date(PAST.getTime() + minutes(1)) }), { confirmationToken: p.confirmationToken }, commitThenSweep);
        expect(committed.ok).toBe(true);
        const swept = await pending.sweep!;
        // It did see this hold as stale, and still released nothing of it.
        expect(swept.groups).toBeGreaterThanOrEqual(1);
        expect(swept.failed).toBe(0);
        const rows = await bookingRows(shop.tenantId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: p.holdId, status: 'confirmed', hold_expires_at: null });
      });

      it('a commit after the sweep re-takes the slot; a sweep after the commit finds nothing', async () => {
        const shop = await seedShop('sweepseq');
        const p = data<{ confirmationToken: string; holdId: string }>(await act('scheduling.book.prepare', pastCtx(shop), pastInput(shop)));
        const swept = await runHoldSweepCycle(sweepDeps());
        expect(swept.released).toBeGreaterThanOrEqual(1);
        expect((await bookingRows(shop.tenantId))[0]).toMatchObject({ status: 'cancelled', cancellation_reason: 'hold_expired' });

        const committed = await act('scheduling.book.commit', pastCtx(shop, { now: new Date(PAST.getTime() + minutes(1)) }), { confirmationToken: p.confirmationToken });
        expect(committed).toMatchObject({ ok: true, data: { bookingId: p.holdId, status: 'confirmed' } });
        await runHoldSweepCycle(sweepDeps());
        const rows = await bookingRows(shop.tenantId);
        expect(rows.map((r) => r.status)).toEqual(['confirmed']);
      });

      const at = (minute: number) => new Date(PAST.getTime() + minutes(minute));

      it('a correction supersedes a hold the sweeper already expired; its stale token never re-takes it', async () => {
        const shop = await seedShop('sweepfix');
        const a = data<{ confirmationToken: string; holdId: string }>(
          await act('scheduling.book.prepare', pastCtx(shop), bookInput(shop, '2020-10-20T15:30:00-04:00')),
        );
        expect((await runHoldSweepCycle(sweepDeps())).released).toBeGreaterThanOrEqual(1);
        expect((await bookingRows(shop.tenantId))[0]).toMatchObject({ id: a.holdId, status: 'cancelled', cancellation_reason: 'hold_expired' });

        const b = data<{ confirmationToken: string; holdId: string; replacedHoldIds: string[] }>(
          await act('scheduling.book.prepare', pastCtx(shop, { now: at(6) }), bookInput(shop, '2020-10-20T16:30:00-04:00')),
        );
        expect(b.replacedHoldIds).toEqual([a.holdId]);
        expect((await bookingRows(shop.tenantId)).find((r) => r.id === a.holdId)).toMatchObject({ status: 'cancelled', cancellation_reason: 'hold_superseded' });

        data(await act('scheduling.book.commit', pastCtx(shop, { now: at(7) }), { confirmationToken: b.confirmationToken }));
        const stale = errorOf(await act('scheduling.book.commit', pastCtx(shop, { now: at(8) }), { confirmationToken: a.confirmationToken }));
        expect(stale.code).toBe('CONFIRMATION_INVALID');
        const confirmed = (await bookingRows(shop.tenantId)).filter((r) => r.status === 'confirmed');
        expect(confirmed.map((r) => [r.id, r.start_time.toISOString()])).toEqual([[b.holdId, '2020-10-20T20:30:00.000Z']]);
      });

      it("a correction supersedes a hold another prepare's expireStaleHolds expired; its stale token never re-takes it", async () => {
        const shop = await seedShop('expirefix');
        const a = data<{ confirmationToken: string; holdId: string }>(
          await act('scheduling.book.prepare', pastCtx(shop), bookInput(shop, '2020-10-20T15:30:00-04:00')),
        );
        // Another caller's prepare for the same staff expires my stale hold.
        data(await act('scheduling.book.prepare', pastCtx(shop, { callId: 'CA-2', now: at(6) }), bookInput(shop, '2020-10-20T11:00:00-04:00', {
          customer: { name: 'Ana', phone: '+15555550188' },
        })));
        expect((await bookingRows(shop.tenantId)).find((r) => r.id === a.holdId)).toMatchObject({ status: 'cancelled', cancellation_reason: 'hold_expired' });

        const b = data<{ confirmationToken: string; holdId: string; replacedHoldIds: string[] }>(
          await act('scheduling.book.prepare', pastCtx(shop, { now: at(7) }), bookInput(shop, '2020-10-20T16:30:00-04:00')),
        );
        expect(b.replacedHoldIds).toEqual([a.holdId]);
        data(await act('scheduling.book.commit', pastCtx(shop, { now: at(8) }), { confirmationToken: b.confirmationToken }));
        const stale = errorOf(await act('scheduling.book.commit', pastCtx(shop, { now: at(9) }), { confirmationToken: a.confirmationToken }));
        expect(stale.code).toBe('CONFIRMATION_INVALID');
        const rows = await bookingRows(shop.tenantId);
        expect(rows.find((r) => r.id === a.holdId)).toMatchObject({ status: 'cancelled', cancellation_reason: 'hold_superseded' });
        expect(rows.filter((r) => r.status === 'confirmed').map((r) => r.id)).toEqual([b.holdId]);
      });

      it('refuses the re-take when a newer prepare exists in the call, even if a late sweep re-marked the hold hold_expired', async () => {
        const shop = await seedShop('sweeplate');
        const a = data<{ confirmationToken: string; holdId: string }>(
          await act('scheduling.book.prepare', pastCtx(shop), bookInput(shop, '2020-10-20T15:30:00-04:00')),
        );
        const b = data<{ holdId: string }>(
          await act('scheduling.book.prepare', pastCtx(shop, { now: at(6) }), bookInput(shop, '2020-10-20T16:30:00-04:00')),
        );
        // Whatever the release/sweep ordering, the row ends up looking lapsed.
        await pool.query(`UPDATE bookings SET status = 'cancelled', cancellation_reason = 'hold_expired' WHERE id = $1`, [a.holdId]);
        const stale = errorOf(await act('scheduling.book.commit', pastCtx(shop, { now: at(7) }), { confirmationToken: a.confirmationToken }));
        expect(stale.code).toBe('CONFIRMATION_INVALID');
        const rows = await bookingRows(shop.tenantId);
        expect(rows.find((r) => r.id === a.holdId)).toMatchObject({ status: 'cancelled', cancellation_reason: 'hold_expired' });
        expect(rows.filter((r) => r.status === 'held' || r.status === 'confirmed').map((r) => r.id)).toEqual([b.holdId]);
      });
    });
  });
});
