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

function makeReq(body: Record<string, unknown>): Request {
  return {
    user: { tenantId: 'tenant-1', userId: 'user-1', role: 'admin' },
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
});
