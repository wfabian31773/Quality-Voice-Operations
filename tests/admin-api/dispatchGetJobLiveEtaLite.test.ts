// Verifies the lightweight GET /dispatch/jobs/:id/live-eta endpoint
// the dispatcher's job-detail panel hits on its 15s polling tick.
// This handler intentionally avoids the full job/events/exceptions/
// attachments fetch the full GET /dispatch/jobs/:id endpoint does —
// only the live ETA (and current status, so the client can stop
// polling once the truck arrives) is returned.
//
//   - includes live_eta when status is en_route and the tech has a
//     fresh GPS fix (1 row-existence query + location + cached geocode)
//   - returns live_eta=null when the job is not en_route, with no
//     extra location/geocode lookups
//   - returns live_eta=null when the latest fix is stale (existence +
//     location lookup, but no geocode/routing call)
//   - returns 404 when the job is not found in the dispatcher's tenant
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

describe('getJobLiveEtaHandler', () => {
  it('includes live_eta when the job is en_route and the tech has a fresh fix', async () => {
    const { __resetRoutingCachesForTests } = await import(
      '../../platform/integrations/routing'
    );
    __resetRoutingCachesForTests();

    // 1. SELECT status/resource_id/address (existence + ETA inputs)
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          status: 'en_route',
          resource_id: 'res-1',
          address: '500 Folsom St, SF',
        },
      ],
    });
    // 2. computeLiveEtaForJob: SELECT location row (fresh fix)
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          latitude: '37.7749',
          longitude: '-122.4194',
          received_at: new Date().toISOString(),
        },
      ],
    });
    // 3. computeLiveEtaForJob: SELECT cached job geocode
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
    await (dispatch.getJobLiveEtaHandler as (
      req: Request,
      res: Response,
    ) => Promise<void>)(makeReq('job-1'), res);

    expect(getStatus()).toBe(200);
    const body = getJson() as Record<string, unknown>;
    expect(body.status).toBe('en_route');
    const liveEta = body.live_eta as Record<string, unknown> | null;
    expect(liveEta).not.toBeNull();
    expect(typeof liveEta!.minutes).toBe('number');
    expect(liveEta!.minutes as number).toBeGreaterThan(0);
    expect(typeof liveEta!.arrival_at).toBe('string');
    const arrivalAt = new Date(liveEta!.arrival_at as string);
    expect(Number.isFinite(arrivalAt.getTime())).toBe(true);
    // The lite endpoint never re-fetches events / exceptions /
    // attachments / joined resource+territory rows.
    expect(body.job).toBeUndefined();
    expect(body.events).toBeUndefined();
    expect(body.exceptions).toBeUndefined();
    expect(body.attachments).toBeUndefined();
    // Existence + location + cached geocode — no events/exceptions/
    // attachments lookups.
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('returns live_eta=null when the job is not en_route, without extra DB calls', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          status: 'scheduled',
          resource_id: 'res-1',
          address: '500 Folsom St, SF',
        },
      ],
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getJson } = makeRes();
    await (dispatch.getJobLiveEtaHandler as (
      req: Request,
      res: Response,
    ) => Promise<void>)(makeReq('job-2'), res);

    expect(getStatus()).toBe(200);
    const body = getJson() as Record<string, unknown>;
    expect(body.status).toBe('scheduled');
    expect(body.live_eta).toBeNull();
    // Just the row-existence query — no location/geocode lookup.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns live_eta=null when the latest fix is stale', async () => {
    const { __resetRoutingCachesForTests } = await import(
      '../../platform/integrations/routing'
    );
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          status: 'en_route',
          resource_id: 'res-1',
          address: '500 Folsom St, SF',
        },
      ],
    });
    // Stale fix: 1 hour old, beyond the 600s budget the helper enforces.
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
    await (dispatch.getJobLiveEtaHandler as (
      req: Request,
      res: Response,
    ) => Promise<void>)(makeReq('job-3'), res);

    expect(getStatus()).toBe(200);
    const body = getJson() as Record<string, unknown>;
    expect(body.status).toBe('en_route');
    expect(body.live_eta).toBeNull();
    // Existence + location lookup — we exited before the cached
    // geocode SELECT or any routing-provider call.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('returns 404 when the job is not in the dispatcher tenant', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getJson } = makeRes();
    await (dispatch.getJobLiveEtaHandler as (
      req: Request,
      res: Response,
    ) => Promise<void>)(makeReq('job-missing'), res);

    expect(getStatus()).toBe(404);
    const body = getJson() as Record<string, unknown>;
    expect(body.error).toBe('Job not found');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
