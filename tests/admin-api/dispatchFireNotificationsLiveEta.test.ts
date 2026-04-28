// Verifies that fireNotifications substitutes the live driving ETA
// tokens ({{eta_drive_minutes}}, {{eta_arrival_time}}) when the
// trigger is en_route, and that it falls back gracefully when the
// technician hasn't reported a fix yet.
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

describe('fireNotifications live ETA substitution', () => {
  it('replaces {{eta_drive_minutes}} on en_route using the haversine adapter when geocode is cached', async () => {
    const { __resetRoutingCachesForTests } = await import('../../platform/integrations/routing');
    __resetRoutingCachesForTests();

    // 1. SELECT templates
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'tpl-1',
        channel: 'sms',
        subject: 'On the way',
        body_template: 'Hi {{contact_name}}, your tech is ~{{eta_drive_minutes}} min away (arriving {{eta_arrival_time}}).',
      }],
    });
    // 2. SELECT job + resource
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        title: 'Water heater',
        contact_name: 'Jane',
        contact_phone: '+15551234567',
        contact_email: '',
        address: '500 Folsom St, SF',
        status: 'en_route',
        eta_start: null,
        resource_id: 'res-1',
        resource_name: 'Alex',
      }],
    });
    // 3. computeLiveEtaForJob: SELECT location row
    queryMock.mockResolvedValueOnce({
      rows: [{ latitude: '37.7749', longitude: '-122.4194', received_at: new Date().toISOString() }],
    });
    // 4. computeLiveEtaForJob: SELECT cached job geocode
    queryMock.mockResolvedValueOnce({
      rows: [{
        address_lat: '37.7849',
        address_lon: '-122.4094',
        address_geocoded_for: '500 Folsom St, SF',
      }],
    });
    // 5. INSERT into dispatch_notifications_log
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.fireNotifications as (
      pool: { query: typeof queryMock },
      t: string, j: string, e: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1', 'en_route');

    expect(queryMock).toHaveBeenCalledTimes(5);
    const insertCall = queryMock.mock.calls[4];
    const params = insertCall[1] as unknown[];
    const body = String(params[6]);
    expect(body).toMatch(/Hi Jane/);
    // The haversine adapter for the SF→Folsom-ish coords is well under
    // an hour — should be a small positive number of minutes.
    expect(body).toMatch(/your tech is ~\d+ min away/);
    expect(body).toMatch(/arriving \d{1,2}:\d{2}/);
    expect(body).not.toContain('{{eta_drive_minutes}}');
    expect(body).not.toContain('{{eta_arrival_time}}');
  });

  it('substitutes a friendly fallback when the technician has not reported a fix yet', async () => {
    const { __resetRoutingCachesForTests } = await import('../../platform/integrations/routing');
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'tpl-1',
        channel: 'sms',
        subject: '',
        body_template: 'Tech is ~{{eta_drive_minutes}} min out',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        title: 'Job',
        contact_name: 'Jane',
        contact_phone: '+1555',
        address: '500 Folsom St',
        status: 'en_route',
        eta_start: null,
        resource_id: 'res-1',
        resource_name: 'Alex',
      }],
    });
    // computeLiveEtaForJob: no location rows -> null -> "soon"
    queryMock.mockResolvedValueOnce({ rows: [] });
    // INSERT
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.fireNotifications as (
      pool: { query: typeof queryMock },
      t: string, j: string, e: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1', 'en_route');

    const insertCall = queryMock.mock.calls[3];
    const body = String((insertCall[1] as unknown[])[6]);
    expect(body).toBe('Tech is ~soon min out');
  });

  it('orders the location lookup by received_at DESC so the latest fix is used', async () => {
    const { __resetRoutingCachesForTests } = await import('../../platform/integrations/routing');
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'tpl-1', channel: 'sms', subject: '',
        body_template: 'Tech is ~{{eta_drive_minutes}} min out',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1', title: 'Job', contact_name: 'Jane', contact_phone: '+1555',
        address: '500 Folsom', status: 'en_route', eta_start: null,
        resource_id: 'res-1', resource_name: 'Alex',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ latitude: '37.7749', longitude: '-122.4194', received_at: new Date().toISOString() }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ address_lat: '37.7849', address_lon: '-122.4094', address_geocoded_for: '500 Folsom' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.fireNotifications as (
      pool: { query: typeof queryMock }, t: string, j: string, e: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1', 'en_route');

    // Third query (index 2) is the technician location lookup.
    const locSql = String(queryMock.mock.calls[2][0]);
    expect(locSql).toMatch(/FROM\s+dispatch_resource_locations/);
    expect(locSql).toMatch(/ORDER BY\s+received_at\s+DESC/i);
    expect(locSql).toMatch(/LIMIT\s+1/i);
  });

  it('falls back to "soon" when the latest technician fix is older than the staleness budget', async () => {
    const { __resetRoutingCachesForTests } = await import('../../platform/integrations/routing');
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'tpl-1', channel: 'sms', subject: '',
        body_template: 'Tech is ~{{eta_drive_minutes}} min out',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1', title: 'Job', contact_name: 'Jane', contact_phone: '+1555',
        address: '500 Folsom', status: 'en_route', eta_start: null,
        resource_id: 'res-1', resource_name: 'Alex',
      }],
    });
    // Stale fix: 1 hour old, beyond the 600s budget.
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    queryMock.mockResolvedValueOnce({
      rows: [{ latitude: '37.7749', longitude: '-122.4194', received_at: stale }],
    });
    // INSERT
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.fireNotifications as (
      pool: { query: typeof queryMock }, t: string, j: string, e: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1', 'en_route');

    // Should NOT have queried the geocode (call index 3 is the INSERT, not a SELECT).
    expect(queryMock).toHaveBeenCalledTimes(4);
    const insertSql = String(queryMock.mock.calls[3][0]);
    expect(insertSql).toMatch(/INSERT INTO dispatch_notifications_log/);
    const body = String((queryMock.mock.calls[3][1] as unknown[])[6]);
    expect(body).toBe('Tech is ~soon min out');
  });

  it('does not call the routing service when no template references a live-ETA token and trigger is not en_route', async () => {
    const { __resetRoutingCachesForTests } = await import('../../platform/integrations/routing');
    __resetRoutingCachesForTests();

    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'tpl-1',
        channel: 'sms',
        subject: '',
        body_template: 'Job {{job_title}} marked {{status}}',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        title: 'Job',
        contact_name: 'Jane',
        contact_phone: '+1555',
        address: '500 Folsom',
        status: 'completed',
        eta_start: null,
        resource_id: 'res-1',
        resource_name: 'Alex',
      }],
    });
    // INSERT (no live-ETA queries between)
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.fireNotifications as (
      pool: { query: typeof queryMock },
      t: string, j: string, e: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1', 'completed');

    expect(queryMock).toHaveBeenCalledTimes(3);
    const body = String((queryMock.mock.calls[2][1] as unknown[])[6]);
    expect(body).toBe('Job Job marked completed');
  });
});
