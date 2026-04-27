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
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import {
  applyOverridesToScheduleBlocks,
  findBlockingOverride,
  buildOverrideConflictResponse,
  type ScheduleOverride,
} from '../../server/admin-api/routes/scheduling';

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
