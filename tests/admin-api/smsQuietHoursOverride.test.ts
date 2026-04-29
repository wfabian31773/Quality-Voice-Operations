/**
 * Task #990 — tenant SMS quiet-hours override coverage.
 *
 * Two layers of behavior:
 *   1. The pure helper (`getEffectiveSmsQuietHoursWindow`,
 *      `evaluateSmsQuietHoursForTenant`) loads the tenant override and
 *      clamps it inside the federal floor.
 *   2. The admin route (`PUT /sms-inbox/compliance-settings`) validates
 *      the requested window and rejects loosenings with a 400.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(async () => {}),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'admin',
      email: 'admin@example.com',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireMiniSystemWrite: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import smsInboxRouter from '../../server/admin-api/routes/smsInbox';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(smsInboxRouter);
  return app;
}

beforeEach(async () => {
  queryMock.mockReset();
  // Reset cached tenant override so a previous test's override doesn't
  // bleed into the next.
  const mod = await import('../../platform/sms/SmsQuietHours');
  mod._resetSmsQuietHoursCacheForTests();
});

describe('getEffectiveSmsQuietHoursWindow (tenant override)', () => {
  it('returns the federal default when the tenant has no override', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ sms_quiet_hours_start: null, sms_quiet_hours_end: null }] });
    const { getEffectiveSmsQuietHoursWindow } = await import('../../platform/sms/SmsQuietHours');
    const w = await getEffectiveSmsQuietHoursWindow('tenant-1');
    expect(w).toEqual({ start: '08:00', end: '21:00', isTenantOverride: false });
  });

  it('applies a tenant override that tightens the window', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ sms_quiet_hours_start: '09:00:00', sms_quiet_hours_end: '20:00:00' }],
    });
    const { getEffectiveSmsQuietHoursWindow } = await import('../../platform/sms/SmsQuietHours');
    const w = await getEffectiveSmsQuietHoursWindow('tenant-1');
    expect(w).toEqual({ start: '09:00', end: '20:00', isTenantOverride: true });
  });

  it('clamps a loosening override back into the federal floor', async () => {
    // Tenant tried to set 06:00–22:00 (broader than 08:00–21:00). The
    // helper must snap each side back to the federal default so a
    // misconfigured tenant cannot weaken platform protection.
    queryMock.mockResolvedValueOnce({
      rows: [{ sms_quiet_hours_start: '06:00:00', sms_quiet_hours_end: '22:00:00' }],
    });
    const { getEffectiveSmsQuietHoursWindow } = await import('../../platform/sms/SmsQuietHours');
    const w = await getEffectiveSmsQuietHoursWindow('tenant-1');
    expect(w).toEqual({ start: '08:00', end: '21:00', isTenantOverride: false });
  });

  it('falls back to the federal default on DB error', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    const { getEffectiveSmsQuietHoursWindow } = await import('../../platform/sms/SmsQuietHours');
    const w = await getEffectiveSmsQuietHoursWindow('tenant-1');
    expect(w).toEqual({ start: '08:00', end: '21:00', isTenantOverride: false });
  });
});

describe('evaluateSmsQuietHoursForTenant (window narrowing)', () => {
  it('blocks 19:30 Eastern when the tenant has tightened the end to 19:00', async () => {
    queryMock.mockResolvedValue({
      rows: [{ sms_quiet_hours_start: '09:00:00', sms_quiet_hours_end: '19:00:00' }],
    });
    const { evaluateSmsQuietHoursForTenant } = await import('../../platform/sms/SmsQuietHours');
    // 2026-04-28 23:30 UTC = 19:30 Eastern (inside federal 08:00–21:00 but
    // outside the tenant's tightened 09:00–19:00).
    const at = new Date(Date.UTC(2026, 3, 28, 23, 30));
    const decision = await evaluateSmsQuietHoursForTenant('tenant-1', '+12025550100', at);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('outside_window');
  });

  it('still allows 18:30 Eastern with the same tenant override', async () => {
    queryMock.mockResolvedValue({
      rows: [{ sms_quiet_hours_start: '09:00:00', sms_quiet_hours_end: '19:00:00' }],
    });
    const { evaluateSmsQuietHoursForTenant } = await import('../../platform/sms/SmsQuietHours');
    const at = new Date(Date.UTC(2026, 3, 28, 22, 30));
    const decision = await evaluateSmsQuietHoursForTenant('tenant-1', '+12025550100', at);
    expect(decision.allowed).toBe(true);
  });
});

describe('PUT /sms-inbox/compliance-settings', () => {
  it('rejects a windowStart that loosens the federal default', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/sms-inbox/compliance-settings')
      .send({ windowStart: '06:00' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/windowStart/);
  });

  it('rejects an inverted window (start >= end)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ s: null, e: null }] });
    const app = buildApp();
    const res = await request(app)
      .put('/sms-inbox/compliance-settings')
      .send({ windowStart: '20:00', windowEnd: '19:00' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/earlier than/);
  });

  it('persists a valid tighter override', async () => {
    queryMock
      // existingRows lookup
      .mockResolvedValueOnce({ rows: [{ s: null, e: null }] })
      // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // post-update raw lookup for getEffectiveSmsQuietHoursWindow
      .mockResolvedValueOnce({
        rows: [{ sms_quiet_hours_start: '09:00:00', sms_quiet_hours_end: '20:00:00' }],
      });
    const app = buildApp();
    const res = await request(app)
      .put('/sms-inbox/compliance-settings')
      .send({ windowStart: '09:00', windowEnd: '20:00' });
    expect(res.status).toBe(200);
    expect(res.body.settings.tenantOverride).toEqual({
      windowStart: '09:00',
      windowEnd: '20:00',
    });
    expect(res.body.settings.effective.isTenantOverride).toBe(true);
    expect(res.body.settings.effective.windowStart).toBe('09:00');
    expect(res.body.settings.effective.windowEnd).toBe('20:00');
  });

  it('clears the override back to the federal default with nulls', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ s: '09:00', e: '20:00' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ sms_quiet_hours_start: null, sms_quiet_hours_end: null }],
      });
    const app = buildApp();
    const res = await request(app)
      .put('/sms-inbox/compliance-settings')
      .send({ windowStart: null, windowEnd: null });
    expect(res.status).toBe(200);
    expect(res.body.settings.effective.isTenantOverride).toBe(false);
    expect(res.body.settings.effective.windowStart).toBe('08:00');
    expect(res.body.settings.effective.windowEnd).toBe('21:00');
  });
});
