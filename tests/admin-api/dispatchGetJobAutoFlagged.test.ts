// Verifies the dispatcher-facing GET /dispatch/jobs/:id endpoint surfaces
// the `auto_flagged` tag on each exception row so the dispatch UI can
// render an "Auto" badge and a source filter that distinguishes
// system-inserted bad-arrival rows from human-reported ones.
//
// The metadata lives on the matching `exception_reported` event row
// (see `flagBadArrivalIfNeeded` in server/admin-api/routes/dispatch.ts);
// `getJobHandler` joins the two via a correlated subquery and surfaces
// the value as `exception.auto_flagged` (NULL for human-reported rows).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

const queryMock = vi.fn();

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
  requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (_req: Request, _res: Response, next: () => void) => next(),
  requireRole: () => (_req: Request, _res: Response, next: () => void) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock('../../server/replit_integrations/object_storage', () => ({
  ObjectStorageService: class {},
  ObjectNotFoundError: class extends Error {},
}));

function makeRes(): {
  res: Response;
  getStatus: () => number;
  getJson: () => Record<string, unknown> | null;
} {
  let statusCode = 200;
  let body: Record<string, unknown> | null = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return {
        json: (b: Record<string, unknown>) => {
          body = b;
        },
      };
    },
    json: (b: Record<string, unknown>) => {
      body = b;
    },
  } as unknown as Response;
  return { res, getStatus: () => statusCode, getJson: () => body };
}

function makeReq(jobId: string): Request {
  return {
    params: { id: jobId },
    query: {},
    body: {},
    method: 'GET',
    headers: {},
    cookies: {},
    ip: '127.0.0.1',
    user: { tenantId: 'tenant-A', userId: 'user-1' },
  } as unknown as Request;
}

beforeEach(() => {
  queryMock.mockReset();
  vi.resetModules();
  process.env.DISPATCH_ROUTING_PROVIDER = 'haversine';
  process.env.DISPATCH_GEOCODE_PROVIDER = 'none';
});

afterEach(() => {
  delete process.env.DISPATCH_ROUTING_PROVIDER;
  delete process.env.DISPATCH_GEOCODE_PROVIDER;
});

describe('getJobHandler exception source surfacing', () => {
  it('joins exceptions to their `exception_reported` event metadata and exposes auto_flagged', async () => {
    // 1. SELECT job
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'job-1',
          tenant_id: 'tenant-A',
          status: 'completed',
          resource_id: null,
          address: '',
        },
      ],
    });
    // 2. SELECT events
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 3. SELECT exceptions (with auto_flagged correlated subquery). Mocked
    //    here as if the SQL had returned: one auto-inserted bad-arrival row
    //    and one human-reported delay row.
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'exc-auto',
          tenant_id: 'tenant-A',
          job_id: 'job-1',
          exception_type: 'other',
          reason: 'Auto-flagged: closest GPS ping was 613 m from the customer address',
          resolution: '',
          resolved_at: null,
          created_at: new Date().toISOString(),
          auto_flagged: 'bad_arrival',
        },
        {
          id: 'exc-human',
          tenant_id: 'tenant-A',
          job_id: 'job-1',
          exception_type: 'delay',
          reason: 'Tech reported 20 min delay',
          resolution: '',
          resolved_at: null,
          created_at: new Date().toISOString(),
          auto_flagged: null,
        },
      ],
    });
    // 4. SELECT attachments
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getJson } = makeRes();
    await (dispatch.getJobHandler as (
      req: Request,
      res: Response,
    ) => Promise<void>)(makeReq('job-1'), res);

    expect(getStatus()).toBe(200);

    // The exceptions SELECT must join to the `dispatch_job_events` rows
    // tagged with the matching `exception_id` and surface the
    // `auto_flagged` metadata key, otherwise the UI cannot tell system-
    // inserted rows apart from human-reported ones.
    const exceptionsCall = queryMock.mock.calls.find(c =>
      /FROM dispatch_job_exceptions/.test(String(c[0]))
      && /auto_flagged/.test(String(c[0])),
    );
    expect(exceptionsCall).toBeDefined();
    const exceptionsSql = String(exceptionsCall![0]);
    expect(exceptionsSql).toMatch(/FROM dispatch_job_events/);
    expect(exceptionsSql).toMatch(/exception_reported/);
    expect(exceptionsSql).toMatch(/metadata->>'exception_id'/);
    expect(exceptionsSql).toMatch(/metadata->>'auto_flagged'/);

    // The response payload exposes the surfaced tag verbatim — `bad_arrival`
    // for the auto row, `null` for the human-reported one — so the client
    // can render an "Auto" badge and the source filter without a second
    // round-trip.
    const body = getJson() as Record<string, unknown>;
    const exceptions = body.exceptions as Array<Record<string, unknown>>;
    expect(exceptions).toHaveLength(2);
    expect(exceptions[0].id).toBe('exc-auto');
    expect(exceptions[0].auto_flagged).toBe('bad_arrival');
    expect(exceptions[1].id).toBe('exc-human');
    expect(exceptions[1].auto_flagged).toBeNull();
  });
});
