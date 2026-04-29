// Integration tests for the customer-facing completion-photo email
// triggered automatically when a job transitions into a completed
// status. Exercises sendCompletionPhotosEmail end-to-end with the
// platform pool, email service, and notifications log all mocked, so
// we can pin down the gating rules (tenant opt-out, missing email,
// no photos) and the URL shape we hand to the customer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

const queryMock = vi.fn();
const sendEmailMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  withTenantContext: vi.fn(async () => {}),
  withPrivilegedClient: vi.fn(),
}));
vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
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
vi.mock('../../platform/email', async () => {
  const real = await vi.importActual<typeof import('../../platform/email')>(
    '../../platform/email',
  );
  return {
    ...real,
    sendEmail: sendEmailMock,
  };
});

const ORIGINAL_APP_URL = process.env.APP_URL;
const ORIGINAL_SECRET = process.env.DISPATCH_COMPLETION_PHOTO_SECRET;

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  vi.resetModules();
  process.env.APP_URL = 'https://example.test';
  process.env.DISPATCH_COMPLETION_PHOTO_SECRET = 'unit-test-secret';
  process.env.DISPATCH_ROUTING_PROVIDER = 'haversine';
  process.env.DISPATCH_GEOCODE_PROVIDER = 'none';
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
  if (ORIGINAL_SECRET === undefined) delete process.env.DISPATCH_COMPLETION_PHOTO_SECRET;
  else process.env.DISPATCH_COMPLETION_PHOTO_SECRET = ORIGINAL_SECRET;
  delete process.env.DISPATCH_ROUTING_PROVIDER;
  delete process.env.DISPATCH_GEOCODE_PROVIDER;
});

type Pool = { query: typeof queryMock };

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    title: 'AC Tune-Up',
    status: 'completed',
    contact_email: 'customer@example.com',
    contact_name: 'Jane Doe',
    completed_at: new Date('2026-04-29T12:00:00Z'),
    tracking_token: 'tok-abc',
    resource_name: 'Tech Bob',
    tenant_name: 'Acme HVAC',
    email_enabled: true,
    ...overrides,
  };
}

describe('sendCompletionPhotosEmail', () => {
  it('emails the customer one tenant-scoped link per proof-of-completion attachment', async () => {
    queryMock.mockResolvedValueOnce({ rows: [jobRow()] }); // job lookup
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: 'att-1', title: 'Before.jpg', mime_type: 'image/jpeg', object_path: '/objects/u/x' },
        { id: 'att-2', title: 'After.jpg', mime_type: 'image/jpeg', object_path: '/objects/u/y' },
      ],
    }); // photo lookup
    queryMock.mockResolvedValueOnce({ rows: [] }); // notifications log insert

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.sendCompletionPhotosEmail as (
      pool: Pool, t: string, j: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1');

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe('customer@example.com');
    expect(call.subject).toContain('AC Tune-Up');
    // Both attachments rendered as tenant-scoped URLs with HMAC token.
    expect(call.html).toContain('/api/admin/dispatch/completion-photos/att-1');
    expect(call.html).toContain('/api/admin/dispatch/completion-photos/att-2');
    // Ampersands are HTML-escaped inside href attributes, so match
    // the raw "?t=" plus the escaped "&amp;tid=" form.
    expect(call.html).toMatch(/tid=tenant-A/);
    expect(call.html).toMatch(/[?]t=[a-f0-9]{32}/);
    expect(call.html).toMatch(/exp=\d+/);
    // Raw object-storage path must NEVER reach the customer.
    expect(call.html).not.toContain('/objects/u/x');
    expect(call.html).not.toContain('/objects/u/y');
    // Tracking URL is included when the job has a tracking_token.
    expect(call.html).toContain('https://example.test/track/tok-abc');

    // A row is logged so dispatchers can see the email in the activity feed.
    expect(queryMock).toHaveBeenCalledTimes(3);
    const logArgs = queryMock.mock.calls[2][1] as unknown[];
    expect(logArgs[0]).toBe('job-1');
    expect(logArgs[1]).toBe('tenant-A');
    expect(logArgs[2]).toBe('customer@example.com');
    expect(logArgs[5]).toBe('sent');
  });

  it('skips silently when the tenant has opted out', async () => {
    queryMock.mockResolvedValueOnce({ rows: [jobRow({ email_enabled: false })] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.sendCompletionPhotosEmail as (
      pool: Pool, t: string, j: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1');

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('skips silently when contact_email is missing or malformed', async () => {
    queryMock.mockResolvedValueOnce({ rows: [jobRow({ contact_email: '' })] });
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.sendCompletionPhotosEmail as (
      pool: Pool, t: string, j: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1');
    expect(sendEmailMock).not.toHaveBeenCalled();

    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [jobRow({ contact_email: 'not-an-email' })] });
    await (dispatch.sendCompletionPhotosEmail as (
      pool: Pool, t: string, j: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('skips silently when the job has no proof_of_completion attachments', async () => {
    queryMock.mockResolvedValueOnce({ rows: [jobRow()] });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.sendCompletionPhotosEmail as (
      pool: Pool, t: string, j: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1');

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('logs failed status when the email service rejects', async () => {
    queryMock.mockResolvedValueOnce({ rows: [jobRow()] });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'att-1', title: 'p.jpg', mime_type: 'image/jpeg', object_path: '/objects/u/x' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'smtp 550', permanent: true });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.sendCompletionPhotosEmail as (
      pool: Pool, t: string, j: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1');

    const logArgs = queryMock.mock.calls[2][1] as unknown[];
    expect(logArgs[5]).toBe('failed');
  });

  it('fires from fireNotifications even when the tenant has zero templates', async () => {
    // The template path bails inside its try with `if templates.length === 0
    // return;` — the photo email must run BEFORE that early return so a
    // tenant who never customized lifecycle copy still gets photos out.
    //
    // queryMock fires in this interleaved order because both code paths
    // race to their first await:
    //   [0] sendCompletionPhotosEmail: job lookup
    //   [1] fireNotifications: template lookup (returns [])
    //   [2] sendCompletionPhotosEmail: photo lookup
    //   [3] sendCompletionPhotosEmail: log insert
    queryMock.mockResolvedValueOnce({ rows: [jobRow()] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'att-1', title: 'p.jpg', mime_type: 'image/jpeg', object_path: '/objects/u/x' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.fireNotifications as (
      pool: Pool, t: string, j: string, e: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1', 'completed');

    // Drain microtasks so the void send-call settles.
    await new Promise((r) => setImmediate(r));

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toBe('customer@example.com');
  });

  it('caps the per-email photo count so a chatty job cannot blow up the body', async () => {
    queryMock.mockResolvedValueOnce({ rows: [jobRow()] });
    const tooMany = Array.from({ length: 25 }, (_, i) => ({
      id: `att-${i}`,
      title: `p${i}.jpg`,
      mime_type: 'image/jpeg',
      object_path: `/objects/u/${i}`,
    }));
    queryMock.mockResolvedValueOnce({ rows: tooMany });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await (dispatch.sendCompletionPhotosEmail as (
      pool: Pool, t: string, j: string,
    ) => Promise<void>)({ query: queryMock }, 'tenant-A', 'job-1');

    const html = sendEmailMock.mock.calls[0][0].html as string;
    // First 12 ids appear, anything beyond that is dropped.
    expect(html).toContain('/completion-photos/att-0');
    expect(html).toContain('/completion-photos/att-11');
    expect(html).not.toContain('/completion-photos/att-12');
    expect(html).not.toContain('/completion-photos/att-24');
  });
});
