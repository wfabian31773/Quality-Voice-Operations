// Verifies that fireNotifications substitutes the {{tracking_url}}
// merge token with an absolute URL pointing at the customer-facing
// booking-tracker page (`/track/<tracking_token>`). See task #781 and
// migration 088 for context.
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

const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_REPLIT_DEV_DOMAIN = process.env.REPLIT_DEV_DOMAIN;

beforeEach(() => {
  queryMock.mockReset();
  vi.resetModules();
  process.env.DISPATCH_ROUTING_PROVIDER = 'haversine';
  process.env.DISPATCH_GEOCODE_PROVIDER = 'none';
});

afterEach(() => {
  delete process.env.DISPATCH_ROUTING_PROVIDER;
  delete process.env.DISPATCH_GEOCODE_PROVIDER;
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
  if (ORIGINAL_REPLIT_DEV_DOMAIN === undefined) delete process.env.REPLIT_DEV_DOMAIN;
  else process.env.REPLIT_DEV_DOMAIN = ORIGINAL_REPLIT_DEV_DOMAIN;
});

describe('fireNotifications {{tracking_url}} substitution', () => {
  it('renders an absolute /track/<token> URL using APP_URL when present', async () => {
    process.env.APP_URL = 'https://example.com';

    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'tpl-1',
        channel: 'sms',
        subject: '',
        body_template: 'Hi {{contact_name}}, track your tech: {{tracking_url}}',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1',
        title: 'AC Tune-Up',
        contact_name: 'Jane',
        contact_phone: '+15551234567',
        address: '500 Folsom St, SF',
        status: 'en_route',
        eta_start: null,
        resource_id: null,
        resource_name: null,
        tracking_token: 'tok-abc-123',
      }],
    });
    // INSERT
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.fireNotifications as (
      pool: { query: typeof queryMock },
      t: string, j: string, e: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1', 'en_route');

    expect(queryMock).toHaveBeenCalledTimes(3);
    const body = String((queryMock.mock.calls[2][1] as unknown[])[6]);
    expect(body).toBe('Hi Jane, track your tech: https://example.com/track/tok-abc-123');
    expect(body).not.toContain('{{tracking_url}}');
  });

  it('falls back to REPLIT_DEV_DOMAIN when APP_URL is unset', async () => {
    delete process.env.APP_URL;
    process.env.REPLIT_DEV_DOMAIN = 'preview.example.dev';

    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'tpl-1', channel: 'sms', subject: '',
        body_template: '{{tracking_url}}',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1', title: 'Job', contact_name: 'Jane', contact_phone: '+1555',
        address: '500 Folsom', status: 'en_route', eta_start: null,
        resource_id: null, resource_name: null,
        tracking_token: 'tok-xyz',
      }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.fireNotifications as (
      pool: { query: typeof queryMock }, t: string, j: string, e: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1', 'en_route');

    const body = String((queryMock.mock.calls[2][1] as unknown[])[6]);
    expect(body).toBe('https://preview.example.dev/track/tok-xyz');
  });

  it('strips trailing slashes on APP_URL so we never produce a //track URL', async () => {
    process.env.APP_URL = 'https://example.com///';

    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'tpl-1', channel: 'sms', subject: '',
        body_template: 'Go: {{tracking_url}}',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1', title: 'Job', contact_name: 'Jane', contact_phone: '+1555',
        address: 'a', status: 'en_route', eta_start: null,
        resource_id: null, resource_name: null,
        tracking_token: 'tok-1',
      }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.fireNotifications as (
      pool: { query: typeof queryMock }, t: string, j: string, e: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1', 'en_route');

    const body = String((queryMock.mock.calls[2][1] as unknown[])[6]);
    expect(body).toBe('Go: https://example.com/track/tok-1');
  });

  it('substitutes an empty string when the job row has no tracking_token', async () => {
    process.env.APP_URL = 'https://example.com';

    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'tpl-1', channel: 'sms', subject: '',
        body_template: 'Track: {{tracking_url}}',
      }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'job-1', title: 'Job', contact_name: 'Jane', contact_phone: '+1555',
        address: 'a', status: 'en_route', eta_start: null,
        resource_id: null, resource_name: null,
        tracking_token: null,
      }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.fireNotifications as (
      pool: { query: typeof queryMock }, t: string, j: string, e: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1', 'en_route');

    const body = String((queryMock.mock.calls[2][1] as unknown[])[6]);
    expect(body).toBe('Track: ');
    // We must never leak the raw merge token to the customer.
    expect(body).not.toContain('{{tracking_url}}');
  });
});
