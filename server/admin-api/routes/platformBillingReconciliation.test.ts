import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  runReconciliationCycleMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/billing/BillingReconciliationScheduler', () => ({
  runReconciliationCycle: a.runReconciliationCycleMock,
}));

import router from './platformBillingReconciliation';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = false;
  a.runReconciliationCycleMock.mockReset().mockResolvedValue({ tenantsProcessed: 2, rowsUpserted: 5 });
});

describe('POST /platform/billing/reconciliation/run', () => {
  it('rejects a non-platform-admin with 403', async () => {
    expect((await request(app()).post('/platform/billing/reconciliation/run')).status).toBe(403);
  });

  it('runs the reconciliation cycle for a platform admin', async () => {
    a.user.isPlatformAdmin = true;
    const res = await request(app()).post('/platform/billing/reconciliation/run');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, summary: { tenantsProcessed: 2 } });
    expect(a.runReconciliationCycleMock).toHaveBeenCalledWith('manual');
  });

  it('returns 500 when the cycle throws', async () => {
    a.user.isPlatformAdmin = true;
    a.runReconciliationCycleMock.mockRejectedValue(new Error('boom'));
    const res = await request(app()).post('/platform/billing/reconciliation/run');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'reconciliation_failed' });
  });
});
