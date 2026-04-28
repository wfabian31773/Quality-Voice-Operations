// Verifies the customer-facing booking-tracker endpoint:
//   - 404 for unknown / malformed tokens
//   - returns the public-safe payload for a found job
//   - computes a live driving ETA when the job is en_route and the
//     technician has a fresh fix
//   - omits live_eta when the job is not en_route
//   - omits live_eta when the latest fix is stale
//   - never leaks the contact's phone, the tenant id, or the job's
//     internal UUID
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

function makeReq(token: string): Request {
  return {
    params: { token },
    query: {},
    body: {},
    method: 'GET',
    headers: {},
    cookies: {},
    ip: '127.0.0.1',
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

describe('getPublicJobTrackerHandler', () => {
  it('returns 404 for an obviously malformed token without hitting the database', async () => {
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus } = makeRes();
    await (dispatch.getPublicJobTrackerHandler as (
      req: Request,
      res: Response,
    ) => Promise<void>)(makeReq('not a valid token!!'), res);
    expect(getStatus()).toBe(404);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 404 when no job matches the token', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus } = makeRes();
    await (dispatch.getPublicJobTrackerHandler as (
      req: Request,
      res: Response,
    ) => Promise<void>)(makeReq('11111111-1111-1111-1111-111111111111'), res);
    expect(getStatus()).toBe(404);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/tracking_token\s*=\s*\$1/);
  });

  it('includes a live_eta when the job is en_route and the tech has a fresh fix', async () => {
    const { __resetRoutingCachesForTests } = await import(
      '../../platform/integrations/routing'
    );
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'job-1',
          tenant_id: 'tenant-A',
          title: 'Water heater',
          status: 'en_route',
          contact_name: 'Jane',
          address: '500 Folsom St, SF',
          scheduled_at: new Date('2026-04-28T15:00:00Z'),
          eta_start: null,
          eta_end: null,
          completed_at: null,
          resource_id: 'res-1',
          address_lat: '37.7849',
          address_lon: '-122.4094',
          address_geocoded_for: '500 Folsom St, SF',
          resource_name: 'Alex Diaz',
        },
      ],
    });
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          latitude: '37.7749',
          longitude: '-122.4194',
          received_at: new Date().toISOString(),
        },
      ],
    });
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          address_lat: '37.7849',
          address_lon: '-122.4094',
          address_geocoded_for: '500 Folsom St, SF',
        },
      ],
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getJson } = makeRes();
    await (dispatch.getPublicJobTrackerHandler as (
      req: Request,
      res: Response,
    ) => Promise<void>)(makeReq('11111111-1111-1111-1111-111111111111'), res);

    expect(getStatus()).toBe(200);
    const body = getJson() as Record<string, unknown>;
    const job = body.job as Record<string, unknown>;
    expect(job.status).toBe('en_route');
    expect(job.title).toBe('Water heater');
    expect(job.address).toBe('500 Folsom St, SF');
    // First-name only — no surname leakage from a guessable URL.
    expect(job.resource_name).toBe('Alex');
    const liveEta = body.live_eta as Record<string, unknown> | null;
    expect(liveEta).not.toBeNull();
    expect(typeof liveEta!.minutes).toBe('number');
    expect(liveEta!.minutes as number).toBeGreaterThan(0);
    expect(typeof liveEta!.arrival_at).toBe('string');
    expect(body.poll_interval_ms).toBeTypeOf('number');

    // Make sure we don't leak internal fields the customer shouldn't see.
    const flat = JSON.stringify(body);
    expect(flat).not.toContain('tenant-A');
    expect(flat).not.toContain('job-1');
    expect(flat).not.toContain('res-1');
    // Customer name should not echo back to the customer's own page —
    // the link is shareable and the recipient may not be the customer.
    expect(flat).not.toContain('Jane');
  });

  it('omits live_eta when the job is not en_route', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'job-2',
          tenant_id: 'tenant-A',
          title: 'Tune-up',
          status: 'scheduled',
          contact_name: 'Jane',
          address: '500 Folsom',
          scheduled_at: new Date('2026-04-29T15:00:00Z'),
          eta_start: null,
          eta_end: null,
          completed_at: null,
          resource_id: 'res-1',
          address_lat: null,
          address_lon: null,
          address_geocoded_for: null,
          resource_name: 'Alex',
        },
      ],
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getJson } = makeRes();
    await (dispatch.getPublicJobTrackerHandler as (
      req: Request,
      res: Response,
    ) => Promise<void>)(makeReq('22222222-2222-2222-2222-222222222222'), res);

    expect(getStatus()).toBe(200);
    const body = getJson() as Record<string, unknown>;
    expect(body.live_eta).toBeNull();
    // We only ran the initial SELECT — the routing cache was never touched
    // because we exited before computeLiveEtaForJob.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns live_eta=null gracefully when the latest fix is stale', async () => {
    const { __resetRoutingCachesForTests } = await import(
      '../../platform/integrations/routing'
    );
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'job-3',
          tenant_id: 'tenant-A',
          title: 'Repair',
          status: 'en_route',
          contact_name: 'Jane',
          address: '500 Folsom',
          scheduled_at: null,
          eta_start: null,
          eta_end: null,
          completed_at: null,
          resource_id: 'res-1',
          address_lat: '37.7849',
          address_lon: '-122.4094',
          address_geocoded_for: '500 Folsom',
          resource_name: 'Alex',
        },
      ],
    });
    // Stale fix: 1 hour old, beyond the 600s budget.
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          latitude: '37.7749',
          longitude: '-122.4194',
          received_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        },
      ],
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getJson } = makeRes();
    await (dispatch.getPublicJobTrackerHandler as (
      req: Request,
      res: Response,
    ) => Promise<void>)(makeReq('33333333-3333-3333-3333-333333333333'), res);

    expect(getStatus()).toBe(200);
    const body = getJson() as Record<string, unknown>;
    expect(body.live_eta).toBeNull();
    // Only the initial SELECT + the location lookup — no geocode call.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
