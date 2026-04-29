// Locks down the auto bad-arrival flag on the two non-transition completion
// paths: the mobile "complete with photos" attachment endpoint and the
// dispatcher batch-update endpoint. The flag itself is the same helper
// covered by `dispatchTransitionBadArrivalFlag.test.ts`; these tests only
// pin that the helper is wired in *and* gated correctly:
//
//   * `addAttachmentHandler` runs the check after a successful
//     `completion_transition` into `completed`/`done`, and only when the
//     prior status was not already a completion (so the
//     `completed → done` follow-up does not re-flag).
//   * `batchUpdateHandler` runs the check for every job the batch is
//     *newly* moving into a completion status, and skips jobs whose
//     prior status was already a completion.
//   * Neither path invokes the helper for non-completion targets
//     (e.g. an attachment without `completion_transition`, or a batch
//     status of `cancelled`).
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../../platform/notifications/dispatchPush', () => ({
  fireDispatchPush: vi.fn(),
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

vi.mock('../../platform/integrations/routing', async () => {
  const actual = await vi.importActual<
    typeof import('../../platform/integrations/routing')
  >('../../platform/integrations/routing');
  return {
    ...actual,
    geocodeAddressCached: vi.fn(),
  };
});

beforeEach(() => {
  queryMock.mockReset();
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

// The bad-arrival helper is `void`-called so the response can land
// before its secondary INSERTs do. Drain the microtask queue a few
// times to let those settle before asserting.
async function flushAsync(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

describe('POST /dispatch/jobs/:id/attachments — bad-arrival auto-flag', () => {
  it('flags when a mobile completion_transition into `completed` exceeds the 250 m threshold', async () => {
    // 1) SELECT job (id, status) — currently in_progress so the
    //    completion_transition is a *new* completion.
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-mob', status: 'in_progress' }],
    });
    // 2) INSERT dispatch_job_attachments
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'att-1' }],
    });
    // 3) INSERT dispatch_job_events (attachment_added)
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 4) UPDATE dispatch_jobs → completed
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-mob', status: 'completed' }],
    });
    // 5) INSERT dispatch_job_events (status_change)
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 6) fireNotifications template lookup for 'completed' trigger — none
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 7) flagBadArrivalIfNeeded — closest-approach SELECT
    queryMock.mockResolvedValueOnce({
      rows: [{ closest_approach_m: 612.7 }],
    });
    // 8) INSERT dispatch_job_exceptions
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'exc-1' }] });
    // 9) INSERT dispatch_job_events (exception_reported)
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 10) fireNotifications template lookup for 'exception' trigger — none
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-mob/attachments')
      .send({
        attachment_type: 'photo',
        title: 'Completion photo',
        content: 'photo proof',
        completion_transition: 'completed',
      });

    expect(res.status).toBe(201);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));

    // The same closest-approach SELECT the dispatch board badge runs.
    const approachSql = calls.find(s =>
      /6371000 \* 2 \* ASIN/.test(s) && /dispatch_resource_location_history/.test(s),
    );
    expect(approachSql).toBeDefined();
    expect(approachSql!).toMatch(/d\.address_lat\s+IS NOT NULL/);
    expect(approachSql!).toMatch(/d\.address_lon\s+IS NOT NULL/);

    // The exception is created with type `other` and a clear distance.
    const insertExceptionIdx = calls.findIndex(s =>
      /INSERT INTO dispatch_job_exceptions/.test(s),
    );
    expect(insertExceptionIdx).toBeGreaterThan(-1);
    const insertExceptionParams =
      queryMock.mock.calls[insertExceptionIdx][1] as unknown[];
    expect(insertExceptionParams[0]).toBe('job-mob');
    expect(insertExceptionParams[1]).toBe('tenant-A');
    expect(String(insertExceptionParams[2])).toMatch(/613 m/);
    expect(String(insertExceptionParams[2])).toMatch(/threshold 250 m/);
    expect(insertExceptionParams[3]).toBe('user-1');
    expect(calls[insertExceptionIdx]).toMatch(/'other'/);

    // The 'exception' notification trigger is queried so dispatchers
    // see the auto-flag on the same notification feed.
    const exceptionTriggerCall = queryMock.mock.calls.find(c => {
      const sql = String(c[0]);
      const params = c[1] as unknown[] | undefined;
      return /dispatch_notification_templates/.test(sql)
        && Array.isArray(params)
        && params.includes('exception');
    });
    expect(exceptionTriggerCall).toBeDefined();
  });

  it('does not flag when the attachment has no completion_transition', async () => {
    // 1) SELECT job
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-noop', status: 'in_progress' }],
    });
    // 2) INSERT attachment
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'att-2' }] });
    // 3) INSERT event (attachment_added)
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-noop/attachments')
      .send({
        attachment_type: 'note',
        content: 'just a note, not a completion',
      });

    expect(res.status).toBe(201);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(s => /6371000 \* 2 \* ASIN/.test(s))).toBe(false);
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });

  it('does not re-flag on a `completed → done` follow-up via attachment', async () => {
    // The job is already completed; uploading the signed proof as a
    // `done` follow-up must not re-evaluate the bad-arrival check.
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-done-followup', status: 'completed' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'att-3' }] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    // UPDATE dispatch_jobs (transition completed → done)
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-done-followup', status: 'done' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    // fireNotifications template lookup (no templates)
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-done-followup/attachments')
      .send({
        attachment_type: 'signature',
        title: 'Customer signature',
        completion_transition: 'done',
      });

    expect(res.status).toBe(201);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(s => /6371000 \* 2 \* ASIN/.test(s))).toBe(false);
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });

  it('skips silently when the closest approach is at or below the threshold via attachment', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-near', status: 'in_progress' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'att-near' }] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-near', status: 'completed' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    // closest-approach SELECT — exactly 250 m, gate is strict `>`
    queryMock.mockResolvedValueOnce({
      rows: [{ closest_approach_m: 250 }],
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-near/attachments')
      .send({
        attachment_type: 'photo',
        title: 'On-site photo',
        completion_transition: 'completed',
      });

    expect(res.status).toBe(201);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });
});

