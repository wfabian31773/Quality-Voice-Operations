// Task #968: in-process cache + ETag/Cache-Control for /platform/maintenance.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
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
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-1',
      userId: 'admin-1',
      role: 'owner',
      isPlatformAdmin: true,
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) =>
    next(),
}));

vi.mock('../../platform/notifications/NotificationPreferences', () => ({
  getUserPreferences: vi.fn(),
  setUserPreferences: vi.fn(),
  NOTIFICATION_CATEGORIES: [],
  NOTIFICATION_CHANNELS: [],
  isNotificationCategory: () => false,
  isNotificationChannel: () => false,
}));

vi.mock('../../platform/integrations/connectors/ConnectorAlertPreferences', () => ({
  getConnectorAlertSettings: vi.fn(),
  setConnectorAlertSettings: vi.fn(),
  getConnectorAlertMutes: vi.fn(),
  replaceConnectorAlertMutes: vi.fn(),
}));

let buildApp: () => express.Express;

beforeEach(async () => {
  // Reset module state so the in-process cache starts empty per test.
  vi.resetModules();
  queryMock.mockReset();

  const router = (await import('../../server/admin-api/routes/productionEssentials'))
    .default;

  buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use(router);
    return app;
  };
});

describe('GET /platform/maintenance — Task #968 caching', () => {
  it('coalesces a burst of GETs onto a single DB SELECT (1s TTL)', async () => {
    const updatedAt = new Date('2026-04-29T10:00:00.000Z');
    queryMock.mockResolvedValue({
      rows: [
        {
          value: { enabled: true, message: 'down', scheduled_for: null },
          updated_at: updatedAt,
        },
      ],
    });

    const app = buildApp();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).get('/platform/maintenance'),
      ),
    );

    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ enabled: true, message: 'down' });
    }
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('sets a weak ETag derived from updated_at and a short Cache-Control', async () => {
    const updatedAt = new Date('2026-04-29T10:00:00.000Z');
    queryMock.mockResolvedValue({
      rows: [
        {
          value: { enabled: true, message: 'down', scheduled_for: null },
          updated_at: updatedAt,
        },
      ],
    });

    const res = await request(buildApp()).get('/platform/maintenance');
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toMatch(/^W\/"maint-on-2026-04-29T10:00:00\.000Z"$/);
    expect(res.headers['cache-control']).toBe(
      'private, max-age=2, must-revalidate',
    );
    expect(res.headers['last-modified']).toBeDefined();
  });

  it('returns 304 Not Modified when the client replays the cached ETag', async () => {
    const updatedAt = new Date('2026-04-29T10:00:00.000Z');
    queryMock.mockResolvedValue({
      rows: [
        {
          value: { enabled: true, message: 'down', scheduled_for: null },
          updated_at: updatedAt,
        },
      ],
    });

    const app = buildApp();
    const first = await request(app).get('/platform/maintenance');
    expect(first.status).toBe(200);
    const etag = first.headers['etag'];
    expect(etag).toBeDefined();

    const second = await request(app)
      .get('/platform/maintenance')
      .set('If-None-Match', etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe('');
    expect(second.headers['etag']).toBe(etag);
    expect(second.headers['cache-control']).toBe(
      'private, max-age=2, must-revalidate',
    );
  });

  it('serves a fresh 200 with a new ETag after a PUT toggle', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          value: { enabled: true, message: 'down', scheduled_for: null },
          updated_at: new Date('2026-04-29T10:00:00.000Z'),
        },
      ],
    });

    const app = buildApp();
    const first = await request(app).get('/platform/maintenance');
    expect(first.status).toBe(200);
    const oldETag = first.headers['etag'];

    queryMock.mockResolvedValueOnce({ rows: [] });
    const put = await request(app)
      .put('/platform/maintenance')
      .send({ enabled: false });
    expect(put.status).toBe(200);

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          value: { enabled: false, message: null, scheduled_for: null },
          updated_at: new Date('2026-04-29T10:00:05.000Z'),
        },
      ],
    });
    const second = await request(app)
      .get('/platform/maintenance')
      .set('If-None-Match', oldETag);

    expect(second.status).toBe(200);
    expect(second.body.enabled).toBe(false);
    expect(second.headers['etag']).not.toBe(oldETag);
  });

  it('returns a stable ETag for the empty/unset row case', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    const app = buildApp();
    const res = await request(app).get('/platform/maintenance');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      message: null,
      scheduled_for: null,
      updated_at: null,
    });
    expect(res.headers['etag']).toBe('W/"maint-off-empty"');

    const replay = await request(app)
      .get('/platform/maintenance')
      .set('If-None-Match', res.headers['etag']);
    expect(replay.status).toBe(304);
  });

  it('coalesces concurrent cache misses onto a single in-flight DB read', async () => {
    let resolveQuery: ((rows: unknown) => void) | null = null;
    queryMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveQuery = (rows) => resolve(rows);
        }),
    );

    const app = buildApp();

    // Kick off 4 concurrent requests. supertest only fires the underlying
    // HTTP call when the chainable is .then'd — so .then() each one to
    // ensure they all enter the handler before we assert mock-call count.
    const promises = Array.from({ length: 4 }, () => {
      return new Promise<{ status: number; body: { enabled: boolean } }>(
        (resolve, reject) => {
          request(app)
            .get('/platform/maintenance')
            .then(
              (r) => resolve({ status: r.status, body: r.body }),
              (err) => reject(err),
            );
        },
      );
    });

    // Yield to the event loop so all 4 requests reach the handler with the
    // cache empty. They must attach to the SAME pending DB read instead of
    // each issuing their own SELECT.
    await new Promise((r) => setTimeout(r, 20));
    expect(queryMock).toHaveBeenCalledTimes(1);

    resolveQuery!({
      rows: [
        {
          value: { enabled: true, message: 'down', scheduled_for: null },
          updated_at: new Date('2026-04-29T10:00:00.000Z'),
        },
      ],
    });

    const responses = await Promise.all(promises);
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.body.enabled).toBe(true);
    }
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns 304 on If-Modified-Since when updated_at has not advanced', async () => {
    const updatedAt = new Date('2026-04-29T10:00:00.000Z');
    queryMock.mockResolvedValue({
      rows: [
        {
          value: { enabled: true, message: 'down', scheduled_for: null },
          updated_at: updatedAt,
        },
      ],
    });

    const res = await request(buildApp())
      .get('/platform/maintenance')
      .set('If-Modified-Since', updatedAt.toUTCString());

    expect(res.status).toBe(304);
    expect(res.text).toBe('');
  });

  it('marks the DB-failure fallback as no-store', async () => {
    queryMock.mockRejectedValue(new Error('boom'));

    const res = await request(buildApp()).get('/platform/maintenance');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: false,
      message: null,
      scheduled_for: null,
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['last-modified']).toBeUndefined();
  });
});
