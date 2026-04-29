/**
 * Coverage for the appointment lifecycle event fan-out wired into the
 * admin scheduling routes.
 *
 * The connector ledger inside `ConnectorService` stamps a row keyed by
 * `appointmentId` (or `callerPhone+startTime`, or `callSid`) the first
 * time a booking is dispatched to a scheduling integration. When that
 * booking later changes — rescheduled into a new slot, cancelled, or
 * marked no-show via the admin API — the ledger must be told so the
 * very same calendar that received the booking gets the update.
 *
 * Without these dispatches an admin-side reschedule would silently leave
 * the original calendar event in place and customers would walk into a
 * stale slot. This file proves the lifecycle endpoints fire
 * `connectorService.dispatchEvent` with identifiers the ledger can
 * resolve, and that a reschedule lands ONLY in the original calendar
 * (not broadcast to every scheduling integration).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

// Mocks created via `vi.hoisted` are guaranteed to be initialized before
// any `vi.mock` factory runs (factories are hoisted to the top of the
// file, so closing over a regular `const` would dereference `undefined`).
const { queryMock, dispatchEventMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  dispatchEventMock: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      email: 'admin@acme.test',
      role: 'tenant_owner',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// The technician-push pipeline is unrelated to the calendar dispatch we
// are exercising — stub it to a no-op so the test does not need to mock
// the device-token tables.
vi.mock('../../platform/notifications/dispatchPush', () => ({
  fireDispatchPush: vi.fn(),
}));

vi.mock('../../platform/integrations/connectors', () => ({
  connectorService: {
    dispatchEvent: dispatchEventMock,
  },
}));

import schedulingRouter from '../../server/admin-api/routes/scheduling';

const TENANT = 'tenant-1';
const PROVIDER_A = 'prov-a';
const AGENT_PRIMARY = 'agent-primary';
const ORIGINAL_BOOKING_ID = 'bk-original';
const NEW_BOOKING_ID = 'bk-new';
const ORIGINAL_START = '2026-05-01T15:00:00.000Z';
const ORIGINAL_END = '2026-05-01T15:30:00.000Z';
const NEW_START = '2026-05-02T15:00:00.000Z';
const NEW_END = '2026-05-02T15:30:00.000Z';
const CALLER_PHONE = '+15551234567';

interface QueuedQuery {
  match?: RegExp;
  rows?: unknown[];
  rowCount?: number;
  throws?: Error;
}

describe('admin scheduling routes fan out appointment lifecycle events to the connector ledger', () => {
  let app: ReturnType<typeof express>;
  const queryQueue: QueuedQuery[] = [];

  beforeEach(() => {
    queryQueue.length = 0;
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      if (queryQueue.length === 0) {
        throw new Error(`Unexpected query (no mock queued):\n${sql}`);
      }
      const next = queryQueue.shift()!;
      if (next.match && !next.match.test(sql)) {
        throw new Error(
          `Query did not match expected pattern.\nExpected: ${next.match}\nGot: ${sql}`,
        );
      }
      if (next.throws) throw next.throws;
      const rows = next.rows ?? [];
      return { rows, rowCount: next.rowCount ?? rows.length };
    });
    dispatchEventMock.mockClear();
    dispatchEventMock.mockImplementation(async () => ({ success: true }));

    app = express();
    app.use(express.json());
    app.use(schedulingRouter);
  });

  // ─── RESCHEDULE: the load-bearing assertion ───
  //
  // This is the test the spec for the wiring change calls out: the
  // reschedule must dispatch a single `appointment.rescheduled` event
  // carrying the ORIGINAL appointment identifiers so the ledger lookup
  // resolves the calendar that already holds the event. Adapter selection
  // happens inside ConnectorService — the proof here is that the route
  // fires the event exactly once and forwards the original identifiers
  // (appointmentId, callerPhone+startTime, agentId) plus the new slot.
  it('POST /scheduling/bookings/:id/transition reschedule → dispatches ONE appointment.rescheduled event keyed to the original booking', async () => {
    queryQueue.push(
      // SELECT existing booking — confirmed, in a state that accepts reschedule
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: ORIGINAL_BOOKING_ID,
            tenant_id: TENANT,
            title: 'Original cleaning',
            status: 'confirmed',
            start_time: ORIGINAL_START,
            end_time: ORIGINAL_END,
            contact_name: 'Acme HQ',
            contact_phone: CALLER_PHONE,
            contact_email: 'ops@acme.test',
            agent_id: AGENT_PRIMARY,
            provider_id: PROVIDER_A,
            resource_id: null,
            timezone: 'America/Los_Angeles',
          },
        ],
      },
      // checkConflicts — no overlapping bookings
      { match: /FROM bookings WHERE/i, rows: [] },
      // findBlockingOverride — no blackout, reschedule allowed
      { match: /FROM scheduling_overrides/i, rows: [] },
      // UPDATE bookings (status = 'rescheduled')
      { match: /UPDATE bookings/i, rows: [], rowCount: 1 },
      // INSERT INTO bookings — the new booking row created from the old one
      {
        match: /INSERT INTO bookings/i,
        rows: [
          {
            id: NEW_BOOKING_ID,
            tenant_id: TENANT,
            title: 'Original cleaning',
            status: 'confirmed',
            start_time: NEW_START,
            end_time: NEW_END,
            contact_name: 'Acme HQ',
            contact_phone: CALLER_PHONE,
            agent_id: AGENT_PRIMARY,
            provider_id: PROVIDER_A,
            resource_id: null,
          },
        ],
      },
      // INSERT INTO scheduling_audit_log
      { match: /INSERT INTO scheduling_audit_log/i, rows: [] },
    );

    const res = await request(app)
      .post(`/scheduling/bookings/${ORIGINAL_BOOKING_ID}/transition`)
      .send({
        action: 'reschedule',
        new_start_time: NEW_START,
        new_end_time: NEW_END,
      });

    expect(res.status).toBe(200);
    expect(res.body.booking.id).toBe(NEW_BOOKING_ID);
    expect(res.body.previous_booking_id).toBe(ORIGINAL_BOOKING_ID);
    expect(queryQueue).toHaveLength(0);

    // Wait one microtask tick so the fire-and-forget dispatch has a chance
    // to be invoked (the route does not await the connector).
    await new Promise((r) => setImmediate(r));

    // EXACTLY ONE dispatch — the whole point is "lands only in the
    // original calendar", so the route must NOT broadcast a generic
    // "appointment.booked" for the new row in addition to the
    // "appointment.rescheduled" carrying the original identifiers.
    expect(dispatchEventMock).toHaveBeenCalledTimes(1);

    const [tenantArg, eventTypeArg, payloadArg] = dispatchEventMock.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(eventTypeArg).toBe('appointment.rescheduled');

    // The original-booking identifiers are what the connector ledger
    // keys on (`appt:<id>`, `phone:<phone>:<startTime>`); they MUST be
    // the original values, not the new slot.
    expect(payloadArg).toMatchObject({
      type: 'appointment.rescheduled',
      appointmentId: ORIGINAL_BOOKING_ID,
      callerPhone: CALLER_PHONE,
      startTime: ORIGINAL_START,
      endTime: ORIGINAL_END,
      agentId: AGENT_PRIMARY,
      // The new slot rides along so the calendar adapter can patch the
      // event in place.
      newAppointmentId: NEW_BOOKING_ID,
      newStartTime: NEW_START,
      newEndTime: NEW_END,
    });
  });

  it('POST /scheduling/bookings/:id/transition cancel → dispatches appointment.cancelled with the original booking identifiers', async () => {
    queryQueue.push(
      // SELECT existing booking
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: ORIGINAL_BOOKING_ID,
            tenant_id: TENANT,
            title: 'Original cleaning',
            status: 'confirmed',
            start_time: ORIGINAL_START,
            end_time: ORIGINAL_END,
            contact_name: 'Acme HQ',
            contact_phone: CALLER_PHONE,
            contact_email: 'ops@acme.test',
            agent_id: AGENT_PRIMARY,
            provider_id: PROVIDER_A,
            resource_id: null,
            appointment_type_id: null,
          },
        ],
      },
      // UPDATE bookings → status = cancelled
      { match: /UPDATE bookings/i, rows: [], rowCount: 1 },
      // SELECT scheduling_waitlist — no one waiting
      { match: /FROM scheduling_waitlist/i, rows: [] },
      // INSERT INTO scheduling_audit_log
      { match: /INSERT INTO scheduling_audit_log/i, rows: [] },
      // SELECT updated booking row to return
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [{ id: ORIGINAL_BOOKING_ID, status: 'cancelled' }],
      },
    );

    const res = await request(app)
      .post(`/scheduling/bookings/${ORIGINAL_BOOKING_ID}/transition`)
      .send({ action: 'cancel', cancellation_reason: 'customer asked' });

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('cancelled');

    await new Promise((r) => setImmediate(r));

    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
    const [tenantArg, eventTypeArg, payloadArg] = dispatchEventMock.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(eventTypeArg).toBe('appointment.cancelled');
    expect(payloadArg).toMatchObject({
      type: 'appointment.cancelled',
      appointmentId: ORIGINAL_BOOKING_ID,
      callerPhone: CALLER_PHONE,
      startTime: ORIGINAL_START,
      agentId: AGENT_PRIMARY,
      cancellationReason: 'customer asked',
    });
  });

  it('POST /scheduling/bookings/:id/transition no_show → dispatches appointment.no_show with the original booking identifiers', async () => {
    queryQueue.push(
      // SELECT existing booking — confirmed
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: ORIGINAL_BOOKING_ID,
            tenant_id: TENANT,
            title: 'Original cleaning',
            status: 'confirmed',
            start_time: ORIGINAL_START,
            end_time: ORIGINAL_END,
            contact_phone: CALLER_PHONE,
            contact_email: 'ops@acme.test',
            agent_id: AGENT_PRIMARY,
            provider_id: PROVIDER_A,
            resource_id: null,
            appointment_type_id: null,
          },
        ],
      },
      // UPDATE bookings → status = no_show
      { match: /UPDATE bookings/i, rows: [], rowCount: 1 },
      // INSERT INTO scheduling_audit_log
      { match: /INSERT INTO scheduling_audit_log/i, rows: [] },
      // SELECT updated booking row to return
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [{ id: ORIGINAL_BOOKING_ID, status: 'no_show' }],
      },
    );

    const res = await request(app)
      .post(`/scheduling/bookings/${ORIGINAL_BOOKING_ID}/transition`)
      .send({ action: 'no_show' });

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('no_show');

    await new Promise((r) => setImmediate(r));

    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
    const [tenantArg, eventTypeArg, payloadArg] = dispatchEventMock.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(eventTypeArg).toBe('appointment.no_show');
    expect(payloadArg).toMatchObject({
      type: 'appointment.no_show',
      appointmentId: ORIGINAL_BOOKING_ID,
      callerPhone: CALLER_PHONE,
      startTime: ORIGINAL_START,
      agentId: AGENT_PRIMARY,
    });
  });

  // ─── PUT /bookings/:id is a second, equivalent reschedule path ───
  //
  // The transition endpoint isn't the only way a booking time can change
  // — admins can also PUT a new `start_time`/`end_time` directly. The
  // calendar in production needs to learn about that move too, so the
  // update handler fires the same `appointment.rescheduled` event.
  it('PUT /scheduling/bookings/:id → dispatches appointment.rescheduled when start_time changes', async () => {
    queryQueue.push(
      // SELECT existing booking
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: ORIGINAL_BOOKING_ID,
            tenant_id: TENANT,
            title: 'Original cleaning',
            status: 'confirmed',
            start_time: ORIGINAL_START,
            end_time: ORIGINAL_END,
            contact_phone: CALLER_PHONE,
            contact_email: 'ops@acme.test',
            agent_id: AGENT_PRIMARY,
            provider_id: PROVIDER_A,
            resource_id: null,
          },
        ],
      },
      // checkConflicts → no overlap
      { match: /FROM bookings WHERE/i, rows: [] },
      // findBlockingOverride → no blackout
      { match: /FROM scheduling_overrides/i, rows: [] },
      // UPDATE bookings RETURNING *
      {
        match: /UPDATE bookings/i,
        rows: [
          {
            id: ORIGINAL_BOOKING_ID,
            tenant_id: TENANT,
            title: 'Original cleaning',
            status: 'confirmed',
            start_time: NEW_START,
            end_time: NEW_END,
            contact_phone: CALLER_PHONE,
            agent_id: AGENT_PRIMARY,
            provider_id: PROVIDER_A,
          },
        ],
      },
      // INSERT INTO scheduling_audit_log
      { match: /INSERT INTO scheduling_audit_log/i, rows: [] },
    );

    const res = await request(app)
      .put(`/scheduling/bookings/${ORIGINAL_BOOKING_ID}`)
      .send({ start_time: NEW_START, end_time: NEW_END });

    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));

    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
    const [tenantArg, eventTypeArg, payloadArg] = dispatchEventMock.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(eventTypeArg).toBe('appointment.rescheduled');
    // Lookup keys come from the OLD booking; new slot rides along.
    expect(payloadArg).toMatchObject({
      type: 'appointment.rescheduled',
      appointmentId: ORIGINAL_BOOKING_ID,
      callerPhone: CALLER_PHONE,
      startTime: ORIGINAL_START,
      newStartTime: NEW_START,
      newEndTime: NEW_END,
    });
  });

  // ─── PUT status flip is the third path that can reach a terminal state ───
  //
  // Admins can also flip a booking's `status` directly via the generic
  // PUT — without touching its time. The update handler must still emit
  // the matching lifecycle event so the connected calendar learns the
  // appointment was cancelled / marked no-show.
  it('PUT /scheduling/bookings/:id status=cancelled → dispatches appointment.cancelled with the original identifiers', async () => {
    queryQueue.push(
      // SELECT existing booking
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: ORIGINAL_BOOKING_ID,
            tenant_id: TENANT,
            title: 'Original cleaning',
            status: 'confirmed',
            start_time: ORIGINAL_START,
            end_time: ORIGINAL_END,
            contact_phone: CALLER_PHONE,
            contact_email: 'ops@acme.test',
            agent_id: AGENT_PRIMARY,
            provider_id: PROVIDER_A,
            resource_id: null,
          },
        ],
      },
      // UPDATE bookings RETURNING * — only status changed
      {
        match: /UPDATE bookings/i,
        rows: [
          {
            id: ORIGINAL_BOOKING_ID,
            tenant_id: TENANT,
            title: 'Original cleaning',
            status: 'cancelled',
            start_time: ORIGINAL_START,
            end_time: ORIGINAL_END,
            contact_phone: CALLER_PHONE,
            agent_id: AGENT_PRIMARY,
            provider_id: PROVIDER_A,
          },
        ],
      },
      // INSERT INTO scheduling_audit_log (status_changed branch)
      { match: /INSERT INTO scheduling_audit_log/i, rows: [] },
    );

    const res = await request(app)
      .put(`/scheduling/bookings/${ORIGINAL_BOOKING_ID}`)
      .send({ status: 'cancelled' });

    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));

    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
    const [tenantArg, eventTypeArg, payloadArg] = dispatchEventMock.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(eventTypeArg).toBe('appointment.cancelled');
    expect(payloadArg).toMatchObject({
      type: 'appointment.cancelled',
      appointmentId: ORIGINAL_BOOKING_ID,
      callerPhone: CALLER_PHONE,
      startTime: ORIGINAL_START,
      agentId: AGENT_PRIMARY,
    });
  });

  // ─── Connector failures must not break the admin response ───
  //
  // The dispatch is fire-and-forget; if the downstream connector throws
  // (network blip, expired credentials), the admin write must still
  // succeed and the response must be returned to the caller. Otherwise
  // a flaky calendar would hold every reschedule hostage.
  it('reschedule still 200s even if connectorService.dispatchEvent rejects', async () => {
    dispatchEventMock.mockImplementationOnce(async () => {
      throw new Error('calendar API down');
    });

    queryQueue.push(
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: ORIGINAL_BOOKING_ID,
            tenant_id: TENANT,
            status: 'confirmed',
            start_time: ORIGINAL_START,
            end_time: ORIGINAL_END,
            contact_phone: CALLER_PHONE,
            agent_id: AGENT_PRIMARY,
            provider_id: PROVIDER_A,
            resource_id: null,
          },
        ],
      },
      { match: /FROM bookings WHERE/i, rows: [] },
      { match: /FROM scheduling_overrides/i, rows: [] },
      { match: /UPDATE bookings/i, rows: [], rowCount: 1 },
      {
        match: /INSERT INTO bookings/i,
        rows: [{ id: NEW_BOOKING_ID, start_time: NEW_START, end_time: NEW_END }],
      },
      { match: /INSERT INTO scheduling_audit_log/i, rows: [] },
    );

    const res = await request(app)
      .post(`/scheduling/bookings/${ORIGINAL_BOOKING_ID}/transition`)
      .send({
        action: 'reschedule',
        new_start_time: NEW_START,
        new_end_time: NEW_END,
      });

    expect(res.status).toBe(200);
    expect(res.body.booking.id).toBe(NEW_BOOKING_ID);

    // Let the rejected promise settle so its `.catch` runs before the
    // test exits — keeps Vitest from logging an unhandled rejection.
    await new Promise((r) => setImmediate(r));
    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
  });
});
