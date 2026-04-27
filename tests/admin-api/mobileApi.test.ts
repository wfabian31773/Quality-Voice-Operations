/**
 * Route-level coverage for the technician mobile API surface
 * (`/api/v1/dispatch/*` and `/api/v1/scheduling/*`).
 *
 * The mobile app authenticates with a `vai_*` API key (Bearer token); the
 * router gates each endpoint behind `requireApiKeyOrJwt(requireAuth)` plus
 * `requireApiKeyPermission('read-only' | 'write')`. We mount the real router
 * with the platform db pool mocked, and validate:
 *   - Read-only API keys can list and read jobs/bookings + technicians.
 *   - Read-only keys are blocked from POSTing transitions (mutations require
 *     write or admin scope / `*`).
 *   - Calls without an Authorization header fall through to JWT auth and 401.
 *   - Tenant scoping is enforced: every SQL the handler emits must include
 *     the caller's `tenant_id` parameter.
 */
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

// JWT auth middleware: when no `Bearer vai_*` API key is presented, require
// the test header to inject a user. Without it, return 401 (so we can verify
// missing-auth cases).
vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    const headerUser = req.headers['x-test-user'];
    if (headerUser) {
      req.user = JSON.parse(String(headerUser));
      return next();
    }
    res.status(401).json({ error: 'Not authenticated' });
  },
}));

// Mirror the real `requireMiniSystemWrite`: only `tenant_owner` and
// `operations_manager` may proceed. We keep the role-aware behaviour so the
// route-level guard for JWT-authenticated callers is exercised end-to-end.
const MINI_SYSTEM_WRITE_ROLES = new Set(['tenant_owner', 'operations_manager']);
vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!MINI_SYSTEM_WRITE_ROLES.has(req.user.role)) {
      res
        .status(403)
        .json({ error: 'Owner or Manager role required for this action' });
      return;
    }
    next();
  },
  requireRole: () => (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

// Treat any "Bearer vai_*" Authorization header as a valid API key. Tests
// can pass scopes via `vai_test_<scope>_...` so a single mock handles both
// the `read-only` and `write` permission tracks.
vi.mock('../../platform/rbac/ApiKeyService', () => ({
  validateApiKey: vi.fn(async (rawKey: string) => {
    if (!rawKey?.startsWith('vai_')) return null;
    const scopes = rawKey.includes('_write_')
      ? ['write']
      : rawKey.includes('_admin_')
        ? ['*']
        : ['read-only'];
    return {
      tenantId: 'tenant-A',
      keyId: 'key-A',
      scopes,
    };
  }),
}));

beforeEach(() => {
  queryMock.mockReset();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const mobileRouter = (
    await import('../../server/admin-api/routes/mobileApi')
  ).default;
  app.use(mobileRouter);
  return app;
}

const READ_KEY = 'vai_test_read_abcdef0123456789';
const WRITE_KEY = 'vai_test_write_abcdef0123456789';

describe('Mobile API: dispatch', () => {
  it('rejects requests without auth (no API key, no test JWT user)', async () => {
    const app = await buildApp();
    const res = await request(app).get('/api/v1/dispatch/jobs');
    expect(res.status).toBe(401);
  });

  it('lists jobs for a read-only API key and scopes by tenant', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          id: 'job-1',
          tenant_id: 'tenant-A',
          title: 'Replace water heater',
          status: 'assigned',
          priority: 'high',
          contact_name: 'Jane Doe',
          contact_phone: '+15551234567',
          _total_count: '1',
        },
      ],
    });

    const app = await buildApp();
    const res = await request(app)
      .get('/api/v1/dispatch/jobs?status=assigned&limit=25')
      .set('Authorization', `Bearer ${READ_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].id).toBe('job-1');
    expect(res.body.total).toBe(1);

    // Tenant id must always be the first bound parameter.
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('tenant-A');
  });

  it('returns a single job detail with events for the read-only key', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', tenant_id: 'tenant-A', title: 'Tune-up', status: 'assigned' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'evt-1', event_type: 'created' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .get('/api/v1/dispatch/jobs/job-1')
      .set('Authorization', `Bearer ${READ_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe('job-1');
    expect(res.body.events).toHaveLength(1);

    // First and second queries must both bind tenant-A.
    expect((queryMock.mock.calls[0][1] as unknown[])[1]).toBe('tenant-A');
    expect((queryMock.mock.calls[1][1] as unknown[])[1]).toBe('tenant-A');
  });

  it('blocks read-only keys from transitioning a job (write scope required)', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/v1/dispatch/jobs/job-1/transition')
      .set('Authorization', `Bearer ${READ_KEY}`)
      .send({ status: 'en_route' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Insufficient API key permissions/);
    // Permission check should fire BEFORE we touch the database.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows a write-scoped key to transition a job through the state machine', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'assigned' }] }) // existing lookup
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'en_route' }] }) // update
      .mockResolvedValueOnce({ rows: [] }) // event insert
      .mockResolvedValueOnce({ rows: [] }); // (extra safety)

    const app = await buildApp();
    const res = await request(app)
      .post('/api/v1/dispatch/jobs/job-1/transition')
      .set('Authorization', `Bearer ${WRITE_KEY}`)
      .send({ status: 'en_route', notes: 'Heading out' });

    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('en_route');

    // updateJob query must scope by tenant id (param 2 in the UPDATE).
    const updateCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE dispatch_jobs'),
    );
    expect(updateCall).toBeTruthy();
    expect((updateCall![1] as unknown[])[1]).toBe('tenant-A');
  });

  it('rejects transitions that violate the state machine (assigned → done)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'assigned' }] });

    const app = await buildApp();
    const res = await request(app)
      .post('/api/v1/dispatch/jobs/job-1/transition')
      .set('Authorization', `Bearer ${WRITE_KEY}`)
      .send({ status: 'done' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cannot transition/);
  });
});

