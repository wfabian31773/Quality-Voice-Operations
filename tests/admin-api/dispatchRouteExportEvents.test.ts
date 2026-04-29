// Verifies the route-export SSE broker + the emit calls inside
// `processRouteExportJob`:
//   - the broker delivers events to per-tenant subscribers and ignores
//     other tenants' subscribers
//   - `processRouteExportJob` emits `running` after pending → running,
//     `ready` after archive upload, and `failed` after the error path
//   - listener errors don't break the worker
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
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
  requireAuth: (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next(),
}));
vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next(),
  requireRole: () =>
    (
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) => next(),
  requirePlatformAdmin: (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next(),
}));

const uploadPrivateObjectMock = vi.fn(async (key: string) => `/objects/private/${key}`);
vi.mock('../../server/replit_integrations/object_storage', () => ({
  ObjectStorageService: class {
    uploadPrivateObject = uploadPrivateObjectMock;
    streamPrivateObject = vi.fn(async () => {});
  },
  ObjectNotFoundError: class extends Error {},
}));

const sendEmailMock = vi.fn(async () => ({ success: true, messageId: 'msg-test-1' }));
vi.mock('../../platform/email', () => ({
  sendEmail: sendEmailMock,
  dispatchRouteExportReadyEmail: vi.fn(() => ({
    subject: 'ready',
    html: '<p>ready</p>',
    text: 'ready',
  })),
  dispatchRouteExportFailedEmail: vi.fn(() => ({
    subject: 'failed',
    html: '<p>failed</p>',
    text: 'failed',
  })),
}));

const TENANT_A = '00000000-0000-0000-0000-00000000aaaa';
const TENANT_B = '00000000-0000-0000-0000-00000000bbbb';
const JOB_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(async () => {
  queryMock.mockReset();
  uploadPrivateObjectMock.mockClear();
  sendEmailMock.mockClear();
  const { __resetRouteExportEventsForTesting } = await import(
    '../../platform/notifications/routeExportEvents'
  );
  __resetRouteExportEventsForTesting();
});

