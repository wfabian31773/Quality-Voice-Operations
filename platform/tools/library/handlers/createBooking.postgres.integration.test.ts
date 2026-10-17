// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createScratchDatabase, probePostgres, type ScratchDatabase } from '../../testing/scratchPostgres';

// The handlers check out clients from getPlatformPool(); point it at the
// scratch database's RLS-bound pool (NOBYPASSRLS role, app.tenant_id set by
// the handler's own withTenantContext).
const h = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock('../../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db')>()),
  getPlatformPool: () => {
    if (!h.pool) throw new Error('scratch pool not ready');
    return h.pool;
  },
}));

const { executeCreateBooking, executeUpdateBooking } = await import('./createBooking');
const { resetBookingConfirmations } = await import('./bookingConfirmation');

const dbReachable = await probePostgres();

const CALLER = '+15555550142';

describe.skipIf(!dbReachable)('legacy create_booking / update_booking against real Postgres', () => {
  let db: ScratchDatabase;
  let tenantId: string;
  let otherTenantId: string;

  async function insertTenant(label: string, timezone: string): Promise<string> {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO tenants (id, name, slug, status, timezone) VALUES ($1, $2, $3, 'active', $4)`,
      [id, label, `${label.toLowerCase()}-${id.slice(0, 8)}`, timezone],
    );
    return id;
  }

  beforeAll(async () => {
    db = await createScratchDatabase('qvo_callfix_booking');
    h.pool = db.app;
    tenantId = await insertTenant('Sharp', 'America/Chicago');
    otherTenantId = await insertTenant('Other', 'America/New_York');
  }, 600_000);

  afterAll(async () => {
    h.pool = null;
    await db?.drop();
  }, 60_000);

  it('confirms the app pool cannot bypass RLS', async () => {
    const { rows } = await db.app.query(`SELECT current_user AS role, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(rows[0]).toEqual({ role: 'platform_rls_tester', rolbypassrls: false });
  });

  it('stores a pending booking with the tenant timezone (the live-call insert)', async () => {
    const result = await executeCreateBooking({
      title: 'Fade',
      startTime: '2026-10-24T09:00:00',
      durationMinutes: 45,
      contactName: 'Wayne',
      contactPhone: CALLER,
      notes: 'Saturday morning',
    }, { tenantId, callLogId: 'call-1', callerNumber: CALLER });

    expect(result).toMatchObject({ success: true });
    expect(result.bookingId).toEqual(expect.any(String));

    const { rows } = await db.admin.query(
      `SELECT tenant_id, title, status, contact_name, contact_phone, booking_source, timezone, start_time, end_time
         FROM bookings WHERE id = $1`,
      [result.bookingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: tenantId,
      title: 'Fade',
      status: 'pending',
      contact_name: 'Wayne',
      contact_phone: CALLER,
      booking_source: 'ai_agent',
      timezone: 'America/Chicago',
    });
    // Wall clock 09:00 in America/Chicago (CDT, UTC-5) → 14:00Z, 45 minutes long.
    expect(new Date(rows[0].start_time).toISOString()).toBe('2026-10-24T14:00:00.000Z');
    expect(new Date(rows[0].end_time).toISOString()).toBe('2026-10-24T14:45:00.000Z');
  });

  it('fills the caller ID when the model passes an empty or caller-ID phrase contactPhone', async () => {
    for (const contactPhone of ['', 'calling number']) {
      const result = await executeCreateBooking({
        title: 'Haircut',
        startTime: '2026-10-24T10:00:00-05:00',
        contactName: 'Wayne',
        contactPhone,
      }, { tenantId, callLogId: 'call-2', callerNumber: CALLER });
      expect(result).toMatchObject({ success: true });
      const { rows } = await db.admin.query(`SELECT contact_phone FROM bookings WHERE id = $1`, [result.bookingId]);
      expect(rows[0].contact_phone).toBe(CALLER);
    }
  });

  it('marks a validation failure as not retryable and writes nothing', async () => {
    const before = await db.admin.query(`SELECT count(*)::int AS n FROM bookings`);
    const result = await executeCreateBooking({
      title: 'Fade', startTime: 'next saturday-ish', contactName: 'Wayne', contactPhone: CALLER,
    }, { tenantId, callLogId: 'call-3', callerNumber: CALLER });
    expect(result).toMatchObject({ success: false, retryable: false });
    const after = await db.admin.query(`SELECT count(*)::int AS n FROM bookings`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('runs update_booking\'s caller lookup and cancels through the lifecycle', async () => {
    resetBookingConfirmations();
    const created = await executeCreateBooking({
      title: 'Beard trim', startTime: '2030-03-05T11:00:00', contactName: 'Wayne', contactPhone: CALLER,
    }, { tenantId, callLogId: 'call-4', callerNumber: CALLER });
    expect(created.success).toBe(true);
    // Another tenant's booking from the same phone stays invisible (RLS + tenant filter).
    await db.admin.query(
      `INSERT INTO bookings (tenant_id, title, start_time, end_time, status, contact_phone)
       VALUES ($1, 'Other shop', '2030-03-06T15:00:00Z', '2030-03-06T15:30:00Z', 'confirmed', $2)`,
      [otherTenantId, CALLER],
    );

    const ctx = { tenantId, callLogId: 'call-5', callerNumber: CALLER, transcriptTurnIndex: 3 };
    // The caller has several upcoming bookings from the tests above, so
    // name the one to change.
    const challenge = await executeUpdateBooking({ action: 'cancel', bookingId: created.bookingId }, ctx);
    expect(challenge).toMatchObject({ success: true, pending: true, status: 'needs_confirmation', bookingId: created.bookingId });
    expect(challenge.candidates?.every((c) => c.title !== 'Other shop')).toBe(true);

    const done = await executeUpdateBooking(
      { action: 'cancel', bookingId: created.bookingId, confirmationToken: challenge.confirmationToken },
      { ...ctx, transcriptTurnIndex: 4 },
    );
    expect(done).toMatchObject({ success: true, status: 'updated', bookingId: created.bookingId });
    const { rows } = await db.admin.query(`SELECT status FROM bookings WHERE id = $1`, [created.bookingId]);
    expect(rows[0].status).toBe('cancelled');
  });

  it('reschedules through the lifecycle and keeps the request pending', async () => {
    resetBookingConfirmations();
    const created = await executeCreateBooking({
      title: 'Kids cut', startTime: '2030-03-12T15:00:00', contactName: 'Wayne', contactPhone: CALLER,
    }, { tenantId, callLogId: 'call-6', callerNumber: CALLER });
    const ctx = { tenantId, callLogId: 'call-7', callerNumber: CALLER, transcriptTurnIndex: 1 };
    const input = { action: 'reschedule', bookingId: created.bookingId, startTime: '2030-03-13T15:00:00' };
    const challenge = await executeUpdateBooking(input, ctx);
    expect(challenge.status).toBe('needs_confirmation');
    const done = await executeUpdateBooking(
      { ...input, confirmationToken: challenge.confirmationToken },
      { ...ctx, transcriptTurnIndex: 2 },
    );
    expect(done).toMatchObject({ success: true, status: 'updated' });
    const { rows } = await db.admin.query(
      `SELECT status, start_time FROM bookings WHERE tenant_id = $1 AND title = 'Kids cut' ORDER BY start_time`,
      [tenantId],
    );
    expect(rows.map((r) => r.status)).toEqual(['rescheduled', 'pending']);
    expect(new Date(rows[1].start_time).toISOString()).toBe('2030-03-13T20:00:00.000Z');
  });
});