describe('Mobile API: scheduling', () => {
  it('lists upcoming bookings for a read-only API key', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          id: 'bk-1',
          tenant_id: 'tenant-A',
          title: 'Annual checkup',
          start_time: new Date('2026-05-01T15:00:00.000Z').toISOString(),
          end_time: new Date('2026-05-01T15:30:00.000Z').toISOString(),
          status: 'confirmed',
          contact_name: 'Bob',
          _total_count: '1',
        },
      ],
    });

    const app = await buildApp();
    const res = await request(app)
      .get('/api/v1/scheduling/bookings?start=2026-05-01T00:00:00Z')
      .set('Authorization', `Bearer ${READ_KEY}`);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].id).toBe('bk-1');

    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('tenant-A');
  });

  it('blocks read-only keys from transitioning a booking', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/v1/scheduling/bookings/bk-1/transition')
      .set('Authorization', `Bearer ${READ_KEY}`)
      .send({ action: 'check_in' });

    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows a write-scoped key to check in a booking', async () => {
    // The handler emits 4 queries in order:
    //   1. SELECT existing booking
    //   2. UPDATE bookings ... (no RETURNING)
    //   3. INSERT into scheduling_audit_log
    //   4. SELECT updated booking
    queryMock
      .mockResolvedValueOnce({
        rows: [{ id: 'bk-1', status: 'confirmed', tenant_id: 'tenant-A' }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 'bk-1', status: 'checked_in', tenant_id: 'tenant-A' }],
      });

    const app = await buildApp();
    const res = await request(app)
      .post('/api/v1/scheduling/bookings/bk-1/transition')
      .set('Authorization', `Bearer ${WRITE_KEY}`)
      .send({ action: 'check_in' });

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('checked_in');
  });
});

// Regression coverage for mobile-mounted write endpoints when the caller is
// a JWT session (not an API key). `requireApiKeyPermission` is a no-op for
// non-API-key users, so the route-level write guard must additionally enforce
// `requireMiniSystemWrite` (tenant_owner / operations_manager) — otherwise
// any authenticated session could transition jobs/bookings.
describe('Mobile API: JWT write authorization', () => {
  function jwtUser(role: string): string {
    return JSON.stringify({
      userId: 'user-1',
      tenantId: 'tenant-A',
      role,
      email: 't@example.com',
    });
  }

  it('rejects JWT sessions without owner/manager role from transitioning jobs', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/v1/dispatch/jobs/job-1/transition')
      .set('x-test-user', jwtUser('agent'))
      .send({ status: 'en_route' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Owner or Manager role required/);
    // Guard must reject before any DB call.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects JWT sessions without owner/manager role from transitioning bookings', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/v1/scheduling/bookings/bk-1/transition')
      .set('x-test-user', jwtUser('agent'))
      .send({ action: 'check_in' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Owner or Manager role required/);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows JWT sessions with the operations_manager role to transition jobs', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'assigned' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'en_route' }] })
      .mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/api/v1/dispatch/jobs/job-1/transition')
      .set('x-test-user', jwtUser('operations_manager'))
      .send({ status: 'en_route' });

    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('en_route');
  });
});

describe('Mobile API: dispatch resources', () => {
  it('lists technicians (resources) for a read-only API key', async () => {
    // Handler emits 2 queries: the row fetch + a COUNT(*) total query.
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'res-1',
            tenant_id: 'tenant-A',
            name: 'Alex Tech',
            current_status: 'available',
            active_jobs: 1,
            skills: ['plumbing'],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const app = await buildApp();
    const res = await request(app)
      .get('/api/v1/dispatch/resources')
      .set('Authorization', `Bearer ${READ_KEY}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.resources)).toBe(true);
    expect(res.body.resources[0].id).toBe('res-1');
    expect(res.body.total).toBe(1);

    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('tenant-A');
  });
});
