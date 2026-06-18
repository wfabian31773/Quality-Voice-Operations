import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
}));

// apiKeyAuth = requireApiKeyOrJwt(requireAuth); collapse both layers to an
// auth shim that injects the test user, and make permission/rate-limit gates
// pass-through so the handler bodies run.
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../middleware/apiKeyAuth', () => ({
  requireApiKeyOrJwt: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../middleware/apiKeyScope', () => ({
  requireApiKeyPermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/billing/billingBackfillCrossDayNotifier', () => ({
  notifyFinanceOfBackfillCrossDayAlert: vi.fn().mockResolvedValue(undefined),
}));

import router from './ingest';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.user.isPlatformAdmin = false;
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.releaseMock.mockReset();
});

describe('POST /v1/ingest/calls', () => {
  it('422 on an invalid payload', async () => {
    expect((await request(app()).post('/v1/ingest/calls').send({ foo: 'bar' })).status).toBe(422);
  });
});

describe('POST /v1/ingest/calls/backfill', () => {
  it('422 on an invalid payload', async () => {
    expect((await request(app()).post('/v1/ingest/calls/backfill').send({})).status).toBe(422);
  });
});

describe('POST /v1/ingest/tickets', () => {
  it('422 on an invalid payload', async () => {
    expect((await request(app()).post('/v1/ingest/tickets').send({})).status).toBe(422);
  });
});

describe('POST /v1/ingest/calls/backfill/batch', () => {
  const attestation = { reason: 'historical import', attested_by: 'ops-admin' };

  it('403 for a role without replay permission', async () => {
    a.user.role = 'support_reviewer';
    const res = await request(app()).post('/v1/ingest/calls/backfill/batch').send({ attestation, rows: [{}] });
    expect(res.status).toBe(403);
  });
  it('400 on an invalid request body', async () => {
    const res = await request(app()).post('/v1/ingest/calls/backfill/batch').send({ rows: [] });
    expect(res.status).toBe(400);
  });
  it('403 when a non-admin targets another tenant', async () => {
    const res = await request(app())
      .post('/v1/ingest/calls/backfill/batch')
      .send({ tenant_id: 'other', attestation, rows: [{}] });
    expect(res.status).toBe(403);
  });
  it('processes a batch and reports per-row validation failures', async () => {
    const res = await request(app())
      .post('/v1/ingest/calls/backfill/batch')
      .send({ attestation, rows: [{ external_id: 'x1' }] });
    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(1);
    expect(res.body.summary.validation_failed).toBe(1);
  });
});

describe('GET /v1/ingest/status', () => {
  it('returns aggregated event stats', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('GROUP BY event_type') ? { rows: [{ event_type: 'call.completed', status: 'processed', count: '3' }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
    const res = await request(app()).get('/v1/ingest/status');
    expect(res.status).toBe(200);
    expect(res.body.event_stats).toHaveLength(1);
  });
  it('500 on a query failure', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('GROUP BY event_type')) throw new Error('db down');
      return { rows: [], rowCount: 0 };
    });
    expect((await request(app()).get('/v1/ingest/status')).status).toBe(500);
  });
});

describe('POST /v1/ingest/calls/preview-existing', () => {
  it('422 when external_ids is missing', async () => {
    expect((await request(app()).post('/v1/ingest/calls/preview-existing').send({})).status).toBe(422);
  });
  it('returns which external_ids already exist', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM call_sessions') ? { rows: [{ external_id: 'x1' }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
    const res = await request(app()).post('/v1/ingest/calls/preview-existing').send({ external_ids: ['x1', 'x2'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ checked: 2, existing: ['x1'] });
  });
});
