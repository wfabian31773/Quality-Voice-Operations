// Verifies the bulk-route export endpoint (POST /dispatch/jobs/routes/export):
//   - 400 when neither job_ids nor any filter is supplied
//   - 400 when more than BULK_ROUTE_EXPORT_MAX_JOBS are requested
//   - 404 when no jobs match the selection
//   - explicit job_ids mode: only fetches the supplied (tenant-scoped) jobs,
//     bundles per-job route files in the archive, and emits a manifest.csv
//   - filter mode: applies a date range against COALESCE(scheduled_at,
//     created_at) and surfaces the same kind of archive
//   - include_empty=false skips zero-ping jobs (and records them as skipped
//     in the manifest)
//   - per-job filenames inside the archive follow the same
//     route-<jobId>-YYYY-MM-DD pattern as the per-job download
//   - tenant_id is bound to every breadcrumb / job query
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import JSZip from 'jszip';
import { withPrivilegedClient } from '../../platform/db';

const queryMock = vi.fn();
const withPrivilegedClientMock = withPrivilegedClient as unknown as ReturnType<typeof vi.fn>;

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
// Captured per-test so async-mode tests can assert what we tried to
// upload to object storage and what URL we baked into the email.
const uploadPrivateObjectMock = vi.fn(async (key: string) => `/objects/private/${key}`);
const streamPrivateObjectMock = vi.fn(async () => {});
vi.mock('../../server/replit_integrations/object_storage', () => ({
  ObjectStorageService: class {
    uploadPrivateObject = uploadPrivateObjectMock;
    streamPrivateObject = streamPrivateObjectMock;
  },
  ObjectNotFoundError: class extends Error {},
}));

const sendEmailMock = vi.fn(async () => ({ success: true, messageId: 'msg-test-1' }));
const readyEmailMock = vi.fn(() => ({
  subject: 'Your dispatch route archive is ready',
  html: '<p>ready</p>',
  text: 'ready',
}));
const failedEmailMock = vi.fn(() => ({
  subject: 'Your dispatch route archive could not be built',
  html: '<p>failed</p>',
  text: 'failed',
}));
vi.mock('../../platform/email', () => ({
  sendEmail: sendEmailMock,
  dispatchRouteExportReadyEmail: readyEmailMock,
  dispatchRouteExportFailedEmail: failedEmailMock,
}));

interface CapturedResponse {
  res: Response;
  getStatus: () => number;
  getBody: () => Buffer | string | Record<string, unknown> | null;
  getHeaders: () => Record<string, string>;
}

function makeRes(): CapturedResponse {
  let statusCode = 200;
  let body: Buffer | string | Record<string, unknown> | null = null;
  const headers: Record<string, string> = {};
  const setHeader = (k: string, v: string | number) => { headers[k] = String(v); };
  const send = (b: Buffer | string) => { body = b; };
  const json = (b: Record<string, unknown>) => { body = b; };
  const res = {
    status: (code: number) => {
      statusCode = code;
      return { json, send };
    },
    json,
    send,
    setHeader,
  } as unknown as Response;
  return {
    res,
    getStatus: () => statusCode,
    getBody: () => body,
    getHeaders: () => headers,
  };
}

function makeReq(
  body: Record<string, unknown>,
  overrides: { user?: Record<string, unknown> } = {},
): Request {
  return {
    user: overrides.user ?? {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'admin',
      email: 'dispatcher@example.com',
    },
    params: {},
    query: {},
    body,
    method: 'POST',
    headers: {},
    cookies: {},
    ip: '127.0.0.1',
  } as unknown as Request;
}

beforeEach(() => {
  queryMock.mockReset();
  withPrivilegedClientMock.mockReset();
  uploadPrivateObjectMock.mockClear();
  streamPrivateObjectMock.mockReset();
  // Default behavior: streamPrivateObject is a no-op. Individual tests
  // can override with mockImplementationOnce when they need to assert
  // header writes or simulate ObjectNotFoundError.
  streamPrivateObjectMock.mockImplementation(async () => {});
  sendEmailMock.mockClear();
  readyEmailMock.mockClear();
  failedEmailMock.mockClear();
});

const TENANT_ID = 'tenant-1';
const JOB_ID_A = '11111111-1111-1111-1111-111111111111';
const JOB_ID_B = '22222222-2222-2222-2222-222222222222';

