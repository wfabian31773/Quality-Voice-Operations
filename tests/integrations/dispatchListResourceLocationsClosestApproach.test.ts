// Verifies that GET /dispatch/resource-locations exposes the same
// closest-approach distance the dispatch board card and queue table
// already render for each active job. The map view uses this number to
// color the marker popup (and tint the marker icon when it crosses the
// "bad" 250 m threshold), so supervisors can spot off-target visits
// without opening the route replay tab. Mirrors the SQL-shape +
// number-normalization invariants exercised by
// `dispatchListJobsClosestApproach.test.ts`.
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

describe('listResourceLocationsHandler — closest_approach_m', () => {
  it('issues a LATERAL haversine query gated on the cached address coords', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res } = makeRes();
    await (dispatch.listResourceLocationsHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq(),
      res,
    );
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0][0]);
    // The select list now exposes ca.closest_approach_m alongside the
    // existing live-map columns.
    expect(sql).toMatch(/ca\.closest_approach_m/);
    // The LATERAL scans the breadcrumb history table joined to the
    // active job and is gated on the cached address geocode (otherwise
    // the haversine math is meaningless and we want NULL).
    expect(sql).toMatch(/LEFT JOIN LATERAL/);
    expect(sql).toMatch(/dispatch_resource_location_history/);
    expect(sql).toMatch(/h\.active_job_id\s*=\s*j\.id/);
    expect(sql).toMatch(/j\.address_lat IS NOT NULL/);
    expect(sql).toMatch(/j\.address_lon IS NOT NULL/);
  });

  it('normalizes closest_approach_m: number when present, null when absent', async () => {
    const now = new Date().toISOString();
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          // Cached geocode + breadcrumbs → number
          resource_id: 'res-1',
          latitude: '37.7749',
          longitude: '-122.4194',
          accuracy_m: null,
          heading_deg: null,
          speed_mps: null,
          active_job_id: 'job-1',
          active_status: 'on_site',
          recorded_at: now,
          received_at: now,
          resource_name: 'Alex',
          resource_role: 'tech',
          resource_current_status: 'busy',
          job_title: 'Water heater',
          job_contact_name: 'Jane',
          job_address: '500 Folsom St, SF',
          job_status: 'on_site',
          job_address_lat: '37.7849',
          job_address_lon: '-122.4094',
          job_address_geocoded_for: '500 Folsom St, SF',
          age_seconds: 12,
          // Pg returns DOUBLE PRECISION as a JS number, but it can also
          // come back as a numeric string depending on driver settings —
          // exercise the string path so we know the coercion works.
          closest_approach_m: '612.7',
        },
        {
          // No cached geocode → LATERAL aggregate is NULL → stays null
          resource_id: 'res-2',
          latitude: '40.7128',
          longitude: '-74.0060',
          accuracy_m: null,
          heading_deg: null,
          speed_mps: null,
          active_job_id: 'job-2',
          active_status: 'in_progress',
          recorded_at: now,
          received_at: now,
          resource_name: 'Sam',
          resource_role: 'tech',
          resource_current_status: 'busy',
          job_title: 'Inspect panel',
          job_contact_name: 'Bob',
          job_address: '123 Main St',
          job_status: 'in_progress',
          job_address_lat: '40.7138',
          job_address_lon: '-74.0050',
          job_address_geocoded_for: '123 Main St',
          age_seconds: 5,
          closest_approach_m: null,
        },
      ],
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getJson } = makeRes();
    await (dispatch.listResourceLocationsHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq(),
      res,
    );

    expect(getStatus()).toBe(200);
    const body = getJson();
    const locs = body?.locations as Array<Record<string, unknown>>;
    expect(locs).toHaveLength(2);
    // First row: numeric string coerced to a finite number.
    expect(typeof locs[0].closest_approach_m).toBe('number');
    expect(locs[0].closest_approach_m as number).toBeCloseTo(612.7, 1);
    // Second row: explicit null preserved (no NaN, no coercion).
    expect(locs[1].closest_approach_m).toBeNull();
  });
});
