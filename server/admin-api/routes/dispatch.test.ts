import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  poolQueryMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
// requireMiniSystemWrite from ../middleware/rbac stays real.
vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.poolQueryMock, connect: async () => ({ query: a.poolQueryMock, release: vi.fn() }) }) }));
vi.mock('../../../platform/notifications/dispatchPush', () => ({ fireDispatchPush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../platform/notifications/routeExportEvents', () => ({ emitRouteExportStatusChanged: vi.fn(), subscribeRouteExportEvents: vi.fn(() => () => {}) }));
vi.mock('../../../platform/infra/rate-limit/sseConnectionLimiter', () => ({
  attachSseHeartbeat: vi.fn(() => () => {}), getTenantSseConnectionLimiter: vi.fn(), registerSseConnection: vi.fn().mockResolvedValue({ ok: true }),
  ackSseConnection: vi.fn(), resolveLiveStreamCap: vi.fn(() => 5),
}));
vi.mock('../../replit_integrations/object_storage', () => ({
  ObjectStorageService: class { async getObject() { return null; } },
  ObjectNotFoundError: class extends Error {},
}));
vi.mock('../../../platform/email', () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true }),
  dispatchRouteExportReadyEmail: vi.fn(), dispatchRouteExportFailedEmail: vi.fn(), dispatchCompletionPhotosEmail: vi.fn(),
}));
vi.mock('../../../platform/dispatch/completionPhotoToken', () => ({ buildCompletionPhotoUrl: () => 'https://x', verifyCompletionPhotoToken: () => null }));
vi.mock('../../../platform/integrations/routing', () => ({
  enqueueJobGeocode: vi.fn(), geocodeAddressCached: vi.fn(), getDriveEta: vi.fn(), haversineMeters: () => 0,
}));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock('../../../shared/dispatch/mergeTokens', () => ({
  DISPATCH_MERGE_TOKENS: [], countSmsSegments: () => 1, findUnknownDispatchMergeTokens: () => [], renderDispatchTemplate: (s: string) => s,
}));

import router from './dispatch';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.poolQueryMock.mockReset().mockImplementation(async (sql: string) =>
    /COUNT\(\*\)\s+AS total/i.test(sql) ? { rows: [{ total: '0' }] } : { rows: [] },
  );
});

describe('list endpoints (simple reads)', () => {
  const listPaths = [
    '/dispatch/jobs/counts',
    '/dispatch/resources',
    '/dispatch/resource-locations',
    '/dispatch/territories',
    '/dispatch/skill-types',
  ];
  for (const path of listPaths) {
    it(`GET ${path} returns 200`, async () => {
      expect((await request(app()).get(path)).status).toBe(200);
    });
  }
  it('GET /dispatch/territories surfaces query failures as 500', async () => {
    a.poolQueryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/dispatch/territories')).status).toBe(500);
  });
});

describe('GET /dispatch/jobs/:id', () => {
  it('404 when the job is missing', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/dispatch/jobs/jb1')).status).toBe(404);
  });
  it('returns a job with related data', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM dispatch_jobs d') ? { rows: [{ id: 'jb1', title: 'Fix sink' }] } : { rows: [] },
    );
    const res = await request(app()).get('/dispatch/jobs/jb1');
    expect(res.status).toBe(200);
    expect(res.body.job ?? res.body).toBeTruthy();
  });
});

describe('POST /dispatch/jobs', () => {
  it('requires a title', async () => {
    expect((await request(app()).post('/dispatch/jobs').send({})).status).toBe(400);
  });
  it('rejects a non-member assignee', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM user_roles') ? { rows: [] } : { rows: [{ id: 'jb1' }] },
    );
    const res = await request(app()).post('/dispatch/jobs').send({ title: 'X', assignee_user_id: 'nobody' });
    expect(res.status).toBe(400);
  });
  it('rejects a viewer via the mini-system-write gate', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/dispatch/jobs').send({ title: 'X' })).status).toBe(403);
  });
});

describe('mini-system-write gate', () => {
  it('blocks a viewer from creating a territory', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/dispatch/territories').send({ name: 'North' })).status).toBe(403);
  });
});