describe('bulkExportJobRoutesHandler', () => {
  it('rejects requests with neither job_ids nor any filter', async () => {
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({}),
      res,
    );
    expect(getStatus()).toBe(400);
    const body = getBody() as Record<string, unknown>;
    expect(String(body.error)).toMatch(/job_ids or at least one filter/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects job_ids selections larger than the per-request cap', async () => {
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const tooMany: string[] = [];
    for (let i = 0; i < 501; i++) {
      tooMany.push(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    }
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({ job_ids: tooMany }),
      res,
    );
    expect(getStatus()).toBe(400);
    const body = getBody() as Record<string, unknown>;
    expect(String(body.error)).toMatch(/Too many jobs/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the selection resolves to zero tenant-owned jobs', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({ job_ids: [JOB_ID_A] }),
      res,
    );
    expect(getStatus()).toBe(404);
    expect(getBody()).toEqual({ error: 'No jobs matched the selection.' });
    expect(queryMock).toHaveBeenCalledTimes(1);
    // Tenant scoping must be present on the lookup.
    expect(String(queryMock.mock.calls[0][0])).toMatch(/tenant_id\s*=\s*\$1/);
    expect(queryMock.mock.calls[0][1]).toEqual([TENANT_ID, [JOB_ID_A]]);
  });

  it('builds a ZIP with per-job GPX entries and a manifest.csv for explicit job_ids', async () => {
    queryMock
      // Step 1: jobs lookup
      .mockResolvedValueOnce({
        rows: [
          {
            id: JOB_ID_A,
            title: 'Furnace tune-up',
            status: 'completed',
            scheduled_at: new Date('2026-04-20T13:00:00Z'),
            completed_at: new Date('2026-04-20T15:30:00Z'),
            resource_name: 'Tech 1',
          },
          {
            id: JOB_ID_B,
            title: 'AC inspection',
            status: 'completed',
            scheduled_at: new Date('2026-04-20T17:00:00Z'),
            completed_at: null,
            resource_name: 'Tech 2',
          },
        ],
      })
      // Step 2: breadcrumb points
      .mockResolvedValueOnce({
        rows: [
          {
            active_job_id: JOB_ID_A,
            latitude: 47.61,
            longitude: -122.34,
            accuracy_m: 8,
            heading_deg: 180,
            speed_mps: 12.5,
            recorded_at: new Date('2026-04-20T13:05:00Z'),
            received_at: new Date('2026-04-20T13:05:01Z'),
          },
          {
            active_job_id: JOB_ID_A,
            latitude: 47.612,
            longitude: -122.341,
            accuracy_m: 6,
            heading_deg: 175,
            speed_mps: 11.0,
            recorded_at: new Date('2026-04-20T13:10:00Z'),
            received_at: new Date('2026-04-20T13:10:01Z'),
          },
          // JOB_ID_B has no points — should still appear as an empty entry
          // (default include_empty=true) and as a 0-points row in manifest.
        ],
      });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody, getHeaders } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({ job_ids: [JOB_ID_A, JOB_ID_B] }),
      res,
    );

    expect(getStatus()).toBe(200);
    const headers = getHeaders();
    expect(headers['Content-Type']).toBe('application/zip');
    expect(headers['Content-Disposition']).toMatch(/attachment; filename="dispatch-routes-\d{4}-\d{2}-\d{2}\.zip"/);
    expect(headers['X-Route-Export-Job-Count']).toBe('2');
    expect(headers['X-Route-Export-Included']).toBe('2');
    expect(headers['X-Route-Export-Skipped-Empty']).toBe('0');
    expect(headers['X-Route-Export-Format']).toBe('gpx');

    const body = getBody();
    expect(Buffer.isBuffer(body)).toBe(true);

    const zip = await JSZip.loadAsync(body as Buffer);
    const filenames = Object.keys(zip.files).sort();
    // Filename pattern matches the per-job export.
    expect(filenames).toContain(`route-${JOB_ID_A}-2026-04-20.gpx`);
    expect(filenames).toContain(`route-${JOB_ID_B}-2026-04-20.gpx`);
    expect(filenames).toContain('manifest.csv');

    const gpxA = await zip.file(`route-${JOB_ID_A}-2026-04-20.gpx`)!.async('string');
    expect(gpxA).toMatch(/<gpx version="1.1"/);
    expect(gpxA).toMatch(/<trkpt lat="47.61" lon="-122.34">/);
    expect(gpxA).toMatch(/<trkpt lat="47.612" lon="-122.341">/);

    const gpxB = await zip.file(`route-${JOB_ID_B}-2026-04-20.gpx`)!.async('string');
    expect(gpxB).toMatch(/<trkseg>\s*<\/trkseg>/);

    const manifest = await zip.file('manifest.csv')!.async('string');
    expect(manifest).toMatch(/^job_id,title,resource_name,status,scheduled_at,completed_at,points,window_start,window_end,file/);
    expect(manifest).toContain(JOB_ID_A);
    expect(manifest).toContain(JOB_ID_B);
    expect(manifest).toContain(',2,'); // JOB_ID_A point count
    expect(manifest).toContain(',0,'); // JOB_ID_B point count

    // Tenant scoping on both queries.
    expect(String(queryMock.mock.calls[0][0])).toMatch(/j\.tenant_id\s*=\s*\$1/);
    expect(queryMock.mock.calls[0][1][0]).toBe(TENANT_ID);
    expect(String(queryMock.mock.calls[1][0])).toMatch(/tenant_id\s*=\s*\$1/);
    expect(queryMock.mock.calls[1][1]).toEqual([TENANT_ID, [JOB_ID_A, JOB_ID_B]]);
  });

  it('omits empty jobs from the archive when include_empty=false', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: JOB_ID_A,
            title: 'Has pings',
            status: 'completed',
            scheduled_at: new Date('2026-04-21T10:00:00Z'),
            completed_at: null,
            resource_name: 'Tech 1',
          },
          {
            id: JOB_ID_B,
            title: 'No pings',
            status: 'completed',
            scheduled_at: new Date('2026-04-21T11:00:00Z'),
            completed_at: null,
            resource_name: 'Tech 2',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            active_job_id: JOB_ID_A,
            latitude: 1,
            longitude: 2,
            accuracy_m: null,
            heading_deg: null,
            speed_mps: null,
            recorded_at: new Date('2026-04-21T10:05:00Z'),
            received_at: new Date('2026-04-21T10:05:01Z'),
          },
        ],
      });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody, getHeaders } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({ job_ids: [JOB_ID_A, JOB_ID_B], include_empty: false, format: 'csv' }),
      res,
    );

    expect(getStatus()).toBe(200);
    expect(getHeaders()['X-Route-Export-Included']).toBe('1');
    expect(getHeaders()['X-Route-Export-Skipped-Empty']).toBe('1');
    expect(getHeaders()['X-Route-Export-Format']).toBe('csv');

    const zip = await JSZip.loadAsync(getBody() as Buffer);
    const filenames = Object.keys(zip.files);
    expect(filenames).toContain(`route-${JOB_ID_A}-2026-04-21.csv`);
    // Empty job is omitted entirely from the archive contents.
    expect(filenames.some((f) => f.startsWith(`route-${JOB_ID_B}-`))).toBe(false);

    const csvA = await zip.file(`route-${JOB_ID_A}-2026-04-21.csv`)!.async('string');
    expect(csvA).toMatch(/^recorded_at,latitude,longitude,accuracy_m,heading_deg,speed_mps/);
    expect(csvA).toContain('1,2');

    const manifest = await zip.file('manifest.csv')!.async('string');
    // Manifest still records the skipped job so the dispatcher can audit it.
    expect(manifest).toContain(JOB_ID_B);
  });

  it('applies date_from / date_to in filter mode against COALESCE(scheduled_at, created_at)', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: JOB_ID_A,
            title: 'Filtered',
            status: 'completed',
            scheduled_at: new Date('2026-04-25T09:00:00Z'),
            completed_at: null,
            resource_name: 'Tech 1',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({
        filters: { status: 'completed', resource_id: 'res-9' },
        date_from: '2026-04-20T00:00:00.000Z',
        date_to: '2026-04-26T23:59:59.999Z',
      }),
      res,
    );

    expect(getStatus()).toBe(200);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/j\.tenant_id\s*=\s*\$1/);
    expect(sql).toMatch(/j\.status\s*=\s*\$2/);
    expect(sql).toMatch(/j\.resource_id\s*=\s*\$3/);
    expect(sql).toMatch(/COALESCE\(j\.scheduled_at, j\.created_at\)\s*>=\s*\$4::timestamptz/);
    expect(sql).toMatch(/COALESCE\(j\.scheduled_at, j\.created_at\)\s*<=\s*\$5::timestamptz/);
    expect(queryMock.mock.calls[0][1].slice(0, 6)).toEqual([
      TENANT_ID,
      'completed',
      'res-9',
      '2026-04-20T00:00:00.000Z',
      '2026-04-26T23:59:59.999Z',
      501, // BULK_ROUTE_EXPORT_MAX_JOBS + 1 — used for over-limit detection
    ]);
  });

  it('rejects filter results that exceed the per-request cap with a clear error', async () => {
    const oversizedRows = Array.from({ length: 501 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      title: 'x',
      status: 'completed',
      scheduled_at: new Date(),
      completed_at: null,
      resource_name: null,
    }));
    queryMock.mockResolvedValueOnce({ rows: oversizedRows });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({
        filters: { status: 'completed' },
        date_from: '2026-01-01T00:00:00.000Z',
        date_to: '2026-12-31T00:00:00.000Z',
      }),
      res,
    );
    expect(getStatus()).toBe(400);
    const body = getBody() as Record<string, unknown>;
    expect(String(body.error)).toMatch(/Narrow the date range/i);
    expect(body.matched_at_least).toBe(501);
    // Critically: we never fanned out to the breadcrumb query.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('ignores unknown filter keys silently (never injects them into SQL)', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: JOB_ID_A,
            title: 'x',
            status: 'completed',
            scheduled_at: new Date('2026-04-20T00:00:00Z'),
            completed_at: null,
            resource_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({
        filters: {
          status: 'completed',
          // These keys are NOT in BULK_ROUTE_EXPORT_ALLOWED_FILTERS — must
          // not appear anywhere in the generated SQL.
          tenant_id: 'other-tenant',
          'id; DROP TABLE dispatch_jobs--': 'x',
        },
      }),
      res,
    );
    expect(getStatus()).toBe(200);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).not.toMatch(/DROP TABLE/i);
    // Status filter is honored, but the unknown keys never make it into
    // either the SQL fragment or the parameter list.
    expect(sql).toMatch(/j\.status\s*=\s*\$2/);
    const params = queryMock.mock.calls[0][1] as unknown[];
    expect(params).not.toContain('other-tenant');
  });

  // ----- Async (email-me-the-archive) path -----

  it('async mode: 400 when the requesting user has no email on file', async () => {
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq(
        { job_ids: [JOB_ID_A], async: true },
        { user: { tenantId: TENANT_ID, userId: 'user-1', role: 'admin' } },
      ),
      res,
    );
    expect(getStatus()).toBe(400);
    expect(String((getBody() as Record<string, unknown>).error)).toMatch(/email/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('async mode: rejects job_ids selections larger than the raised cap of 5000', async () => {
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const tooMany: string[] = [];
    for (let i = 0; i < 5001; i++) {
      // Pad to 12 chars so the resulting UUID-shaped string stays the same length.
      tooMany.push(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    }
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({ job_ids: tooMany, async: true }),
      res,
    );
    expect(getStatus()).toBe(400);
    const body = getBody() as Record<string, unknown>;
    // Error must reference the *async* limit (5000) — not the 500-job sync cap.
    expect(String(body.error)).toMatch(/Too many jobs/i);
    expect(String(body.error)).toContain('5000');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('async mode: accepts job batches above the sync cap and returns 202 with export_job', async () => {
    // Build a 600-row resolution result — well above the 500-job sync
    // cap, comfortably under the 5000-job async cap. The async path
    // should accept it; the sync path would 400.
    const overSyncCapJobIds: string[] = [];
    const resolvedRows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 600; i++) {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      overSyncCapJobIds.push(id);
      resolvedRows.push({
        id,
        title: `job-${i}`,
        status: 'completed',
        scheduled_at: new Date('2026-04-25T09:00:00Z'),
        completed_at: null,
        resource_name: null,
      });
    }

    queryMock
      // Step 1: jobs lookup — returns all 600 rows
      .mockResolvedValueOnce({ rows: resolvedRows })
      // Step 2: INSERT INTO dispatch_route_export_jobs — returns the row
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'export-job-async-1',
            status: 'pending',
            created_at: new Date('2026-04-29T10:00:00Z'),
          },
        ],
      });

    // Capture the worker callback so it doesn't actually run during the
    // test — we only want to assert the synchronous 202 contract here.
    // The worker itself is exercised in a separate test below.
    const setImmediateSpy = vi.spyOn(global, 'setImmediate').mockImplementation(((
      _cb: (...a: unknown[]) => void,
    ) => ({}) as ReturnType<typeof setImmediate>) as typeof setImmediate);

    try {
      const dispatch = await import('../../server/admin-api/routes/dispatch');
      const { res, getStatus, getBody } = makeRes();
      await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
        makeReq({ job_ids: overSyncCapJobIds, async: true, format: 'gpx' }),
        res,
      );

      expect(getStatus()).toBe(202);
      const body = getBody() as { export_job?: Record<string, unknown> };
      expect(body.export_job).toBeTruthy();
      expect(body.export_job!.id).toBe('export-job-async-1');
      expect(body.export_job!.status).toBe('pending');
      expect(body.export_job!.job_count).toBe(600);
      expect(body.export_job!.format).toBe('gpx');
      expect(body.export_job!.requested_email).toBe('dispatcher@example.com');

      // INSERT must be tenant-scoped and capture user id, email, format,
      // include_empty default (true), and the snapshotted resolved ids.
      const insertCall = queryMock.mock.calls[1];
      expect(String(insertCall[0])).toMatch(/INSERT INTO dispatch_route_export_jobs/);
      const params = insertCall[1] as unknown[];
      expect(params[0]).toBe(TENANT_ID);
      expect(params[1]).toBe('user-1');
      expect(params[2]).toBe('dispatcher@example.com');
      expect(params[3]).toBe('gpx');
      expect(params[4]).toBe(true); // include_empty default
      const selection = JSON.parse(String(params[5])) as { resolved_job_ids: string[] };
      expect(selection.resolved_job_ids).toHaveLength(600);
      expect(selection.resolved_job_ids[0]).toBe(overSyncCapJobIds[0]);
      expect(params[6]).toBe(600); // job_count

      // The worker fires asynchronously — we captured the callback via
      // the spy but never invoked it.
      expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    } finally {
      setImmediateSpy.mockRestore();
    }
  });

  it('async mode: 404 when the snapshotted selection resolves to zero jobs (no row inserted)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.bulkExportJobRoutesHandler as (req: Request, res: Response) => Promise<void>)(
      makeReq({ job_ids: [JOB_ID_A], async: true }),
      res,
    );
    expect(getStatus()).toBe(404);
    expect(getBody()).toEqual({ error: 'No jobs matched the selection.' });
    // Specifically: we never INSERTed an export-job row for an empty
    // selection (otherwise the dispatcher would receive a "ready" email
    // pointing at an archive containing nothing).
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(String(queryMock.mock.calls[0][0])).not.toMatch(/INSERT/);
  });

  // ----- processRouteExportJob worker -----

  it('processRouteExportJob: builds archive, uploads to storage, marks ready, sends email', async () => {
    queryMock
      // 1. SELECT the export-job row
      .mockResolvedValueOnce({
        rows: [
          {
            tenant_id: TENANT_ID,
            requested_by_email: 'dispatcher@example.com',
            requested_by_user_id: 'user-1',
            format: 'gpx',
            include_empty: true,
            selection: { resolved_job_ids: [JOB_ID_A] },
          },
        ],
      })
      // 2. UPDATE pending → running
      .mockResolvedValueOnce({ rows: [] })
      // 3. resolveExportJobs: jobs lookup (snapshotted ids)
      .mockResolvedValueOnce({
        rows: [
          {
            id: JOB_ID_A,
            title: 'Furnace tune-up',
            status: 'completed',
            scheduled_at: new Date('2026-04-20T13:00:00Z'),
            completed_at: new Date('2026-04-20T15:30:00Z'),
            resource_name: 'Tech 1',
          },
        ],
      })
      // 4. buildRouteArchive: breadcrumb points
      .mockResolvedValueOnce({
        rows: [
          {
            active_job_id: JOB_ID_A,
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
      // 5. UPDATE → ready (with archive path / token / expiry)
      .mockResolvedValueOnce({ rows: [] })
      // 6. SELECT users (first_name lookup)
      .mockResolvedValueOnce({ rows: [{ first_name: 'Dana' }] })
      // 7. SELECT tenants (display name lookup)
      .mockResolvedValueOnce({ rows: [{ name: 'Acme HVAC' }] })
      // 8. UPDATE email_sent_at + email_message_id
      .mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await dispatch.processRouteExportJob('export-job-1');

    // Archive was uploaded to the tenant-namespaced object storage key.
    expect(uploadPrivateObjectMock).toHaveBeenCalledTimes(1);
    const uploadArgs = uploadPrivateObjectMock.mock.calls[0];
    expect(uploadArgs[0]).toBe(`dispatch-route-exports/${TENANT_ID}/export-job-1.zip`);
    expect(Buffer.isBuffer(uploadArgs[1])).toBe(true);
    expect(uploadArgs[2]).toBe('application/zip');

    // The "ready" UPDATE writes the archive path, filename, byte count,
    // download token, and a future expiry.
    const readyUpdate = queryMock.mock.calls[4];
    expect(String(readyUpdate[0])).toMatch(/SET status = 'ready'/);
    const readyParams = readyUpdate[1] as unknown[];
    expect(readyParams[0]).toBe('export-job-1');
    expect(String(readyParams[1])).toContain(`dispatch-route-exports/${TENANT_ID}/export-job-1.zip`);
    expect(String(readyParams[2])).toMatch(/^dispatch-routes-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(typeof readyParams[3]).toBe('number'); // archive_bytes
    expect(String(readyParams[4])).toMatch(/^[a-f0-9]{64}$/); // 32-byte hex token
    expect(new Date(String(readyParams[5])).getTime()).toBeGreaterThan(Date.now());
    expect(readyParams[6]).toBe(1); // included_count
    expect(readyParams[7]).toBe(0); // skipped_empty

    // Email was rendered with the resolver context and sent to the
    // requester. The signed download link must use the export-job id
    // and the same hex token persisted on the row.
    expect(readyEmailMock).toHaveBeenCalledTimes(1);
    const emailCtx = readyEmailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(emailCtx.tenantName).toBe('Acme HVAC');
    expect(emailCtx.requesterFirstName).toBe('Dana');
    expect(emailCtx.jobCount).toBe(1);
    expect(emailCtx.includedCount).toBe(1);
    expect(emailCtx.format).toBe('gpx');
    expect(String(emailCtx.downloadUrl)).toContain('/api/dispatch/route-exports/export-job-1/download?token=');
    expect(String(emailCtx.downloadUrl)).toContain(String(readyParams[4]));

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({
      to: 'dispatcher@example.com',
      subject: expect.stringMatching(/ready/i) as unknown as string,
    });
    // Failure email path must NOT have fired.
    expect(failedEmailMock).not.toHaveBeenCalled();
  });

  it('processRouteExportJob: marks failed and sends failure email when archive build throws', async () => {
    queryMock
      // 1. SELECT the export-job row
      .mockResolvedValueOnce({
        rows: [
          {
            tenant_id: TENANT_ID,
            requested_by_email: 'dispatcher@example.com',
            requested_by_user_id: 'user-1',
            format: 'csv',
            include_empty: true,
            selection: { resolved_job_ids: [JOB_ID_A] },
          },
        ],
      })
      // 2. UPDATE pending → running
      .mockResolvedValueOnce({ rows: [] })
      // 3. resolveExportJobs: jobs lookup returns empty — worker raises
      .mockResolvedValueOnce({ rows: [] })
      // 4. UPDATE → failed
      .mockResolvedValueOnce({ rows: [] });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    await dispatch.processRouteExportJob('export-job-fail-1');

    // Archive was never built or uploaded.
    expect(uploadPrivateObjectMock).not.toHaveBeenCalled();
    expect(readyEmailMock).not.toHaveBeenCalled();

    // The failure UPDATE captures the truncated error message.
    const failedUpdate = queryMock.mock.calls[3];
    expect(String(failedUpdate[0])).toMatch(/SET status = 'failed'/);
    const failedParams = failedUpdate[1] as unknown[];
    expect(failedParams[0]).toBe('export-job-fail-1');
    expect(String(failedParams[1])).toMatch(/snapshotted selection/i);

    // Failure email goes out so the dispatcher knows to retry rather
    // than silently waiting for a "ready" email that will never arrive.
    expect(failedEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({
      to: 'dispatcher@example.com',
      subject: expect.stringMatching(/could not/i) as unknown as string,
    });
  });
});

// ---------------------------------------------------------------------------
// downloadRouteExportHandler — public, token-authenticated archive download.
//
// This endpoint is intentionally **unauthenticated** (no JWT, no session
// cookie) because the link is delivered by email and the dispatcher's mail
// client follows it without our cookie. The opaque per-export
// `download_token` is the only credential, with explicit gates for:
//   - missing token         → 400
//   - bad token / wrong id  → 404
//   - status != 'ready'     → 409
//   - expired link          → 410
//   - happy path            → 200, streams archive with attachment filename
//
// A bug here could leak archives across tenants, so each gate is tested
// in isolation against the same token-authenticated SQL the handler runs.
// ---------------------------------------------------------------------------

const EXPORT_JOB_ID = 'export-job-download-1';
const VALID_TOKEN = 'a'.repeat(64);

function makeDownloadReq(
  params: { id?: string } = {},
  query: { token?: string } = {},
): Request {
  return {
    params: { id: params.id ?? EXPORT_JOB_ID },
    query: query.token === undefined ? {} : { token: query.token },
    body: {},
    method: 'GET',
    headers: {},
    cookies: {},
    ip: '127.0.0.1',
  } as unknown as Request;
}

describe('downloadRouteExportHandler', () => {
  it('returns 400 when the token query parameter is missing', async () => {
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.downloadRouteExportHandler as (req: Request, res: Response) => Promise<void>)(
      makeDownloadReq({}, {}),
      res,
    );
    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: 'Missing download token' });
    // Critically: we never opened a privileged DB connection for an
    // obviously-malformed request — that keeps the unauthenticated
    // surface cheap and keeps junk requests off the RLS-bypass path.
    expect(withPrivilegedClientMock).not.toHaveBeenCalled();
    expect(streamPrivateObjectMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty token string', async () => {
    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.downloadRouteExportHandler as (req: Request, res: Response) => Promise<void>)(
      makeDownloadReq({}, { token: '' }),
      res,
    );
    expect(getStatus()).toBe(400);
    expect(getBody()).toEqual({ error: 'Missing download token' });
    expect(withPrivilegedClientMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the token does not match any export row', async () => {
    // Privileged lookup runs but finds no row matching (id, token).
    // This same shape covers both "token guess for a real id" and
    // "wrong id supplied" — the WHERE clause filters on both.
    const clientQuery = vi.fn().mockResolvedValueOnce({ rows: [] });
    withPrivilegedClientMock.mockImplementation(async (cb: (c: { query: typeof clientQuery }) => unknown) => {
      return cb({ query: clientQuery });
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.downloadRouteExportHandler as (req: Request, res: Response) => Promise<void>)(
      makeDownloadReq({ id: EXPORT_JOB_ID }, { token: 'not-a-real-token' }),
      res,
    );

    expect(getStatus()).toBe(404);
    expect(getBody()).toEqual({ error: 'Export not found or token invalid' });
    // The WHERE clause must bind BOTH the id and the token — otherwise a
    // valid token for export A would unlock export B.
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(String(clientQuery.mock.calls[0][0])).toMatch(/WHERE id = \$1 AND download_token = \$2/);
    expect(clientQuery.mock.calls[0][1]).toEqual([EXPORT_JOB_ID, 'not-a-real-token']);
    // Never streamed anything from object storage.
    expect(streamPrivateObjectMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the export row exists but status is not 'ready'", async () => {
    const clientQuery = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: EXPORT_JOB_ID,
          tenant_id: TENANT_ID,
          status: 'running',
          archive_object_path: null,
          archive_filename: null,
          download_token: VALID_TOKEN,
          // Future expiry — proves the 409 wins over the 410 path when
          // status disqualifies the row first.
          download_expires_at: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });
    withPrivilegedClientMock.mockImplementation(async (cb: (c: { query: typeof clientQuery }) => unknown) => {
      return cb({ query: clientQuery });
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.downloadRouteExportHandler as (req: Request, res: Response) => Promise<void>)(
      makeDownloadReq({ id: EXPORT_JOB_ID }, { token: VALID_TOKEN }),
      res,
    );

    expect(getStatus()).toBe(409);
    const body = getBody() as Record<string, unknown>;
    expect(String(body.error)).toMatch(/not ready/i);
    // The error message includes the actual status so the dispatcher
    // (or our own debugging) can tell pending/running/failed apart.
    expect(String(body.error)).toContain('running');
    expect(streamPrivateObjectMock).not.toHaveBeenCalled();
  });

  it('returns 410 when the row is ready but the download link has expired', async () => {
    const clientQuery = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: EXPORT_JOB_ID,
          tenant_id: TENANT_ID,
          status: 'ready',
          archive_object_path: `/objects/private/dispatch-route-exports/${TENANT_ID}/${EXPORT_JOB_ID}.zip`,
          archive_filename: 'dispatch-routes-2026-04-20.zip',
          download_token: VALID_TOKEN,
          // Expired one hour ago.
          download_expires_at: new Date(Date.now() - 60 * 60 * 1000),
        },
      ],
    });
    withPrivilegedClientMock.mockImplementation(async (cb: (c: { query: typeof clientQuery }) => unknown) => {
      return cb({ query: clientQuery });
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.downloadRouteExportHandler as (req: Request, res: Response) => Promise<void>)(
      makeDownloadReq({ id: EXPORT_JOB_ID }, { token: VALID_TOKEN }),
      res,
    );

    expect(getStatus()).toBe(410);
    expect(getBody()).toEqual({ error: 'Download link has expired' });
    // No streaming after expiry — the archive may have been swept by
    // the retention worker, but even if it's still on disk we must
    // refuse to serve it once the per-export TTL has elapsed.
    expect(streamPrivateObjectMock).not.toHaveBeenCalled();
  });

  it('returns 410 when download_expires_at is null on the row', async () => {
    // A row without an expiry shouldn't be possible in practice (the
    // worker always writes one), but if it ever happens we should fail
    // closed rather than serving the archive forever.
    const clientQuery = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: EXPORT_JOB_ID,
          tenant_id: TENANT_ID,
          status: 'ready',
          archive_object_path: `/objects/private/dispatch-route-exports/${TENANT_ID}/${EXPORT_JOB_ID}.zip`,
          archive_filename: 'dispatch-routes-2026-04-20.zip',
          download_token: VALID_TOKEN,
          download_expires_at: null,
        },
      ],
    });
    withPrivilegedClientMock.mockImplementation(async (cb: (c: { query: typeof clientQuery }) => unknown) => {
      return cb({ query: clientQuery });
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.downloadRouteExportHandler as (req: Request, res: Response) => Promise<void>)(
      makeDownloadReq({ id: EXPORT_JOB_ID }, { token: VALID_TOKEN }),
      res,
    );

    expect(getStatus()).toBe(410);
    expect(getBody()).toEqual({ error: 'Download link has expired' });
    expect(streamPrivateObjectMock).not.toHaveBeenCalled();
  });

  it('happy path: streams the archive from object storage with the persisted Content-Disposition filename', async () => {
    const archivePath = `/objects/private/dispatch-route-exports/${TENANT_ID}/${EXPORT_JOB_ID}.zip`;
    const archiveFilename = 'dispatch-routes-2026-04-20.zip';
    const clientQuery = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: EXPORT_JOB_ID,
          tenant_id: TENANT_ID,
          status: 'ready',
          archive_object_path: archivePath,
          archive_filename: archiveFilename,
          download_token: VALID_TOKEN,
          download_expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000),
        },
      ],
    });
    withPrivilegedClientMock.mockImplementation(async (cb: (c: { query: typeof clientQuery }) => unknown) => {
      return cb({ query: clientQuery });
    });

    // For this single test, simulate the real streamer well enough to
    // assert the headers it writes — the actual ObjectStorageService
    // implementation sets Content-Type / Content-Length /
    // Content-Disposition and pipes the GCS read stream into res. We
    // mimic just the headers and a buffer "send".
    streamPrivateObjectMock.mockImplementationOnce(async (
      fullObjectPath: string,
      response: Response,
      options?: { downloadFilename?: string; cacheTtlSec?: number },
    ) => {
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Length', '12345');
      response.setHeader(
        'Cache-Control',
        `private, max-age=${options?.cacheTtlSec ?? 0}`,
      );
      if (options?.downloadFilename) {
        const safe = options.downloadFilename.replace(/"/g, '');
        response.setHeader(
          'Content-Disposition',
          `attachment; filename="${safe}"`,
        );
      }
      // Fake archive bytes — proves the handler hands the response off
      // to the storage helper rather than buffering JSON itself.
      response.send(Buffer.from('PK\u0003\u0004fake-zip-bytes'));
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody, getHeaders } = makeRes();
    await (dispatch.downloadRouteExportHandler as (req: Request, res: Response) => Promise<void>)(
      makeDownloadReq({ id: EXPORT_JOB_ID }, { token: VALID_TOKEN }),
      res,
    );

    // The handler did not status-error before reaching the streamer.
    expect(getStatus()).toBe(200);

    // streamPrivateObject was called with the persisted archive path
    // and the persisted filename — NOT with anything derived from the
    // request URL, which would let an attacker influence the key.
    expect(streamPrivateObjectMock).toHaveBeenCalledTimes(1);
    const [pathArg, resArg, optsArg] = streamPrivateObjectMock.mock.calls[0];
    expect(pathArg).toBe(archivePath);
    expect(resArg).toBe(res);
    expect(optsArg).toEqual({ downloadFilename: archiveFilename });

    // Headers came from the streamer — including Content-Disposition,
    // which is the actual contract this test is guarding.
    const headers = getHeaders();
    expect(headers['Content-Type']).toBe('application/zip');
    expect(headers['Content-Disposition']).toBe(
      `attachment; filename="${archiveFilename}"`,
    );

    // The body is the raw archive bytes the streamer piped through.
    expect(Buffer.isBuffer(getBody())).toBe(true);
  });

  it('falls back to a synthesized filename when archive_filename is missing on the row', async () => {
    // Defensive path: if a legacy row somehow lacks archive_filename we
    // still hand the dispatcher a sensible attachment name rather than
    // exposing the storage object key in the Content-Disposition.
    const archivePath = `/objects/private/dispatch-route-exports/${TENANT_ID}/${EXPORT_JOB_ID}.zip`;
    const clientQuery = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: EXPORT_JOB_ID,
          tenant_id: TENANT_ID,
          status: 'ready',
          archive_object_path: archivePath,
          archive_filename: null,
          download_token: VALID_TOKEN,
          download_expires_at: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });
    withPrivilegedClientMock.mockImplementation(async (cb: (c: { query: typeof clientQuery }) => unknown) => {
      return cb({ query: clientQuery });
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus } = makeRes();
    await (dispatch.downloadRouteExportHandler as (req: Request, res: Response) => Promise<void>)(
      makeDownloadReq({ id: EXPORT_JOB_ID }, { token: VALID_TOKEN }),
      res,
    );

    expect(getStatus()).toBe(200);
    expect(streamPrivateObjectMock).toHaveBeenCalledTimes(1);
    const optsArg = streamPrivateObjectMock.mock.calls[0][2] as { downloadFilename?: string };
    expect(optsArg.downloadFilename).toBe(`dispatch-routes-${EXPORT_JOB_ID}.zip`);
  });

  it('returns 500 when a ready row has no archive_object_path (corrupt state)', async () => {
    const clientQuery = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: EXPORT_JOB_ID,
          tenant_id: TENANT_ID,
          status: 'ready',
          archive_object_path: null,
          archive_filename: 'dispatch-routes-2026-04-20.zip',
          download_token: VALID_TOKEN,
          download_expires_at: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });
    withPrivilegedClientMock.mockImplementation(async (cb: (c: { query: typeof clientQuery }) => unknown) => {
      return cb({ query: clientQuery });
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.downloadRouteExportHandler as (req: Request, res: Response) => Promise<void>)(
      makeDownloadReq({ id: EXPORT_JOB_ID }, { token: VALID_TOKEN }),
      res,
    );

    expect(getStatus()).toBe(500);
    expect(getBody()).toEqual({ error: 'Archive path missing on export job' });
    expect(streamPrivateObjectMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the archive file is gone from object storage (ObjectNotFoundError)', async () => {
    const archivePath = `/objects/private/dispatch-route-exports/${TENANT_ID}/${EXPORT_JOB_ID}.zip`;
    const clientQuery = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: EXPORT_JOB_ID,
          tenant_id: TENANT_ID,
          status: 'ready',
          archive_object_path: archivePath,
          archive_filename: 'dispatch-routes-2026-04-20.zip',
          download_token: VALID_TOKEN,
          download_expires_at: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });
    withPrivilegedClientMock.mockImplementation(async (cb: (c: { query: typeof clientQuery }) => unknown) => {
      return cb({ query: clientQuery });
    });

    // Simulate the storage object having been swept after the row was
    // marked ready — `ObjectNotFoundError` is raised by the streamer
    // and the handler converts it to a friendly 404 instead of leaking
    // the underlying storage error.
    const objectStorage = await import('../../server/replit_integrations/object_storage');
    streamPrivateObjectMock.mockImplementationOnce(async () => {
      throw new objectStorage.ObjectNotFoundError();
    });

    const dispatch = await import('../../server/admin-api/routes/dispatch');
    const { res, getStatus, getBody } = makeRes();
    await (dispatch.downloadRouteExportHandler as (req: Request, res: Response) => Promise<void>)(
      makeDownloadReq({ id: EXPORT_JOB_ID }, { token: VALID_TOKEN }),
      res,
    );

    expect(getStatus()).toBe(404);
    expect(getBody()).toEqual({ error: 'Archive file no longer in storage' });
  });
});
