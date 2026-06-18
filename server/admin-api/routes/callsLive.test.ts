import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  acquireMock: vi.fn(),
  ackSseConnectionMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.queryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../platform/infra/rate-limit/sseConnectionLimiter', () => ({
  getTenantSseConnectionLimiter: () => ({ acquire: a.acquireMock }),
  attachSseHeartbeat: () => ({ ack: vi.fn() }),
  resolveLiveStreamCap: () => 5,
  registerSseConnection: () => vi.fn(),
  ackSseConnection: a.ackSseConnectionMock,
}));

import router from './callsLive';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.acquireMock.mockReset();
  a.ackSseConnectionMock.mockReset().mockReturnValue(true);
});

describe('GET /calls/live (SSE)', () => {
  it('is rejected when the tenant concurrency cap is reached', async () => {
    // The limiter writes its own 429 and returns false; mirror that here so
    // the request completes instead of hanging on an open stream.
    a.acquireMock.mockImplementation((_req: unknown, res: express.Response) => {
      res.status(429).json({ error: 'cap reached' });
      return false;
    });
    const res = await request(app()).get('/calls/live');
    expect(res.status).toBe(429);
  });
});

describe('POST /calls/live/ack', () => {
  it('requires a connectionId', async () => {
    expect((await request(app()).post('/calls/live/ack').send({})).status).toBe(400);
  });
  it('404 for an unknown connectionId', async () => {
    a.ackSseConnectionMock.mockReturnValue(false);
    expect((await request(app()).post('/calls/live/ack').send({ connectionId: 'x' })).status).toBe(404);
  });
  it('204 on a valid ack', async () => {
    a.ackSseConnectionMock.mockReturnValue(true);
    const res = await request(app()).post('/calls/live/ack').send({ connectionId: 'conn-1' });
    expect(res.status).toBe(204);
    expect(a.ackSseConnectionMock).toHaveBeenCalledWith('t1', 'conn-1');
  });
  it('accepts the connectionId from the query string', async () => {
    a.ackSseConnectionMock.mockReturnValue(true);
    expect((await request(app()).post('/calls/live/ack?connectionId=q1').send({})).status).toBe(204);
  });
});
