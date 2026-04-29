/**
 * Pins the write-path wiring between the dispatch job create / update /
 * follow-up endpoints and the in-process geocode queue
 * (`platform/integrations/routing/jobGeocodeQueue`).
 *
 * The queue itself is exercised in jobGeocodeQueue.test.ts; here we
 * verify the *handler* contract:
 *
 *   1. POST /dispatch/jobs enqueues a geocode for the new row's address
 *      (and is a no-op when address is empty).
 *   2. PUT  /dispatch/jobs/:id enqueues a re-geocode AND clears the
 *      cached `address_lat`/`address_lon` columns when the address
 *      column actually changes (so the lazy readers don't render the
 *      stale pin in the meantime).
 *   3. PUT  /dispatch/jobs/:id with the same address as before does NOT
 *      enqueue (idempotent edits don't burn provider quota).
 *   4. POST /dispatch/jobs/:id/follow-up enqueues for the new follow-up
 *      row (which inherits the parent's address).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const enqueueJobGeocodeMock = vi.fn();
const fireDispatchPushMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
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

vi.mock('../../platform/integrations/routing', async () => {
  const actual = await vi.importActual<typeof import('../../platform/integrations/routing')>(
    '../../platform/integrations/routing',
  );
  return {
    ...actual,
    enqueueJobGeocode: enqueueJobGeocodeMock,
  };
});

vi.mock('../../platform/notifications/dispatchPush', () => ({
  fireDispatchPush: fireDispatchPushMock,
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      tenantId: 'tenant-A',
      role: 'tenant_owner',
      email: 't@example.com',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
  requireRole: () => (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock('../../server/admin-api/middleware/apiKeyAuth', () => ({
  requireApiKeyOrJwt: (jwt: (req: Request, res: Response, next: NextFunction) => void) => jwt,
}));

vi.mock('../../server/admin-api/middleware/apiKeyScope', () => ({
  requireApiKeyPermission: () => (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock('../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock('../../server/replit_integrations/object_storage', () => ({
  ObjectStorageService: class {},
  ObjectNotFoundError: class extends Error {},
}));

beforeEach(() => {
  queryMock.mockReset();
  enqueueJobGeocodeMock.mockReset();
  fireDispatchPushMock.mockReset();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const { default: dispatchRouter } = await import(
    '../../server/admin-api/routes/dispatch'
  );
  app.use(dispatchRouter);
  return app;
}

describe('createJobHandler enqueues a geocode for the new row', () => {
  it('calls enqueueJobGeocode with the address from the inserted row', async () => {
    // 1. INSERT dispatch_jobs -> RETURNING *
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        tenant_id: 'tenant-A',
        address: '500 Folsom St, SF',
        title: 'Water heater',
      }],
    });
    // 2. INSERT dispatch_job_events
    queryMock.mockResolvedValueOnce({ rowCount: 1 });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs')
      .send({ title: 'Water heater', address: '500 Folsom St, SF' });

    expect(res.status).toBe(201);
    expect(enqueueJobGeocodeMock).toHaveBeenCalledTimes(1);
    expect(enqueueJobGeocodeMock).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-A',
      'job-1',
      '500 Folsom St, SF',
    );
  });

  it('enqueues even when the address has leading/trailing whitespace (queue trims internally)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        tenant_id: 'tenant-A',
        // Stored as-typed (with the surrounding whitespace) — the
        // queue's persist UPDATE uses btrim(address) = $3 so the row
        // still matches against the trimmed parameter.
        address: '   500 Folsom St, SF   ',
        title: 'Whitespace job',
      }],
    });
    queryMock.mockResolvedValueOnce({ rowCount: 1 });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs')
      .send({ title: 'Whitespace job', address: '   500 Folsom St, SF   ' });

    expect(res.status).toBe(201);
    expect(enqueueJobGeocodeMock).toHaveBeenCalledTimes(1);
    expect(enqueueJobGeocodeMock).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-A',
      'job-1',
      '   500 Folsom St, SF   ',
    );
  });

  it('does NOT enqueue when the inserted row has an empty address', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-1', tenant_id: 'tenant-A', address: '', title: 'No-address job' }],
    });
    queryMock.mockResolvedValueOnce({ rowCount: 1 });

    const app = await buildApp();
    const res = await request(app).post('/dispatch/jobs').send({ title: 'No-address job' });

    expect(res.status).toBe(201);
    expect(enqueueJobGeocodeMock).not.toHaveBeenCalled();
  });
});

describe('updateJobHandler enqueues only when the address changes', () => {
  it('clears cached coords AND enqueues a re-geocode when address changes', async () => {
    // 1. SELECT existing row
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        current_status: 'pending',
        assignee_user_id: null,
        cur_territory_id: null,
        cur_required_skills: [],
        cur_scheduled_at: null,
        cur_address: 'Old address 100',
      }],
    });
    // 2. UPDATE dispatch_jobs RETURNING *
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-1', tenant_id: 'tenant-A', address: 'New address 200' }],
    });

    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/jobs/job-1')
      .send({ address: 'New address 200' });

    expect(res.status).toBe(200);
    // The UPDATE must NULL the cached coord columns so the lazy
    // readers don't keep showing the stale pin until the queue runs.
    const updateCall = queryMock.mock.calls[1];
    expect(updateCall[0]).toMatch(/address_lat = NULL/);
    expect(updateCall[0]).toMatch(/address_lon = NULL/);
    expect(updateCall[0]).toMatch(/address_geocoded_at = NULL/);
    expect(updateCall[0]).toMatch(/address_geocoded_for = NULL/);
    expect(enqueueJobGeocodeMock).toHaveBeenCalledTimes(1);
    expect(enqueueJobGeocodeMock).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-A',
      'job-1',
      'New address 200',
    );
  });

  it('does NOT enqueue when the address payload is unchanged', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        current_status: 'pending',
        assignee_user_id: null,
        cur_territory_id: null,
        cur_required_skills: [],
        cur_scheduled_at: null,
        cur_address: 'Same address',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-1', tenant_id: 'tenant-A', address: 'Same address' }],
    });

    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/jobs/job-1')
      .send({ address: 'Same address' });

    expect(res.status).toBe(200);
    // The UPDATE for an unchanged address must NOT clobber the cached
    // coord columns — they're still valid for the same address.
    const updateCall = queryMock.mock.calls[1];
    expect(updateCall[0]).not.toMatch(/address_lat = NULL/);
    expect(enqueueJobGeocodeMock).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when the address field is omitted from the PUT', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        current_status: 'pending',
        assignee_user_id: null,
        cur_territory_id: null,
        cur_required_skills: [],
        cur_scheduled_at: null,
        cur_address: 'Whatever',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-1', tenant_id: 'tenant-A', address: 'Whatever' }],
    });

    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/jobs/job-1')
      .send({ priority: 'high' });

    expect(res.status).toBe(200);
    expect(enqueueJobGeocodeMock).not.toHaveBeenCalled();
  });
});

describe('createFollowUpHandler enqueues for the new follow-up row', () => {
  it('enqueues using the inherited parent address', async () => {
    // 1. SELECT parent
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'parent-1',
        title: 'Original',
        description: '',
        priority: 'medium',
        contact_id: null,
        contact_name: '',
        contact_phone: '',
        contact_email: '',
        address: '500 Folsom St, SF',
        territory_id: null,
        resource_id: null,
        job_type: 'general',
        required_skills: [],
      }],
    });
    // 2. INSERT new follow-up
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'fup-1', tenant_id: 'tenant-A', address: '500 Folsom St, SF' }],
    });
    // 3. INSERT event
    queryMock.mockResolvedValueOnce({ rowCount: 1 });

    const app = await buildApp();
    const res = await request(app).post('/dispatch/jobs/parent-1/follow-up').send({});

    expect(res.status).toBe(201);
    expect(enqueueJobGeocodeMock).toHaveBeenCalledTimes(1);
    expect(enqueueJobGeocodeMock).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-A',
      'fup-1',
      '500 Folsom St, SF',
    );
  });
});
