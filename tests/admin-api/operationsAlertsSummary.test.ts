import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: vi.fn() }),
  withTenantContext: vi.fn(async (_c: unknown, _t: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../platform/infra/rate-limit/sseConnectionLimiter', () => ({
  getTenantSseConnectionLimiter: () => ({ acquire: () => true }),
  attachSseHeartbeat: () => Object.assign(() => {}, { ack: () => {} }),
  resolveLiveStreamCap: () => 10,
  registerSseConnection: () => () => {},
  ackSseConnection: () => true,
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireOpsRole: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    const headerUser = req.headers['x-test-user'];
    if (headerUser) {
      req.user = JSON.parse(String(headerUser));
    } else {
      req.user = {
        userId: 'user-1',
        tenantId: 'tenant-A',
        email: 'owner@acme.test',
        role: 'tenant_owner',
        isPlatformAdmin: false,
      };
    }
    next();
  },
}));

beforeEach(() => {
  queryMock.mockReset();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const router = (await import('../../server/admin-api/routes/operations')).default;
  app.use(router);
  return app;
}

describe('GET /operations/alerts/summary', () => {
  it('returns per-type counts scoped to the caller tenant when no `types` filter is provided', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { type: 'error_rate_spike', count: 2 },
        { type: 'support_email_delivery_failed', count: 1 },
      ],
    });

    const app = await buildApp();
    const res = await request(app).get('/operations/alerts/summary');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      counts: {
        error_rate_spike: 2,
        support_email_delivery_failed: 1,
      },
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(/FROM operations_alerts/);
    expect(String(sql)).toMatch(/tenant_id = \$1/);
    expect(String(sql)).toMatch(/acknowledged = false/);
    expect(String(sql)).toMatch(/GROUP BY type/);
    expect(String(sql)).not.toMatch(/IN \(/);
    expect(params).toEqual(['tenant-A']);
  });

  it('parameterizes the IN-clause when `types` is provided', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    await request(app)
      .get('/operations/alerts/summary')
      .query({ types: 'billing_backfill_cross_day,error_rate_spike' })
      .expect(200);

    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(/AND type IN \(\$2, \$3\)/);
    expect(params).toEqual([
      'tenant-A',
      'billing_backfill_cross_day',
      'error_rate_spike',
    ]);
  });

  it('omits zero-count rows from the response', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { type: 'escalation_spike', count: 0 },
        { type: 'error_rate_spike', count: 4 },
      ],
    });

    const app = await buildApp();
    const res = await request(app).get('/operations/alerts/summary');

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ error_rate_spike: 4 });
    expect(res.body.counts).not.toHaveProperty('escalation_spike');
  });

  it('ignores empty entries in `types=`', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    await request(app)
      .get('/operations/alerts/summary')
      .query({ types: 'error_rate_spike, ,' })
      .expect(200);

    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(/AND type IN \(\$2\)/);
    expect(params).toEqual(['tenant-A', 'error_rate_spike']);
  });

  it('caps `types=` to a fixed maximum so an unbounded query string cannot blow up the IN-clause', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const tooMany = Array.from({ length: 64 }, (_, i) => `t${i}`).join(',');
    const app = await buildApp();
    await request(app)
      .get('/operations/alerts/summary')
      .query({ types: tooMany })
      .expect(200);

    const [, params] = queryMock.mock.calls[0];
    expect((params as string[]).length).toBeLessThanOrEqual(33);
    expect((params as string[])[0]).toBe('tenant-A');
  });

  it('returns an empty `counts` map when no rows exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app).get('/operations/alerts/summary');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ counts: {} });
  });

  it('returns 500 when the DB query throws', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection refused'));

    const app = await buildApp();
    const res = await request(app).get('/operations/alerts/summary');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch alert summary' });
  });
});
