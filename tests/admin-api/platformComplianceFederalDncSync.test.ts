/**
 * Coverage for the platform-admin "Sync Federal DNC now" controls
 * (`server/admin-api/routes/platformCompliance.ts`).
 *
 * The federal registry pull normally runs on a weekly cadence via
 * `FederalDncSyncScheduler`. Support cases occasionally need a forced run
 * — the new endpoints expose `runFederalDncSyncCycle()` and the latest
 * `federal_dnc_sync_state` row to the Platform Admin Console. These tests
 * lock down the contract that the console relies on:
 *
 *   1. POST /platform/compliance/federal-dnc/sync responds 202 immediately
 *      (without waiting for the multi-minute bulk load) and writes a
 *      `platform.federal_dnc.sync_triggered` audit row.
 *   2. While a sync is in flight, the GET /state response carries
 *      `running: true` and a second POST is rejected with 409 (so two
 *      impatient operators can't kick off two simultaneous loads).
 *   3. GET /state returns the columns the UI renders (last sync,
 *      registry version, record count, status, error).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const writeAuditLogMock = vi.fn(async () => {});
const runFederalDncSyncCycleMock = vi.fn(async () => {});
const getFederalDncSyncStateMock = vi.fn(async () => ({
  lastSyncStartedAt: null,
  lastSyncCompletedAt: null,
  lastRegistryVersion: null,
  lastRecordCount: null,
  lastStatus: null,
  lastError: null,
  updatedAt: null,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: vi.fn(), connect: vi.fn() }),
  withTenantContext: vi.fn(async (_c: unknown, _t: string, fn: () => Promise<void>) => fn()),
  withPrivilegedClient: vi.fn(async () => ({})),
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
  writeAuditLog: (...args: unknown[]) => writeAuditLogMock(...args),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../platform/security/TenantIsolationService', () => ({
  runAllIsolationTests: vi.fn(),
}));
vi.mock('../../platform/security/EncryptionService', () => ({
  getOrCreateTenantDEK: vi.fn(),
}));
vi.mock('../../platform/security/TenantIsolationScheduler', () => ({
  getTenantIsolationSchedulerStatus: vi.fn(() => ({})),
}));
vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(),
}));
vi.mock('../../platform/email/templates', () => ({
  encryptionInitializationReminderEmail: vi.fn(),
}));

vi.mock('../../platform/campaigns', () => ({
  runFederalDncSyncCycle: (...args: unknown[]) => runFederalDncSyncCycleMock(...args),
  getFederalDncSyncState: (...args: unknown[]) => getFederalDncSyncStateMock(...args),
}));

const currentUser = {
  tenantId: 'platform-tenant',
  userId: 'admin-user',
  role: 'admin',
  email: 'ops@quality-voice.test',
  isPlatformAdmin: true,
};

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = { ...currentUser };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import platformComplianceRoutes from '../../server/admin-api/routes/platformCompliance';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(platformComplianceRoutes);
  return app;
}

beforeEach(() => {
  writeAuditLogMock.mockClear();
  runFederalDncSyncCycleMock.mockReset();
  runFederalDncSyncCycleMock.mockResolvedValue(undefined);
  getFederalDncSyncStateMock.mockReset();
  getFederalDncSyncStateMock.mockResolvedValue({
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastRegistryVersion: null,
    lastRecordCount: null,
    lastStatus: null,
    lastError: null,
    updatedAt: null,
  });
});

describe('GET /platform/compliance/federal-dnc/state', () => {
  it('returns the latest sync-state row and a `running: false` flag at rest', async () => {
    getFederalDncSyncStateMock.mockResolvedValueOnce({
      lastSyncStartedAt: new Date('2026-04-20T10:00:00Z'),
      lastSyncCompletedAt: new Date('2026-04-20T10:08:00Z'),
      lastRegistryVersion: 'lm:Mon, 20 Apr 2026 09:30:00 GMT',
      lastRecordCount: 251_000_000,
      lastStatus: 'completed',
      lastError: null,
      updatedAt: new Date('2026-04-20T10:08:01Z'),
    });

    const app = buildApp();
    const res = await request(app).get('/platform/compliance/federal-dnc/state');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      running: false,
      state: {
        lastStatus: 'completed',
        lastRegistryVersion: 'lm:Mon, 20 Apr 2026 09:30:00 GMT',
        lastRecordCount: 251_000_000,
        lastError: null,
      },
    });
  });
});

describe('POST /platform/compliance/federal-dnc/sync', () => {
  it('responds 202 without awaiting the multi-minute bulk load and audits the action', async () => {
    // Hold the sync open so we can assert the response returns before it
    // resolves — the production cycle takes minutes and would blow past
    // any HTTP timeout if the handler awaited it.
    let releaseSync: () => void = () => {};
    runFederalDncSyncCycleMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseSync = resolve;
      }),
    );

    const app = buildApp();
    const res = await request(app).post('/platform/compliance/federal-dnc/sync');

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ started: true, running: true });
    expect(runFederalDncSyncCycleMock).toHaveBeenCalledTimes(1);

    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    const auditArg = writeAuditLogMock.mock.calls[0][0] as Record<string, unknown>;
    expect(auditArg).toMatchObject({
      tenantId: 'platform-tenant',
      actorUserId: 'admin-user',
      actorRole: 'admin',
      action: 'platform.federal_dnc.sync_triggered',
      resourceType: 'federal_dnc_registry',
      severity: 'info',
    });
    expect(auditArg.changes).toMatchObject({
      triggeredBy: 'ops@quality-voice.test',
      source: 'platform_admin_console',
    });

    // Release the in-flight sync so the module-local promise resolves
    // before the next test runs.
    releaseSync();
    await runFederalDncSyncCycleMock.mock.results[0].value;
  });

  it('reports `running: true` from /state while a sync is in flight and rejects a second trigger with 409', async () => {
    let releaseSync: () => void = () => {};
    runFederalDncSyncCycleMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseSync = resolve;
      }),
    );

    const app = buildApp();
    const first = await request(app).post('/platform/compliance/federal-dnc/sync');
    expect(first.status).toBe(202);

    const stateRes = await request(app).get('/platform/compliance/federal-dnc/state');
    expect(stateRes.status).toBe(200);
    expect(stateRes.body.running).toBe(true);

    const second = await request(app).post('/platform/compliance/federal-dnc/sync');
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ running: true });
    // Second click did NOT fire another load — the module-local guard kept
    // the bulk load count at one even with two concurrent operators.
    expect(runFederalDncSyncCycleMock).toHaveBeenCalledTimes(1);

    // Audit log was only written for the call we accepted.
    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);

    releaseSync();
    await runFederalDncSyncCycleMock.mock.results[0].value;
  });

  it('still returns 202 even if the audit-log write fails — the sync is already in flight', async () => {
    writeAuditLogMock.mockRejectedValueOnce(new Error('audit-db-down'));
    let releaseSync: () => void = () => {};
    runFederalDncSyncCycleMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseSync = resolve;
      }),
    );

    const app = buildApp();
    const res = await request(app).post('/platform/compliance/federal-dnc/sync');

    expect(res.status).toBe(202);
    expect(res.body.started).toBe(true);
    expect(runFederalDncSyncCycleMock).toHaveBeenCalledTimes(1);

    releaseSync();
    await runFederalDncSyncCycleMock.mock.results[0].value;
  });
});
