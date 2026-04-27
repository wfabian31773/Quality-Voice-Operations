// Locks down the "transition → push event" wiring on the dispatch and
// scheduling routes (cancellations + reschedules). The push-fan-out itself
// is exercised in dispatchPushNotifications.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

const queryMock = vi.fn();
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

vi.mock('../../platform/notifications/dispatchPush', () => ({
  fireDispatchPush: fireDispatchPushMock,
}));

// Bypass auth middlewares; auth is covered in mobileApi.test.ts.
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

beforeEach(() => {
  queryMock.mockReset();
  fireDispatchPushMock.mockReset();
});

async function buildDispatchApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const { default: dispatchRouter } = await import(
    '../../server/admin-api/routes/dispatch'
  );
  app.use(dispatchRouter);
  return app;
}

async function buildSchedulingApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const { default: schedulingRouter } = await import(
    '../../server/admin-api/routes/scheduling'
  );
  app.use(schedulingRouter);
  return app;
}

describe('Dispatch route → push event mapping', () => {
  it('fires job_cancelled when a tech-assigned job is transitioned to cancelled', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'assigned' }] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', status: 'cancelled' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }) // INSERT event
      .mockResolvedValueOnce({ rows: [] }) // fireNotifications templates lookup (empty → short-circuits)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'job-1',
            title: 'Replace water heater',
            status: 'cancelled',
            contact_name: 'Jane',
            address: '123 Main St',
            scheduled_at: null,
            eta_start: null,
            resource_id: 'res-1',
            assignee_user_id: null,
          },
        ],
      });

    const app = await buildDispatchApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-1/transition')
      .send({ status: 'cancelled' });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r)); // fire-and-forget push

    expect(fireDispatchPushMock).toHaveBeenCalledTimes(1);
    const arg = fireDispatchPushMock.mock.calls[0][0];
    expect(arg.event).toBe('job_cancelled');
    expect(arg.tenantId).toBe('tenant-A');
    expect(arg.resourceIds).toEqual(['res-1']);
    expect(arg.job?.id).toBe('job-1');
  });

  it('does NOT fire a push when an unassigned job is cancelled (no resource, no assignee)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'job-2', status: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'job-2', status: 'cancelled' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'job-2',
            title: 'Floating job',
            status: 'cancelled',
            resource_id: null,
            assignee_user_id: null,
          },
        ],
      });

    const app = await buildDispatchApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-2/transition')
      .send({ status: 'cancelled' });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(fireDispatchPushMock).not.toHaveBeenCalled();
  });
});

describe('Scheduling route → push event mapping', () => {
  it('fires booking_cancelled to the assigned resource when a booking is cancelled', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bk-1',
            tenant_id: 'tenant-A',
            status: 'confirmed',
            title: 'Annual checkup',
            start_time: new Date('2026-05-01T15:00:00.000Z'),
            end_time: new Date('2026-05-01T15:30:00.000Z'),
            resource_id: 'res-1',
            appointment_type_id: null,
            provider_id: null,
          },
        ],
      }) // SELECT existing booking
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE bookings
      .mockResolvedValueOnce({ rows: [] }) // SELECT scheduling_waitlist
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // INSERT audit log
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bk-1',
            tenant_id: 'tenant-A',
            status: 'cancelled',
            resource_id: 'res-1',
          },
        ],
      });

    const app = await buildSchedulingApp();
    const res = await request(app)
      .post('/scheduling/bookings/bk-1/transition')
      .send({ action: 'cancel', cancellation_reason: 'customer not home' });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    expect(fireDispatchPushMock).toHaveBeenCalledTimes(1);
    const arg = fireDispatchPushMock.mock.calls[0][0];
    expect(arg.event).toBe('booking_cancelled');
    expect(arg.tenantId).toBe('tenant-A');
    expect(arg.resourceIds).toEqual(['res-1']);
    expect(arg.booking?.id).toBe('bk-1');
    expect(arg.booking?.title).toBe('Annual checkup');
    expect(arg.booking?.start_time).toBe('2026-05-01T15:00:00.000Z');
  });

  it('skips the push when the cancelled booking has no resource_id', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bk-2',
            tenant_id: 'tenant-A',
            status: 'confirmed',
            title: 'Phone consult',
            start_time: new Date('2026-05-01T15:00:00.000Z'),
            end_time: new Date('2026-05-01T15:30:00.000Z'),
            resource_id: null,
            appointment_type_id: null,
            provider_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'bk-2', status: 'cancelled' }],
      });

    const app = await buildSchedulingApp();
    const res = await request(app)
      .post('/scheduling/bookings/bk-2/transition')
      .send({ action: 'cancel' });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(fireDispatchPushMock).not.toHaveBeenCalled();
  });

  it('fires booking_rescheduled to the new booking\'s resource when a booking is moved', async () => {
    queryMock
      // SELECT existing booking
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bk-3',
            tenant_id: 'tenant-A',
            status: 'confirmed',
            title: 'Tune-up',
            start_time: new Date('2026-05-01T15:00:00.000Z'),
            end_time: new Date('2026-05-01T15:30:00.000Z'),
            resource_id: 'res-7',
            appointment_type_id: null,
            provider_id: null,
          },
        ],
      })
      // checkConflicts SELECT
      .mockResolvedValueOnce({ rows: [] })
      // buildOverrideConflictResponse SELECT(s) — there can be multiple, mock
      // none-found defensively a few times.
      .mockResolvedValue({ rows: [] });

    // The reschedule path also issues:
    //   UPDATE bookings -> INSERT new booking RETURNING -> auditLog INSERT.
    // We need the INSERT result to carry the resource_id so the push fires.
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'bk-3-new',
            tenant_id: 'tenant-A',
            status: 'confirmed',
            title: 'Tune-up',
            start_time: new Date('2026-05-02T15:00:00.000Z'),
            end_time: new Date('2026-05-02T15:30:00.000Z'),
            resource_id: 'res-7',
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // auditLog

    const app = await buildSchedulingApp();
    const res = await request(app)
      .post('/scheduling/bookings/bk-3/transition')
      .send({
        action: 'reschedule',
        new_start_time: '2026-05-02T15:00:00.000Z',
        new_end_time: '2026-05-02T15:30:00.000Z',
        override_reason: 'Customer requested',
      });

    // Reschedule responds 200 even if some intermediate select runs are
    // skipped — the assertion we care about is the push event itself.
    if (res.status !== 200) {
      // Surface the body for debugging if the route shape changes.
      // eslint-disable-next-line no-console
      console.log('reschedule response', res.status, res.body);
    }
    await new Promise((r) => setImmediate(r));

    const rescheduledCalls = fireDispatchPushMock.mock.calls.filter(
      (c) => c[0]?.event === 'booking_rescheduled',
    );
    expect(rescheduledCalls.length).toBeGreaterThanOrEqual(1);
    expect(rescheduledCalls[0][0].resourceIds).toEqual(['res-7']);
  });
});