describe('POST /dispatch/jobs/batch — bad-arrival auto-flag', () => {
  it('flags every job newly completing in the batch and skips jobs already completed', async () => {
    // 1) SELECT current jobs — `job-a` is in_progress (will newly
    //    complete), `job-b` is already completed (must not be
    //    re-flagged when the batch transitions it to `done`).
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 'job-a', status: 'in_progress' },
        { id: 'job-b', status: 'completed' },
      ],
    });
    // 2) UPDATE dispatch_jobs RETURNING id
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-a' }, { id: 'job-b' }],
      rowCount: 2,
    });
    // 3) INSERT dispatch_job_events (batch_update) for job-a
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 4) INSERT dispatch_job_events (batch_update) for job-b
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 5) flagBadArrivalIfNeeded for job-a — closest-approach SELECT
    queryMock.mockResolvedValueOnce({
      rows: [{ closest_approach_m: 480 }],
    });
    // 6) INSERT dispatch_job_exceptions for job-a
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'exc-a' }] });
    // 7) INSERT dispatch_job_events (exception_reported) for job-a
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 8) fireNotifications template lookup ('exception')
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    // Note: batch validates that the requested transition is allowed
    // for every current status. `completed → done` is allowed and
    // `in_progress → done` is allowed, so a single `done` target
    // covers both fixtures here.
    const res = await request(app)
      .post('/dispatch/jobs/batch')
      .send({ job_ids: ['job-a', 'job-b'], status: 'done' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));

    // Exactly one closest-approach SELECT — only job-a was newly
    // completing. job-b was already `completed`, so the `prev !==
    // completed/done` gate must skip it.
    const approachCalls = calls.filter(s =>
      /6371000 \* 2 \* ASIN/.test(s) && /dispatch_resource_location_history/.test(s),
    );
    expect(approachCalls).toHaveLength(1);

    // Exactly one exception inserted, and it's for job-a.
    const exceptionInsertIdxs = calls
      .map((s, i) => (/INSERT INTO dispatch_job_exceptions/.test(s) ? i : -1))
      .filter(i => i >= 0);
    expect(exceptionInsertIdxs).toHaveLength(1);
    const exceptionParams =
      queryMock.mock.calls[exceptionInsertIdxs[0]][1] as unknown[];
    expect(exceptionParams[0]).toBe('job-a');
    expect(exceptionParams[1]).toBe('tenant-A');
    expect(String(exceptionParams[2])).toMatch(/480 m/);
    expect(exceptionParams[3]).toBe('user-1');
  });

  it('does not flag any job when the batch target is a non-completion status', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 'job-c', status: 'pending' },
        { id: 'job-d', status: 'pending' },
      ],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-c' }, { id: 'job-d' }],
      rowCount: 2,
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/batch')
      .send({ job_ids: ['job-c', 'job-d'], status: 'cancelled' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(s => /6371000 \* 2 \* ASIN/.test(s))).toBe(false);
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });

  it('skips silently when a batched job has no breadcrumbs (closest_approach_m IS NULL)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-e', status: 'in_progress' }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-e' }],
      rowCount: 1,
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    // closest-approach SELECT returns NULL → no signal, no insert.
    queryMock.mockResolvedValueOnce({
      rows: [{ closest_approach_m: null }],
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/batch')
      .send({ job_ids: ['job-e'], status: 'completed' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    // The closest-approach SELECT did fire — the helper *was* invoked,
    // it just didn't have a signal to flag on.
    expect(calls.some(s => /6371000 \* 2 \* ASIN/.test(s))).toBe(true);
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });
});
