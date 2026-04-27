/**
 * Coverage for the schedule-override semantics added so the appointment
 * availability engine and downstream booking endpoints honour
 * `scheduling_overrides` rows.
 *
 * The audit (BL-038 / D-15 / W-05) called out three concrete bugs:
 *
 *   1. Full-day blackouts were the only override shape the availability
 *      query inspected — partial blackouts (e.g. lunch break) leaked through
 *      and customers could be booked into a blocked window.
 *   2. "Special hours" overrides (`is_available = true`) were ignored, so
 *      a normally-closed day could not be opened for a one-off.
 *   3. The booking write paths (`create`, `update`, `reschedule`) did not
 *      consult overrides at all.
 *
 * These tests exercise the helpers (pure logic) plus the override-conflict
 * helper that sits in front of the booking writes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../platform/db', () => ({
  getPlatformPool: vi.fn(),
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
  requireAuth: (
    req: { user?: Record<string, unknown> },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { tenantId: 'tenant-1', userId: 'user-1' };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {
  applyOverridesToScheduleBlocks,
  expandRecurringSeriesDates,
  findBlockingOverride,
  buildOverrideConflictResponse,
  type ScheduleOverride,
} from '../../server/admin-api/routes/scheduling';
import schedulingRouter from '../../server/admin-api/routes/scheduling';
import { getPlatformPool } from '../../platform/db';
import express from 'express';
import request from 'supertest';

const PROVIDER_A = 'prov-a';
const TENANT = 'tenant-1';

function ovr(partial: Partial<ScheduleOverride>): ScheduleOverride {
  return {
    provider_id: null,
    override_date: '2026-05-01',
    start_time: null,
    end_time: null,
    is_available: false,
    ...partial,
  };
}

describe('applyOverridesToScheduleBlocks', () => {
  const baseBlocks = [{ start_time: '09:00:00', end_time: '17:00:00' }];

  it('returns the regular schedule when no overrides apply', () => {
    const eff = applyOverridesToScheduleBlocks(baseBlocks, [], PROVIDER_A);
    expect(eff.blocked).toBe(false);
    if (!eff.blocked) {
      expect(eff.blocks).toEqual(baseBlocks);
      expect(eff.blackoutWindows).toEqual([]);
    }
  });

  it('marks the day blocked for a tenant-wide full-day blackout', () => {
    const eff = applyOverridesToScheduleBlocks(
      baseBlocks,
      [ovr({ reason: 'Holiday' })],
      PROVIDER_A,
    );
    expect(eff.blocked).toBe(true);
    if (eff.blocked) expect(eff.reason).toBe('Holiday');
  });

  it('subtracts a partial blackout from the open windows', () => {
    const eff = applyOverridesToScheduleBlocks(
      baseBlocks,
      [ovr({ start_time: '12:00:00', end_time: '13:00:00', reason: 'Lunch' })],
      PROVIDER_A,
    );
    expect(eff.blocked).toBe(false);
    if (!eff.blocked) {
      expect(eff.blocks).toEqual([
        { start_time: '09:00:00', end_time: '12:00:00' },
        { start_time: '13:00:00', end_time: '17:00:00' },
      ]);
      expect(eff.blackoutWindows).toEqual([
        { start_time: '12:00:00', end_time: '13:00:00' },
      ]);
    }
  });

  it('replaces the regular schedule when "available" overrides exist', () => {
    const eff = applyOverridesToScheduleBlocks(
      baseBlocks,
      [
        ovr({
          is_available: true,
          start_time: '10:00:00',
          end_time: '14:00:00',
          reason: 'Holiday hours',
        }),
      ],
      PROVIDER_A,
    );
    expect(eff.blocked).toBe(false);
    if (!eff.blocked) {
      expect(eff.blocks).toEqual([
        { start_time: '10:00:00', end_time: '14:00:00' },
      ]);
    }
  });

  it('lets provider-scoped overrides win over tenant-wide overrides on the same day', () => {
    const overrides = [
      ovr({ reason: 'Tenant-wide closure' }), // would block the day
      ovr({
        provider_id: PROVIDER_A,
        is_available: true,
        start_time: '08:00:00',
        end_time: '12:00:00',
      }),
    ];
    const eff = applyOverridesToScheduleBlocks(baseBlocks, overrides, PROVIDER_A);
    expect(eff.blocked).toBe(false);
    if (!eff.blocked) {
      expect(eff.blocks).toEqual([{ start_time: '08:00:00', end_time: '12:00:00' }]);
    }

    // …but for a different provider the tenant-wide closure still applies.
    const otherEff = applyOverridesToScheduleBlocks(baseBlocks, overrides, 'prov-b');
    expect(otherEff.blocked).toBe(true);
  });

  it('drops zero-length blocks left behind by a blackout that fills a window', () => {
    const eff = applyOverridesToScheduleBlocks(
      [{ start_time: '12:00:00', end_time: '13:00:00' }],
      [ovr({ start_time: '12:00:00', end_time: '13:00:00' })],
      null,
    );
    expect(eff.blocked).toBe(false);
    if (!eff.blocked) expect(eff.blocks).toEqual([]);
  });

  it('accepts HH:MM (no seconds) override times — the format the override UI sends', () => {
    const eff = applyOverridesToScheduleBlocks(
      baseBlocks,
      [ovr({ start_time: '12:00', end_time: '13:00' })],
      null,
    );
    expect(eff.blocked).toBe(false);
    if (!eff.blocked) {
      expect(eff.blackoutWindows).toEqual([
        { start_time: '12:00:00', end_time: '13:00:00' },
      ]);
    }
  });
});

describe('findBlockingOverride / buildOverrideConflictResponse', () => {
  const queryMock = vi.fn();
  const fakePool = { query: queryMock } as unknown as Parameters<
    typeof findBlockingOverride
  >[0];

  beforeEach(() => {
    queryMock.mockReset();
  });

  it('returns null when there are no overrides on the booked dates', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const result = await findBlockingOverride(
      fakePool,
      TENANT,
      '2026-05-01T10:00:00Z',
      '2026-05-01T11:00:00Z',
      PROVIDER_A,
    );
    expect(result).toBeNull();
    // Only blocked overrides are fetched (is_available = false).
    expect(String(queryMock.mock.calls[0][0])).toContain('is_available = false');
  });

  it('blocks bookings that overlap a partial blackout', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'ovr-1',
          provider_id: null,
          override_date: '2026-05-01',
          start_time: '12:00:00',
          end_time: '13:00:00',
          is_available: false,
          reason: 'Lunch',
        },
      ],
    });
    const result = await findBlockingOverride(
      fakePool,
      TENANT,
      '2026-05-01T12:30:00',
      '2026-05-01T12:45:00',
      PROVIDER_A,
    );
    expect(result?.id).toBe('ovr-1');
  });

  it('blocks bookings on a full-day blackout regardless of the start/end times', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'ovr-day',
          provider_id: PROVIDER_A,
          override_date: '2026-05-01',
          start_time: null,
          end_time: null,
          is_available: false,
          reason: 'Holiday',
        },
      ],
    });
    const result = await findBlockingOverride(
      fakePool,
      TENANT,
      '2026-05-01T08:00:00',
      '2026-05-01T08:30:00',
      PROVIDER_A,
    );
    expect(result?.id).toBe('ovr-day');
  });

  it('lets bookings that fall outside the blackout window proceed', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'ovr-1',
          provider_id: null,
          override_date: '2026-05-01',
          start_time: '12:00:00',
          end_time: '13:00:00',
          is_available: false,
          reason: 'Lunch',
        },
      ],
    });
    const result = await findBlockingOverride(
      fakePool,
      TENANT,
      '2026-05-01T14:00:00',
      '2026-05-01T15:00:00',
      PROVIDER_A,
    );
    expect(result).toBeNull();
  });

  it('prefers provider-scoped overrides over tenant-wide overrides on the same date', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        // Tenant-wide blackout that *would* cover the slot…
        {
          id: 'ovr-tenant',
          provider_id: null,
          override_date: '2026-05-01',
          start_time: '12:00:00',
          end_time: '13:00:00',
          is_available: false,
        },
        // …but a provider-scoped row exists for the same date and only blocks
        // a different window, so the booking should go through.
        {
          id: 'ovr-prov',
          provider_id: PROVIDER_A,
          override_date: '2026-05-01',
          start_time: '15:00:00',
          end_time: '16:00:00',
          is_available: false,
        },
      ],
    });
    const result = await findBlockingOverride(
      fakePool,
      TENANT,
      '2026-05-01T12:30:00',
      '2026-05-01T12:45:00',
      PROVIDER_A,
    );
    expect(result).toBeNull();
  });

  it('formats a 409 response payload via buildOverrideConflictResponse', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'ovr-1',
          provider_id: null,
          override_date: '2026-05-01',
          start_time: '12:00:00',
          end_time: '13:00:00',
          is_available: false,
          reason: 'Lunch',
        },
      ],
    });
    const response = await buildOverrideConflictResponse(
      fakePool,
      TENANT,
      '2026-05-01T12:30:00',
      '2026-05-01T12:45:00',
      PROVIDER_A,
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(409);
    expect(response?.body.error).toMatch(/blocked by a schedule override/i);
    const override = response?.body.override as Record<string, unknown>;
    expect(override.id).toBe('ovr-1');
    expect(override.reason).toBe('Lunch');
  });
});

describe('booking endpoints honour schedule overrides', () => {
  // Mount the real router with stubbed auth/RBAC so we can drive the
  // create/transition handlers end-to-end via supertest. The platform
  // pool is replaced with a queue-driven mock so each test scripts the
  // exact rows it wants the handlers to see.
  let app: ReturnType<typeof express>;
  const queryQueue: Array<{
    match?: RegExp;
    rows?: unknown[];
    rowCount?: number;
    throws?: Error;
  }> = [];
  const queryMock = vi.fn(async (sql: string) => {
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

  beforeEach(() => {
    queryMock.mockClear();
    queryQueue.length = 0;
    vi.mocked(getPlatformPool).mockReturnValue(
      { query: queryMock } as unknown as ReturnType<typeof getPlatformPool>,
    );
    app = express();
    app.use(express.json());
    app.use(schedulingRouter);
  });

  it('POST /scheduling/bookings → 409 when the requested slot overlaps a partial blackout', async () => {
    queryQueue.push(
      // getBookingRules — no rule rows
      { match: /FROM scheduling_booking_rules/i, rows: [] },
      // checkConflicts — no other bookings overlap
      { match: /FROM bookings WHERE/i, rows: [] },
      // findBlockingOverride — return a partial blackout that overlaps
      {
        match: /FROM scheduling_overrides/i,
        rows: [
          {
            id: 'ovr-lunch',
            provider_id: null,
            override_date: '2026-05-01',
            start_time: '12:00:00',
            end_time: '13:00:00',
            is_available: false,
            reason: 'Lunch',
          },
        ],
      },
    );

    const res = await request(app).post('/scheduling/bookings').send({
      title: 'Cleaning',
      start_time: '2026-05-01T12:30:00.000Z',
      end_time: '2026-05-01T12:45:00.000Z',
      provider_id: PROVIDER_A,
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/blocked by a schedule override/i);
    expect(res.body.override.id).toBe('ovr-lunch');
    // The handler must short-circuit before INSERT/audit-log writes.
    expect(queryQueue).toHaveLength(0);
  });

  it('POST /scheduling/bookings with override_reason bypasses the override gate (201)', async () => {
    queryQueue.push(
      // INSERT INTO bookings
      {
        match: /INSERT INTO bookings/i,
        rows: [
          {
            id: 'bk-1',
            tenant_id: TENANT,
            title: 'Cleaning',
            start_time: '2026-05-01T12:30:00.000Z',
            end_time: '2026-05-01T12:45:00.000Z',
            status: 'confirmed',
            provider_id: PROVIDER_A,
          },
        ],
      },
      // INSERT INTO scheduling_audit_log
      { match: /INSERT INTO scheduling_audit_log/i, rows: [] },
    );

    const res = await request(app).post('/scheduling/bookings').send({
      title: 'Cleaning',
      start_time: '2026-05-01T12:30:00.000Z',
      end_time: '2026-05-01T12:45:00.000Z',
      provider_id: PROVIDER_A,
      override_reason: 'Customer drove an hour for this — squeezing in',
    });

    expect(res.status).toBe(201);
    expect(res.body.booking.id).toBe('bk-1');
    // Booking-rules / conflicts / override queries were all skipped.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('POST /scheduling/bookings/:id/transition reopen → 409 if an override now blocks the original window', async () => {
    queryQueue.push(
      // SELECT existing booking — was cancelled, eligible for reopen
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: 'bk-cxl',
            tenant_id: TENANT,
            status: 'cancelled',
            start_time: '2026-05-01T12:30:00.000Z',
            end_time: '2026-05-01T12:45:00.000Z',
            provider_id: PROVIDER_A,
            resource_id: null,
          },
        ],
      },
      // findBlockingOverride — admin created a partial blackout in the meantime
      {
        match: /FROM scheduling_overrides/i,
        rows: [
          {
            id: 'ovr-late',
            provider_id: null,
            override_date: '2026-05-01',
            start_time: '12:00:00',
            end_time: '13:00:00',
            is_available: false,
            reason: 'Lunch',
          },
        ],
      },
    );

    const res = await request(app)
      .post('/scheduling/bookings/bk-cxl/transition')
      .send({ action: 'reopen' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/blocked by a schedule override/i);
    expect(res.body.override.id).toBe('ovr-late');
    // No UPDATE / audit-log writes after the gate.
    expect(queryQueue).toHaveLength(0);
  });

  it('POST /scheduling/bookings/:id/transition confirm → 409 if an override now blocks the booked window', async () => {
    queryQueue.push(
      // SELECT existing booking — pending, eligible for confirm
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: 'bk-pend',
            tenant_id: TENANT,
            status: 'pending',
            start_time: '2026-05-01T08:30:00.000Z',
            end_time: '2026-05-01T09:00:00.000Z',
            provider_id: PROVIDER_A,
            resource_id: null,
          },
        ],
      },
      // findBlockingOverride — full-day blackout
      {
        match: /FROM scheduling_overrides/i,
        rows: [
          {
            id: 'ovr-day',
            provider_id: PROVIDER_A,
            override_date: '2026-05-01',
            start_time: null,
            end_time: null,
            is_available: false,
            reason: 'Holiday',
          },
        ],
      },
    );

    const res = await request(app)
      .post('/scheduling/bookings/bk-pend/transition')
      .send({ action: 'confirm' });

    expect(res.status).toBe(409);
    expect(res.body.override.id).toBe('ovr-day');
    expect(queryQueue).toHaveLength(0);
  });

  it('POST /scheduling/bookings/:id/transition reopen → succeeds when override_reason is supplied', async () => {
    queryQueue.push(
      // SELECT existing booking
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: 'bk-cxl',
            tenant_id: TENANT,
            status: 'cancelled',
            start_time: '2026-05-01T12:30:00.000Z',
            end_time: '2026-05-01T12:45:00.000Z',
            provider_id: PROVIDER_A,
            resource_id: null,
          },
        ],
      },
      // UPDATE bookings
      { match: /UPDATE bookings/i, rows: [], rowCount: 1 },
      // INSERT INTO scheduling_audit_log
      { match: /INSERT INTO scheduling_audit_log/i, rows: [] },
      // SELECT updated booking row to return
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: 'bk-cxl',
            tenant_id: TENANT,
            status: 'pending',
            start_time: '2026-05-01T12:30:00.000Z',
            end_time: '2026-05-01T12:45:00.000Z',
            provider_id: PROVIDER_A,
          },
        ],
      },
    );

    const res = await request(app)
      .post('/scheduling/bookings/bk-cxl/transition')
      .send({ action: 'reopen', override_reason: 'admin override' });

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('pending');
    // No override-lookup query was issued because override_reason bypassed it.
    expect(queryQueue).toHaveLength(0);
  });

  it('POST /scheduling/bookings/:id/transition reschedule → 409 on full-day blackout', async () => {
    queryQueue.push(
      // SELECT existing booking (must be in a state that can reschedule)
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: 'bk-existing',
            tenant_id: TENANT,
            status: 'confirmed',
            provider_id: PROVIDER_A,
            resource_id: null,
          },
        ],
      },
      // checkConflicts — no other bookings overlap
      { match: /FROM bookings WHERE/i, rows: [] },
      // findBlockingOverride — full-day blackout
      {
        match: /FROM scheduling_overrides/i,
        rows: [
          {
            id: 'ovr-holiday',
            provider_id: PROVIDER_A,
            override_date: '2026-05-01',
            start_time: null,
            end_time: null,
            is_available: false,
            reason: 'Holiday',
          },
        ],
      },
    );

    const res = await request(app)
      .post('/scheduling/bookings/bk-existing/transition')
      .send({
        action: 'reschedule',
        new_start_time: '2026-05-01T09:00:00.000Z',
        new_end_time: '2026-05-01T09:30:00.000Z',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/blocked by a schedule override/i);
    expect(res.body.override.id).toBe('ovr-holiday');
    // No UPDATE / INSERT / audit-log writes should follow the gate.
    expect(queryQueue).toHaveLength(0);
  });

  // ─── RECURRING SERIES MATERIALIZATION ───
  //
  // The series row alone is not a calendar entry — `createRecurringSeriesHandler`
  // also expands the cadence into individual bookings. Those expansions must
  // honour the same `scheduling_overrides` gate as one-off booking writes,
  // otherwise a weekly appointment would happily land on a blackout date.
  it('POST /scheduling/recurring → skips occurrences that fall on a full-day blackout', async () => {
    queryQueue.push(
      // INSERT INTO scheduling_recurring_series — return a series that
      // expands to three Friday occurrences (2026-05-01, 05-08, 05-15).
      {
        match: /INSERT INTO scheduling_recurring_series/i,
        rows: [
          {
            id: 'series-1',
            tenant_id: TENANT,
            title: 'Weekly cleaning',
            provider_id: PROVIDER_A,
            appointment_type_id: null,
            resource_id: null,
            recurrence_pattern: 'weekly',
            recurrence_day_of_week: 5,
            recurrence_time: '14:00:00',
            duration_minutes: 30,
            series_start: '2026-05-01',
            series_end: '2026-05-15',
            contact_name: 'Acme HQ',
            contact_phone: '',
            contact_email: '',
          },
        ],
      },
      // findBlockingOverride for 2026-05-01 → full-day blackout (Holiday)
      {
        match: /FROM scheduling_overrides/i,
        rows: [
          {
            id: 'ovr-holiday',
            provider_id: null,
            override_date: '2026-05-01',
            start_time: null,
            end_time: null,
            is_available: false,
            reason: 'Holiday',
          },
        ],
      },
      // findBlockingOverride for 2026-05-08 → no overrides
      { match: /FROM scheduling_overrides/i, rows: [] },
      // INSERT INTO bookings — first materialized occurrence
      {
        match: /INSERT INTO bookings[\s\S]+recurring_series_id/i,
        rows: [{ id: 'bk-2026-05-08' }],
      },
      // findBlockingOverride for 2026-05-15 → no overrides
      { match: /FROM scheduling_overrides/i, rows: [] },
      // INSERT INTO bookings — second materialized occurrence
      {
        match: /INSERT INTO bookings[\s\S]+recurring_series_id/i,
        rows: [{ id: 'bk-2026-05-15' }],
      },
    );

    const res = await request(app).post('/scheduling/recurring').send({
      title: 'Weekly cleaning',
      provider_id: PROVIDER_A,
      recurrence_pattern: 'weekly',
      recurrence_day_of_week: 5,
      recurrence_time: '14:00:00',
      duration_minutes: 30,
      series_start: '2026-05-01',
      series_end: '2026-05-15',
    });

    expect(res.status).toBe(201);
    expect(res.body.series.id).toBe('series-1');
    // The 2026-05-01 occurrence MUST be skipped — the whole point of this
    // fix is that a recurring series cannot land on a blackout date.
    expect(res.body.occurrences.created).toEqual([
      'bk-2026-05-08',
      'bk-2026-05-15',
    ]);
    expect(res.body.occurrences.skipped).toEqual([
      {
        date: '2026-05-01',
        reason: 'Holiday',
        override_id: 'ovr-holiday',
      },
    ]);
    // Every queued response should have been consumed.
    expect(queryQueue).toHaveLength(0);
  });

  it('POST /scheduling/recurring → returns occurrences.error when materialization fails after the series row is saved', async () => {
    queryQueue.push(
      // INSERT INTO scheduling_recurring_series — series persisted successfully
      {
        match: /INSERT INTO scheduling_recurring_series/i,
        rows: [
          {
            id: 'series-err',
            tenant_id: TENANT,
            title: 'Weekly cleaning',
            provider_id: PROVIDER_A,
            appointment_type_id: null,
            resource_id: null,
            recurrence_pattern: 'weekly',
            recurrence_day_of_week: 5,
            recurrence_time: '14:00:00',
            duration_minutes: 30,
            series_start: '2026-05-01',
            series_end: '2026-05-08',
            contact_name: '',
            contact_phone: '',
            contact_email: '',
          },
        ],
      },
      // findBlockingOverride hits scheduling_overrides first — make that
      // throw to simulate a transient DB error mid-materialization. The
      // handler must NOT 500: the series row is already persisted, so the
      // failure has to surface in the response payload instead.
      {
        match: /FROM scheduling_overrides/i,
        throws: new Error('overrides table down'),
      },
    );

    const res = await request(app).post('/scheduling/recurring').send({
      title: 'Weekly cleaning',
      provider_id: PROVIDER_A,
      recurrence_pattern: 'weekly',
      recurrence_day_of_week: 5,
      recurrence_time: '14:00:00',
      duration_minutes: 30,
      series_start: '2026-05-01',
      series_end: '2026-05-08',
    });

    expect(res.status).toBe(201);
    expect(res.body.series.id).toBe('series-err');
    expect(res.body.occurrences.created).toEqual([]);
    expect(res.body.occurrences.skipped).toEqual([]);
    // Surface the failure in the response so callers can act on it instead of
    // silently believing the series was fully expanded.
    expect(res.body.occurrences.error).toMatch(/overrides table down/i);
  });

  it('POST /scheduling/recurring → still skips a date when the only override row is for that exact date (TZ-stable bucketing)', async () => {
    // Locks in the convention that override-date bucketing is deterministic
    // regardless of which timezone the calling tenant is in. A series whose
    // wall-clock time is "14:00" with timezone "America/Los_Angeles" must
    // still match the 2026-05-01 override row even though 14:00 PT crosses
    // into 21:00 UTC (still 2026-05-01 in UTC). Without this guarantee, a
    // tenant in a non-default timezone could quietly land an appointment on
    // a holiday date.
    queryQueue.push(
      {
        match: /INSERT INTO scheduling_recurring_series/i,
        rows: [
          {
            id: 'series-tz',
            tenant_id: TENANT,
            title: 'Pacific weekly cleaning',
            provider_id: PROVIDER_A,
            appointment_type_id: null,
            resource_id: null,
            recurrence_pattern: 'weekly',
            recurrence_day_of_week: 5,
            recurrence_time: '14:00:00',
            duration_minutes: 30,
            series_start: '2026-05-01',
            series_end: '2026-05-01',
            contact_name: '',
            contact_phone: '',
            contact_email: '',
          },
        ],
      },
      {
        match: /FROM scheduling_overrides/i,
        rows: [
          {
            id: 'ovr-pt-holiday',
            provider_id: PROVIDER_A,
            override_date: '2026-05-01',
            start_time: null,
            end_time: null,
            is_available: false,
            reason: 'Pacific holiday',
          },
        ],
      },
    );

    const res = await request(app).post('/scheduling/recurring').send({
      title: 'Pacific weekly cleaning',
      provider_id: PROVIDER_A,
      recurrence_pattern: 'weekly',
      recurrence_day_of_week: 5,
      recurrence_time: '14:00:00',
      duration_minutes: 30,
      series_start: '2026-05-01',
      series_end: '2026-05-01',
      timezone: 'America/Los_Angeles',
    });

    expect(res.status).toBe(201);
    expect(res.body.occurrences.created).toEqual([]);
    expect(res.body.occurrences.skipped).toEqual([
      { date: '2026-05-01', reason: 'Pacific holiday', override_id: 'ovr-pt-holiday' },
    ]);
    // No INSERT INTO bookings should have been issued.
    expect(queryQueue).toHaveLength(0);
  });

  it('POST /scheduling/recurring → materializes every occurrence when no overrides apply', async () => {
    queryQueue.push(
      {
        match: /INSERT INTO scheduling_recurring_series/i,
        rows: [
          {
            id: 'series-2',
            tenant_id: TENANT,
            title: 'Daily standup',
            provider_id: null,
            appointment_type_id: null,
            resource_id: null,
            recurrence_pattern: 'daily',
            recurrence_day_of_week: null,
            recurrence_time: '09:00:00',
            duration_minutes: 15,
            series_start: '2026-06-01',
            series_end: '2026-06-03',
            contact_name: '',
            contact_phone: '',
            contact_email: '',
          },
        ],
      },
      { match: /FROM scheduling_overrides/i, rows: [] },
      { match: /INSERT INTO bookings/i, rows: [{ id: 'bk-d1' }] },
      { match: /FROM scheduling_overrides/i, rows: [] },
      { match: /INSERT INTO bookings/i, rows: [{ id: 'bk-d2' }] },
      { match: /FROM scheduling_overrides/i, rows: [] },
      { match: /INSERT INTO bookings/i, rows: [{ id: 'bk-d3' }] },
    );

    const res = await request(app).post('/scheduling/recurring').send({
      title: 'Daily standup',
      recurrence_pattern: 'daily',
      recurrence_time: '09:00:00',
      duration_minutes: 15,
      series_start: '2026-06-01',
      series_end: '2026-06-03',
    });

    expect(res.status).toBe(201);
    expect(res.body.occurrences.created).toEqual(['bk-d1', 'bk-d2', 'bk-d3']);
    expect(res.body.occurrences.skipped).toEqual([]);
    expect(queryQueue).toHaveLength(0);
  });
});

describe('expandRecurringSeriesDates', () => {
  it('expands a weekly cadence between series_start and series_end', () => {
    const dates = expandRecurringSeriesDates(
      '2026-05-01', // Friday
      '2026-05-29',
      'weekly',
      5, // Friday
    );
    expect(dates).toEqual([
      '2026-05-01',
      '2026-05-08',
      '2026-05-15',
      '2026-05-22',
      '2026-05-29',
    ]);
  });

  it('snaps the first occurrence forward to the requested day-of-week', () => {
    // 2026-05-04 is a Monday; asking for Friday should jump to 2026-05-08.
    const dates = expandRecurringSeriesDates('2026-05-04', '2026-05-22', 'weekly', 5);
    expect(dates[0]).toBe('2026-05-08');
    expect(dates[dates.length - 1]).toBe('2026-05-22');
  });

  it('expands a biweekly cadence on a 14-day stride', () => {
    const dates = expandRecurringSeriesDates('2026-05-01', '2026-06-12', 'biweekly', 5);
    expect(dates).toEqual(['2026-05-01', '2026-05-15', '2026-05-29', '2026-06-12']);
  });

  it('expands a monthly cadence on the same day-of-month', () => {
    const dates = expandRecurringSeriesDates('2026-01-15', '2026-04-15', 'monthly', null);
    expect(dates).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
  });

  it('caps daily expansion to the default 90-day horizon when series_end is null', () => {
    const dates = expandRecurringSeriesDates('2026-01-01', null, 'daily', null);
    // 91 occurrences (Jan 1 plus 90 more days) is the inclusive horizon.
    expect(dates.length).toBe(91);
    expect(dates[0]).toBe('2026-01-01');
    expect(dates[dates.length - 1]).toBe('2026-04-01');
  });

  it('respects the maxOccurrences cap so a runaway daily series cannot explode', () => {
    const dates = expandRecurringSeriesDates(
      '2026-01-01',
      '2030-01-01',
      'daily',
      null,
      10,
    );
    expect(dates).toHaveLength(10);
  });
});
