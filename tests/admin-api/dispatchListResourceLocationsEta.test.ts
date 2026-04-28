// Verifies the ETA enrichment that listResourceLocationsHandler layers
// on top of the live-map query: lazy geocode + persist, per-tenant
// cache, haversine fallback labelling, and graceful behavior when no
// resources are reporting.
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

function makeRes(): { res: Response; getStatus: () => number; getJson: () => Record<string, unknown> | null } {
  let statusCode = 200;
  let body: Record<string, unknown> | null = null;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return { json: (b: Record<string, unknown>) => { body = b; } };
    },
    json: (b: Record<string, unknown>) => { body = b; },
  } as unknown as Response;
  return { res, getStatus: () => statusCode, getJson: () => body };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { userId: 'u1', tenantId: 'tenant-A', email: 'u@test', role: 'tenant_owner', isPlatformAdmin: false },
    query: {},
    params: {},
    body: {},
    method: 'GET',
    headers: {},
    cookies: {},
    ...overrides,
  } as unknown as Request;
}

beforeEach(() => {
  queryMock.mockReset();
  vi.resetModules();
  // Force the haversine provider so we don't make outbound network
  // calls during the unit test.
  process.env.DISPATCH_ROUTING_PROVIDER = 'haversine';
  process.env.DISPATCH_GEOCODE_PROVIDER = 'none';
});

afterEach(() => {
  delete process.env.DISPATCH_ROUTING_PROVIDER;
  delete process.env.DISPATCH_GEOCODE_PROVIDER;
});

describe('listResourceLocationsHandler ETA enrichment', () => {
  it('attaches eta_minutes from the haversine adapter when the job is already geocoded', async () => {
    const { __resetRoutingCachesForTests } = await import('../../platform/integrations/routing');
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          resource_id: 'res-1',
          latitude: '37.7749',
          longitude: '-122.4194',
          accuracy_m: null,
          heading_deg: null,
          speed_mps: null,
          active_job_id: 'job-1',
          active_status: 'en_route',
          recorded_at: new Date().toISOString(),
          received_at: new Date().toISOString(),
          resource_name: 'Alex',
          resource_role: 'tech',
          resource_current_status: 'busy',
          job_title: 'Water heater',
          job_contact_name: 'Jane',
          job_address: '500 Folsom St, SF',
          job_status: 'en_route',
          job_address_lat: '37.7849',
          job_address_lon: '-122.4094',
          job_address_geocoded_for: '500 Folsom St, SF',
          age_seconds: 12,
        },
      ],
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getJson } = makeRes();
    await (dispatch.listResourceLocationsHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({ query: { staleness_seconds: '600' } }),
      res,
    );

    expect(getStatus()).toBe(200);
    const body = getJson();
    const locs = body?.locations as Array<Record<string, unknown>>;
    expect(locs).toHaveLength(1);
    const row = locs[0];
    expect(row.eta_minutes).toBeTypeOf('number');
    expect(row.eta_minutes as number).toBeGreaterThanOrEqual(0);
    expect(row.eta_provider).toBe('haversine');
    expect(row.eta_is_estimate).toBe(true);
    expect(row.eta_distance_m).toBeTypeOf('number');
    expect(row.eta_computed_at).toBeTypeOf('string');
    // No follow-up update query — we already had cached coords.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('lazily geocodes and persists coords when the job has an address but no cached lat/lon', async () => {
    const { __resetRoutingCachesForTests } = await import('../../platform/integrations/routing');
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          resource_id: 'res-1',
          latitude: '37.7749',
          longitude: '-122.4194',
          accuracy_m: null,
          heading_deg: null,
          speed_mps: null,
          active_job_id: 'job-2',
          active_status: 'en_route',
          recorded_at: new Date().toISOString(),
          received_at: new Date().toISOString(),
          resource_name: 'Alex',
          resource_role: 'tech',
          resource_current_status: 'busy',
          job_title: 'Water heater',
          job_contact_name: 'Jane',
          job_address: '999 Howard St, SF',
          job_status: 'en_route',
          job_address_lat: null,
          job_address_lon: null,
          job_address_geocoded_for: null,
          age_seconds: 12,
        },
      ],
    });
    // The persist UPDATE
    queryMock.mockResolvedValueOnce({ rows: [] });

    // Stub fetch for the nominatim geocoder
    process.env.DISPATCH_GEOCODE_PROVIDER = 'nominatim';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() { return [{ lat: '37.7849', lon: '-122.4094' }]; },
      async text() { return ''; },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getJson } = makeRes();
    await (dispatch.listResourceLocationsHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq(),
      res,
    );

    expect(getStatus()).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // SELECT + UPDATE persist
    expect(queryMock).toHaveBeenCalledTimes(2);
    const persist = queryMock.mock.calls[1];
    const persistSql = String(persist[0]);
    expect(persistSql).toMatch(/UPDATE dispatch_jobs/);
    expect(persistSql).toMatch(/address_lat\s*=\s*\$1/);
    const params = persist[1] as unknown[];
    expect(params[0]).toBeCloseTo(37.7849);
    expect(params[1]).toBeCloseTo(-122.4094);
    expect(params[2]).toBe('999 Howard St, SF');
    expect(params[3]).toBe('job-2');
    expect(params[4]).toBe('tenant-A');

    const body = getJson();
    const locs = body?.locations as Array<Record<string, unknown>>;
    expect(locs[0].eta_minutes).toBeTypeOf('number');
    vi.unstubAllGlobals();
  });

  it('returns null ETA fields when there is no address and no cached coords', async () => {
    const { __resetRoutingCachesForTests } = await import('../../platform/integrations/routing');
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          resource_id: 'res-2',
          latitude: '37.7',
          longitude: '-122.4',
          accuracy_m: null,
          heading_deg: null,
          speed_mps: null,
          active_job_id: 'job-3',
          active_status: 'en_route',
          recorded_at: new Date().toISOString(),
          received_at: new Date().toISOString(),
          resource_name: 'Sam',
          resource_role: 'tech',
          resource_current_status: 'busy',
          job_title: 'Inspect panel',
          job_contact_name: 'Bob',
          job_address: '',
          job_status: 'en_route',
          job_address_lat: null,
          job_address_lon: null,
          job_address_geocoded_for: null,
          age_seconds: 12,
        },
      ],
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getJson } = makeRes();
    await (dispatch.listResourceLocationsHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq(),
      res,
    );
    const row = (getJson()?.locations as Array<Record<string, unknown>>)[0];
    expect(row.eta_minutes).toBeNull();
    expect(row.eta_distance_m).toBeNull();
    expect(row.eta_provider).toBeNull();
    expect(row.eta_is_estimate).toBeNull();
    // No persist query because we had nothing to geocode.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list (and skips ETA work) when no resources are reporting', async () => {
    const { __resetRoutingCachesForTests } = await import('../../platform/integrations/routing');
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({ rows: [] });
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getJson, getStatus } = makeRes();
    await (dispatch.listResourceLocationsHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq(),
      res,
    );
    expect(getStatus()).toBe(200);
    expect((getJson()?.locations as unknown[]).length).toBe(0);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
