/**
 * Regression coverage for the technician-push fan-out wired into the
 * admin dispatch and scheduling routes.
 *
 * The routes under test (`createJobHandler`, `updateJobHandler`,
 * `transitionJobHandler`, `batchUpdateHandler`, `transitionBookingHandler`)
 * call `pushAssigneeForJob` (which in turn calls `fireDispatchPush`) or
 * `fireDispatchPush` directly. The mobile push spec calls these out as
 * the "tech learns about a new job / status change without refreshing"
 * lifecycle moments, so we mock `platform/notifications/dispatchPush`
 * and assert it fires with the correct event name + payload.
 *
 * Equally important: when an admin only edits cosmetic fields (priority,
 * title) without changing assignment or status, the push must NOT fire —
 * otherwise techs would get spammed every time a dispatcher relabels a
 * card on the board.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

// `vi.hoisted` ensures the mocks below are initialized before any
// `vi.mock` factory runs (factories are hoisted to the top of the file).
const { queryMock, fireDispatchPushMock, dispatchEventMock, enqueueGeocodeMock } =
  vi.hoisted(() => ({
    queryMock: vi.fn(),
    fireDispatchPushMock: vi.fn(async () => null),
    dispatchEventMock: vi.fn(async () => ({ success: true })),
    enqueueGeocodeMock: vi.fn(),
  }));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  withTenantContext: vi.fn(async () => {}),
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

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      email: 'admin@acme.test',
      role: 'tenant_owner',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../platform/notifications/dispatchPush', () => ({
  fireDispatchPush: fireDispatchPushMock,
}));

// `enqueueJobGeocode` is fire-and-forget on every job-create / address
// change. Stub the entire routing module so the queue / provider lookup
// never tries to touch real config.
vi.mock('../../platform/integrations/routing', async () => {
  return {
    enqueueJobGeocode: enqueueGeocodeMock,
    geocodeAddressCached: vi.fn(async () => null),
    getDriveEta: vi.fn(async () => null),
    haversineMeters: vi.fn(() => 0),
  };
});

// The lifecycle event fan-out (calendar adapters) is exercised by the
// schedulingLifecycleEvents suite. Stub it here so the reschedule test
// doesn't need to assert on the calendar payload too.
vi.mock('../../platform/integrations/connectors', () => ({
  connectorService: {
    dispatchEvent: dispatchEventMock,
  },
}));

vi.mock('../../server/replit_integrations/object_storage', () => ({
  ObjectStorageService: class {},
  ObjectNotFoundError: class extends Error {},
}));

// Route-export stream + email / SSE limiter fan-outs are unrelated to
// the push pipeline and would otherwise pull in heavy real-world deps.
vi.mock('../../platform/notifications/routeExportEvents', () => ({
  emitRouteExportStatusChanged: vi.fn(),
  subscribeRouteExportEvents: vi.fn(() => () => {}),
}));

vi.mock('../../platform/email', () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  dispatchRouteExportReadyEmail: vi.fn(async () => ({ success: true })),
  dispatchRouteExportFailedEmail: vi.fn(async () => ({ success: true })),
}));

const TENANT = 'tenant-1';

interface QueuedQuery {
  match?: RegExp;
  rows?: unknown[];
  rowCount?: number;
  throws?: Error;
}

const queryQueue: QueuedQuery[] = [];

function queueQueries(...queries: QueuedQuery[]): void {
  queryQueue.push(...queries);
}

beforeEach(() => {
  queryQueue.length = 0;
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (queryQueue.length === 0) {
      throw new Error(`Unexpected query (no mock queued):\n${sql}`);
    }
    const next = queryQueue.shift()!;
    if (next.match && !next.match.test(sql)) {
      throw new Error(
        `Query did not match expected pattern.\nExpected: ${next.match}\nGot: ${sql}`,
      );
    }
    if (next.throws) throw next.throws;
    const rows = next.rows ?? [];
    return { rows, rowCount: next.rowCount ?? rows.length };
  });
  fireDispatchPushMock.mockClear();
  dispatchEventMock.mockClear();
  enqueueGeocodeMock.mockClear();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const dispatchRouter = (await import('../../server/admin-api/routes/dispatch')).default;
  const schedulingRouter = (await import('../../server/admin-api/routes/scheduling')).default;
  app.use(dispatchRouter);
  app.use(schedulingRouter);
  return app;
}

// Lets fire-and-forget `void pushAssigneeForJob(...)` runs (which await
// an internal SELECT before calling `fireDispatchPush`) settle before we
// inspect the mock. setImmediate twice is enough because the helper does
// at most a single `await`.
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const JOB_LOOKUP_RX =
  /SELECT\s+id,\s*title,\s*status,\s*contact_name,\s*address[^]*FROM\s+dispatch_jobs/i;

function jobLookupRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    title: 'Replace water heater',
    status: 'assigned',
    contact_name: 'Jane Doe',
    address: '500 Folsom St, SF',
    scheduled_at: null,
    eta_start: null,
    resource_id: 'res-1',
    assignee_user_id: null,
    ...overrides,
  };
}

describe('Dispatch push: createJobHandler', () => {
  it('fires job_assigned when a new job is created already-assigned to a resource', async () => {
    queueQueries(
      // user_roles check (assignee_user_id present)
      { match: /FROM user_roles/i, rows: [{ user_id: 'tech-7' }] },
      // validateResourceAssignment SELECT
      {
        match: /FROM dispatch_resources/i,
        rows: [
          {
            id: 'res-1',
            current_status: 'available',
            max_concurrent_jobs: 5,
            territory_id: null,
            status: 'active',
            shift_start: null,
            shift_end: null,
            shift_days: null,
            active_jobs: 0,
            skill_names: null,
          },
        ],
      },
      // INSERT INTO dispatch_jobs RETURNING *
      {
        match: /INSERT INTO dispatch_jobs/i,
        rows: [
          {
            id: 'job-1',
            tenant_id: TENANT,
            resource_id: 'res-1',
            assignee_user_id: 'tech-7',
            address: '',
          },
        ],
      },
      // INSERT INTO dispatch_job_events
      { match: /INSERT INTO dispatch_job_events/i, rows: [] },
      // pushAssigneeForJob → SELECT id, title, status... FROM dispatch_jobs
      { match: JOB_LOOKUP_RX, rows: [jobLookupRow({ status: 'pending' })] },
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs')
      .send({
        title: 'Replace water heater',
        resource_id: 'res-1',
        assignee_user_id: 'tech-7',
      });

    expect(res.status).toBe(201);
    await flushMicrotasks();

    expect(fireDispatchPushMock).toHaveBeenCalledTimes(1);
    expect(fireDispatchPushMock.mock.calls[0][0]).toMatchObject({
      event: 'job_assigned',
      tenantId: TENANT,
      resourceIds: ['res-1'],
    });
  });

  it('does NOT fire any push when a job is created with no assignee or resource', async () => {
    queueQueries(
      // INSERT INTO dispatch_jobs RETURNING *
      {
        match: /INSERT INTO dispatch_jobs/i,
        rows: [
          {
            id: 'job-1',
            tenant_id: TENANT,
            resource_id: null,
            assignee_user_id: null,
            address: '',
          },
        ],
      },
      // INSERT INTO dispatch_job_events
      { match: /INSERT INTO dispatch_job_events/i, rows: [] },
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs')
      .send({ title: 'Triage' });

    expect(res.status).toBe(201);
    await flushMicrotasks();

    expect(fireDispatchPushMock).not.toHaveBeenCalled();
  });
});

describe('Dispatch push: transitionJobHandler', () => {
  it('fires job_status_en_route on assigned → en_route', async () => {
    queueQueries(
      // SELECT id, status FROM dispatch_jobs (existing lookup)
      {
        match: /SELECT id, status FROM dispatch_jobs/i,
        rows: [{ id: 'job-1', status: 'assigned' }],
      },
      // UPDATE dispatch_jobs RETURNING *
      {
        match: /UPDATE dispatch_jobs/i,
        rows: [{ id: 'job-1', status: 'en_route', resource_id: 'res-1' }],
      },
      // INSERT INTO dispatch_job_events
      { match: /INSERT INTO dispatch_job_events/i, rows: [] },
      // fireNotifications → SELECT templates (none)
      { match: /FROM dispatch_notification_templates/i, rows: [] },
      // pushAssigneeForJob → SELECT id, title, status... FROM dispatch_jobs
      { match: JOB_LOOKUP_RX, rows: [jobLookupRow({ status: 'en_route' })] },
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-1/transition')
      .send({ status: 'en_route' });

    expect(res.status).toBe(200);
    await flushMicrotasks();

    expect(fireDispatchPushMock).toHaveBeenCalledTimes(1);
    expect(fireDispatchPushMock.mock.calls[0][0]).toMatchObject({
      event: 'job_status_en_route',
      tenantId: TENANT,
      resourceIds: ['res-1'],
      job: { id: 'job-1', status: 'en_route' },
    });
  });

  it('fires job_status_on_site on en_route → on_site', async () => {
    queueQueries(
      {
        match: /SELECT id, status FROM dispatch_jobs/i,
        rows: [{ id: 'job-1', status: 'en_route' }],
      },
      {
        match: /UPDATE dispatch_jobs/i,
        rows: [{ id: 'job-1', status: 'on_site', resource_id: 'res-1' }],
      },
      { match: /INSERT INTO dispatch_job_events/i, rows: [] },
      { match: /FROM dispatch_notification_templates/i, rows: [] },
      { match: JOB_LOOKUP_RX, rows: [jobLookupRow({ status: 'on_site' })] },
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-1/transition')
      .send({ status: 'on_site' });

    expect(res.status).toBe(200);
    await flushMicrotasks();

    expect(fireDispatchPushMock).toHaveBeenCalledTimes(1);
    expect(fireDispatchPushMock.mock.calls[0][0]).toMatchObject({
      event: 'job_status_on_site',
      tenantId: TENANT,
      resourceIds: ['res-1'],
    });
  });

  it('does NOT fire push for transitions that have no push event mapping (in_progress)', async () => {
    // STATUS_TO_PUSH_EVENT only covers en_route / on_site / cancelled.
    // A transition like assigned → in_progress is a valid state-machine
    // move but should not generate a push — the tech is already on the
    // job and a redundant notification would be noise.
    queueQueries(
      {
        match: /SELECT id, status FROM dispatch_jobs/i,
        rows: [{ id: 'job-1', status: 'assigned' }],
      },
      {
        match: /UPDATE dispatch_jobs/i,
        rows: [{ id: 'job-1', status: 'in_progress', resource_id: 'res-1' }],
      },
      { match: /INSERT INTO dispatch_job_events/i, rows: [] },
      { match: /FROM dispatch_notification_templates/i, rows: [] },
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-1/transition')
      .send({ status: 'in_progress' });

    expect(res.status).toBe(200);
    await flushMicrotasks();

    expect(fireDispatchPushMock).not.toHaveBeenCalled();
  });
});

describe('Dispatch push: updateJobHandler (PUT /dispatch/jobs/:id)', () => {
  it('fires job_assigned when an unassigned job is reassigned to a resource', async () => {
    queueQueries(
      // SELECT existing
      {
        match: /SELECT id, status as current_status, assignee_user_id/i,
        rows: [
          {
            id: 'job-1',
            current_status: 'pending',
            assignee_user_id: null,
            cur_territory_id: null,
            cur_required_skills: null,
            cur_scheduled_at: null,
            cur_address: '',
          },
        ],
      },
      // validateResourceAssignment
      {
        match: /FROM dispatch_resources/i,
        rows: [
          {
            id: 'res-1',
            current_status: 'available',
            max_concurrent_jobs: 5,
            territory_id: null,
            status: 'active',
            shift_start: null,
            shift_end: null,
            shift_days: null,
            active_jobs: 0,
            skill_names: null,
          },
        ],
      },
      // UPDATE dispatch_jobs RETURNING *
      {
        match: /UPDATE dispatch_jobs/i,
        rows: [
          {
            id: 'job-1',
            resource_id: 'res-1',
            assignee_user_id: null,
            address: '',
          },
        ],
      },
      // pushAssigneeForJob → SELECT id, title, status... FROM dispatch_jobs
      { match: JOB_LOOKUP_RX, rows: [jobLookupRow({ status: 'pending' })] },
    );

    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/jobs/job-1')
      .send({ resource_id: 'res-1' });

    expect(res.status).toBe(200);
    await flushMicrotasks();

    expect(fireDispatchPushMock).toHaveBeenCalledTimes(1);
    expect(fireDispatchPushMock.mock.calls[0][0]).toMatchObject({
      event: 'job_assigned',
      tenantId: TENANT,
      resourceIds: ['res-1'],
    });
  });

  it('does NOT fire push when only priority and title change (no assignee or status change)', async () => {
    queueQueries(
      // SELECT existing — already assigned to res-1; we are not touching
      // assignment or status, so the push pipeline must stay quiet.
      {
        match: /SELECT id, status as current_status, assignee_user_id/i,
        rows: [
          {
            id: 'job-1',
            current_status: 'assigned',
            assignee_user_id: null,
            cur_territory_id: null,
            cur_required_skills: null,
            cur_scheduled_at: null,
            cur_address: '',
          },
        ],
      },
      // UPDATE dispatch_jobs RETURNING *
      {
        match: /UPDATE dispatch_jobs/i,
        rows: [
          {
            id: 'job-1',
            resource_id: 'res-1',
            assignee_user_id: null,
            address: '',
          },
        ],
      },
    );

    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/jobs/job-1')
      .send({ priority: 'high', title: 'Updated title' });

    expect(res.status).toBe(200);
    await flushMicrotasks();

    expect(fireDispatchPushMock).not.toHaveBeenCalled();
  });
});

describe('Dispatch push: batchUpdateHandler', () => {
  it('fires job_assigned for every job touched when a batch reassigns to a resource (no status change)', async () => {
    queueQueries(
      // validateResourceAssignment SELECT
      {
        match: /FROM dispatch_resources/i,
        rows: [
          {
            id: 'res-1',
            current_status: 'available',
            max_concurrent_jobs: 5,
            territory_id: null,
            status: 'active',
            shift_start: null,
            shift_end: null,
            shift_days: null,
            active_jobs: 0,
            skill_names: null,
          },
        ],
      },
      // UPDATE dispatch_jobs RETURNING id (no status branch)
      {
        match: /UPDATE dispatch_jobs/i,
        rows: [{ id: 'job-1' }, { id: 'job-2' }],
      },
      // pushAssigneeForJob lookups, one per row
      { match: JOB_LOOKUP_RX, rows: [jobLookupRow({ id: 'job-1' })] },
      {
        match: JOB_LOOKUP_RX,
        rows: [jobLookupRow({ id: 'job-2', resource_id: 'res-1' })],
      },
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/batch')
      .send({ job_ids: ['job-1', 'job-2'], resource_id: 'res-1' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    await flushMicrotasks();

    expect(fireDispatchPushMock).toHaveBeenCalledTimes(2);
    for (const call of fireDispatchPushMock.mock.calls) {
      expect(call[0]).toMatchObject({
        event: 'job_assigned',
        tenantId: TENANT,
      });
    }
  });

  it('does NOT fire push when a batch only changes priority (no status, no assignment)', async () => {
    queueQueries(
      {
        match: /UPDATE dispatch_jobs/i,
        rows: [{ id: 'job-1' }, { id: 'job-2' }],
      },
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/batch')
      .send({ job_ids: ['job-1', 'job-2'], priority: 'high' });

    expect(res.status).toBe(200);
    await flushMicrotasks();

    expect(fireDispatchPushMock).not.toHaveBeenCalled();
  });
});

describe('Booking push: transitionBookingHandler reschedule', () => {
  it('fires booking_rescheduled to the assigned resource when a booking is moved into a new slot', async () => {
    queueQueries(
      // SELECT existing booking
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: 'bk-original',
            tenant_id: TENANT,
            title: 'Annual checkup',
            status: 'confirmed',
            start_time: '2026-05-01T15:00:00.000Z',
            end_time: '2026-05-01T15:30:00.000Z',
            contact_name: 'Acme HQ',
            contact_phone: '+15551234567',
            agent_id: 'agent-1',
            provider_id: 'prov-a',
            resource_id: 'res-1',
            timezone: 'America/Los_Angeles',
          },
        ],
      },
      // checkConflicts → none
      { match: /FROM bookings WHERE/i, rows: [] },
      // findBlockingOverride → none (getTenantTimezone reads tenants
      // first, then scheduling_overrides — both rolled into the override
      // helper, which only runs when override_reason is empty).
      { match: /FROM tenants/i, rows: [{ timezone: 'America/Los_Angeles' }] },
      { match: /FROM scheduling_overrides/i, rows: [] },
      // UPDATE bookings (set status = rescheduled)
      { match: /UPDATE bookings/i, rows: [], rowCount: 1 },
      // INSERT INTO bookings RETURNING *  → the new booking row
      {
        match: /INSERT INTO bookings/i,
        rows: [
          {
            id: 'bk-new',
            tenant_id: TENANT,
            title: 'Annual checkup',
            status: 'confirmed',
            start_time: '2026-05-02T15:00:00.000Z',
            end_time: '2026-05-02T15:30:00.000Z',
            resource_id: 'res-1',
          },
        ],
      },
      // INSERT INTO scheduling_audit_log
      { match: /INSERT INTO scheduling_audit_log/i, rows: [] },
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/scheduling/bookings/bk-original/transition')
      .send({
        action: 'reschedule',
        new_start_time: '2026-05-02T15:00:00.000Z',
        new_end_time: '2026-05-02T15:30:00.000Z',
      });

    expect(res.status).toBe(200);
    expect(res.body.booking.id).toBe('bk-new');
    await flushMicrotasks();

    expect(fireDispatchPushMock).toHaveBeenCalledTimes(1);
    expect(fireDispatchPushMock.mock.calls[0][0]).toMatchObject({
      event: 'booking_rescheduled',
      tenantId: TENANT,
      resourceIds: ['res-1'],
      booking: {
        id: 'bk-new',
        title: 'Annual checkup',
        start_time: '2026-05-02T15:00:00.000Z',
      },
    });
  });

  it('does NOT fire push on reschedule when the booking has no assigned resource', async () => {
    queueQueries(
      {
        match: /FROM bookings WHERE id = \$1 AND tenant_id = \$2/i,
        rows: [
          {
            id: 'bk-original',
            tenant_id: TENANT,
            title: 'Annual checkup',
            status: 'confirmed',
            start_time: '2026-05-01T15:00:00.000Z',
            end_time: '2026-05-01T15:30:00.000Z',
            contact_phone: '+15551234567',
            agent_id: 'agent-1',
            provider_id: 'prov-a',
            resource_id: null,
            timezone: 'America/Los_Angeles',
          },
        ],
      },
      { match: /FROM bookings WHERE/i, rows: [] },
      { match: /FROM tenants/i, rows: [{ timezone: 'America/Los_Angeles' }] },
      { match: /FROM scheduling_overrides/i, rows: [] },
      { match: /UPDATE bookings/i, rows: [], rowCount: 1 },
      {
        match: /INSERT INTO bookings/i,
        rows: [
          {
            id: 'bk-new',
            tenant_id: TENANT,
            title: 'Annual checkup',
            status: 'confirmed',
            start_time: '2026-05-02T15:00:00.000Z',
            end_time: '2026-05-02T15:30:00.000Z',
            resource_id: null,
          },
        ],
      },
      { match: /INSERT INTO scheduling_audit_log/i, rows: [] },
    );

    const app = await buildApp();
    const res = await request(app)
      .post('/scheduling/bookings/bk-original/transition')
      .send({
        action: 'reschedule',
        new_start_time: '2026-05-02T15:00:00.000Z',
        new_end_time: '2026-05-02T15:30:00.000Z',
      });

    expect(res.status).toBe(200);
    await flushMicrotasks();

    expect(fireDispatchPushMock).not.toHaveBeenCalled();
  });
});