describe('routeExportEvents broker', () => {
  it('delivers `route_export.status_changed` events to the matching tenant only', async () => {
    const {
      emitRouteExportStatusChanged,
      subscribeRouteExportEvents,
    } = await import('../../platform/notifications/routeExportEvents');

    const aListener = vi.fn();
    const bListener = vi.fn();
    const unsubA = subscribeRouteExportEvents(TENANT_A, aListener);
    const unsubB = subscribeRouteExportEvents(TENANT_B, bListener);

    emitRouteExportStatusChanged(TENANT_A, {
      exportJobId: 'export-1',
      status: 'running',
    });

    expect(aListener).toHaveBeenCalledTimes(1);
    expect(aListener.mock.calls[0][0]).toMatchObject({
      exportJobId: 'export-1',
      status: 'running',
    });
    expect(typeof aListener.mock.calls[0][0].emittedAt).toBe('string');
    expect(bListener).not.toHaveBeenCalled();

    unsubA();
    unsubB();
  });

  it('unsubscribe stops further event delivery', async () => {
    const {
      emitRouteExportStatusChanged,
      subscribeRouteExportEvents,
    } = await import('../../platform/notifications/routeExportEvents');

    const listener = vi.fn();
    const unsubscribe = subscribeRouteExportEvents(TENANT_A, listener);
    unsubscribe();

    emitRouteExportStatusChanged(TENANT_A, {
      exportJobId: 'export-1',
      status: 'ready',
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener does not block other listeners or the emitter', async () => {
    const {
      emitRouteExportStatusChanged,
      subscribeRouteExportEvents,
    } = await import('../../platform/notifications/routeExportEvents');

    const bad = vi.fn(() => {
      throw new Error('listener boom');
    });
    const good = vi.fn();
    subscribeRouteExportEvents(TENANT_A, bad);
    subscribeRouteExportEvents(TENANT_A, good);

    expect(() =>
      emitRouteExportStatusChanged(TENANT_A, {
        exportJobId: 'export-1',
        status: 'failed',
        errorMessage: 'something went wrong',
      }),
    ).not.toThrow();

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(good.mock.calls[0][0]).toMatchObject({
      exportJobId: 'export-1',
      status: 'failed',
      errorMessage: 'something went wrong',
    });
  });
});

describe('processRouteExportJob → emitRouteExportStatusChanged', () => {
  it('emits `running` then `ready` on the happy path', async () => {
    queryMock
      // 1. SELECT export-job row
      .mockResolvedValueOnce({
        rows: [
          {
            tenant_id: TENANT_A,
            requested_by_email: 'dispatcher@example.com',
            requested_by_user_id: 'user-1',
            format: 'gpx',
            include_empty: true,
            selection: { resolved_job_ids: [JOB_ID] },
          },
        ],
      })
      // 2. UPDATE pending → running
      .mockResolvedValueOnce({ rows: [] })
      // 3. resolveExportJobs
      .mockResolvedValueOnce({
        rows: [
          {
            id: JOB_ID,
            title: 'Furnace tune-up',
            status: 'completed',
            scheduled_at: new Date('2026-04-20T13:00:00Z'),
            completed_at: new Date('2026-04-20T15:30:00Z'),
            resource_name: 'Tech 1',
          },
        ],
      })
      // 4. buildRouteArchive breadcrumbs
      .mockResolvedValueOnce({
        rows: [
          {
            active_job_id: JOB_ID,
            latitude: 47.6,
            longitude: -122.3,
            accuracy_m: 8,
            heading_deg: 180,
            speed_mps: 12,
            recorded_at: new Date('2026-04-20T13:05:00Z'),
            received_at: new Date('2026-04-20T13:05:01Z'),
          },
        ],
      })
      // 5. UPDATE → ready
      .mockResolvedValueOnce({ rows: [] })
      // 6. SELECT user first_name
      .mockResolvedValueOnce({ rows: [{ first_name: 'Dana' }] })
      // 7. SELECT tenant name
      .mockResolvedValueOnce({ rows: [{ name: 'Acme HVAC' }] })
      // 8. UPDATE email_sent_at
      .mockResolvedValueOnce({ rows: [] });

    const events: { exportJobId: string; status: string }[] = [];
    const { subscribeRouteExportEvents } = await import(
      '../../platform/notifications/routeExportEvents'
    );
    subscribeRouteExportEvents(TENANT_A, (p) =>
      events.push({ exportJobId: p.exportJobId, status: p.status }),
    );

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await dispatch.processRouteExportJob('export-job-happy');

    expect(events).toEqual([
      { exportJobId: 'export-job-happy', status: 'running' },
      { exportJobId: 'export-job-happy', status: 'ready' },
    ]);
  });

  it('SSE handler writes `route_export.status_changed` events for the calling tenant', async () => {
    const req = new EventEmitter() as unknown as Request & EventEmitter;
    (req as unknown as { user: { tenantId: string } }).user = { tenantId: TENANT_A };
    (req as unknown as { socket?: { destroy: () => void } }).socket = { destroy: () => {} };

    const writes: string[] = [];
    let writeHeadStatus = 0;
    let writeHeadHeaders: Record<string, string> = {};
    const res = Object.assign(new EventEmitter(), {
      writeHead: (status: number, headers: Record<string, string>) => {
        writeHeadStatus = status;
        writeHeadHeaders = headers;
      },
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end: () => {},
      writableEnded: false,
      destroyed: false,
      setHeader: () => {},
      status: () => ({ json: () => {} }),
      off: function (this: EventEmitter, ...args: Parameters<EventEmitter['off']>) {
        return EventEmitter.prototype.off.apply(this, args);
      },
    }) as unknown as Response;

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const handler = dispatch.routeExportsStreamHandler as
      (req: Request, res: Response) => void;
    handler(req as Request, res);

    expect(writeHeadStatus).toBe(200);
    expect(writeHeadHeaders['Content-Type']).toBe('text/event-stream');
    // The first frame is the `connection` envelope used for ack scoping.
    expect(writes[0]).toContain('event: connection');

    const { emitRouteExportStatusChanged } = await import(
      '../../platform/notifications/routeExportEvents'
    );
    emitRouteExportStatusChanged(TENANT_A, {
      exportJobId: 'sse-test-1',
      status: 'ready',
    });
    // Other tenant — should NOT show up on this stream.
    emitRouteExportStatusChanged(TENANT_B, {
      exportJobId: 'sse-test-other',
      status: 'ready',
    });

    const eventFrames = writes.filter(w =>
      w.startsWith('event: route_export.status_changed'),
    );
    expect(eventFrames).toHaveLength(1);
    expect(eventFrames[0]).toContain('"exportJobId":"sse-test-1"');
    expect(eventFrames[0]).toContain('"status":"ready"');

    // Cleanup unsubscribes from the broker so further emits are ignored.
    (req as unknown as EventEmitter).emit('close');
    emitRouteExportStatusChanged(TENANT_A, {
      exportJobId: 'sse-test-2',
      status: 'failed',
    });
    const after = writes.filter(w =>
      w.startsWith('event: route_export.status_changed'),
    );
    expect(after).toHaveLength(1);
  });

  it('emits `running` then `failed` (with error message) when the worker throws', async () => {
    queryMock
      // 1. SELECT export-job row
      .mockResolvedValueOnce({
        rows: [
          {
            tenant_id: TENANT_A,
            requested_by_email: 'dispatcher@example.com',
            requested_by_user_id: 'user-1',
            format: 'csv',
            include_empty: true,
            selection: { resolved_job_ids: [JOB_ID] },
          },
        ],
      })
      // 2. UPDATE pending → running
      .mockResolvedValueOnce({ rows: [] })
      // 3. resolveExportJobs returns nothing — worker throws
      .mockResolvedValueOnce({ rows: [] })
      // 4. UPDATE → failed
      .mockResolvedValueOnce({ rows: [] });

    const events: { exportJobId: string; status: string; errorMessage?: string | null }[] = [];
    const { subscribeRouteExportEvents } = await import(
      '../../platform/notifications/routeExportEvents'
    );
    subscribeRouteExportEvents(TENANT_A, (p) =>
      events.push({
        exportJobId: p.exportJobId,
        status: p.status,
        errorMessage: p.errorMessage ?? null,
      }),
    );

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await dispatch.processRouteExportJob('export-job-fail');

    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ exportJobId: 'export-job-fail', status: 'running' });
    expect(events[1]).toMatchObject({ exportJobId: 'export-job-fail', status: 'failed' });
    expect(typeof events[1].errorMessage).toBe('string');
    expect((events[1].errorMessage ?? '').length).toBeGreaterThan(0);
  });
});
