// PR #165 regression: attachment object_path validation and read-side checks,
// running the real ObjectStorageService against the local-disk adapter.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  poolQueryMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ query: a.poolQueryMock, connect: async () => ({ query: a.poolQueryMock, release: vi.fn() }) }),
  withPrivilegedClient: async (fn: (client: { query: typeof a.poolQueryMock }) => unknown) => fn({ query: a.poolQueryMock }),
}));
vi.mock('../../../platform/notifications/dispatchPush', () => ({ fireDispatchPush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../platform/notifications/routeExportEvents', () => ({ emitRouteExportStatusChanged: vi.fn(), subscribeRouteExportEvents: vi.fn(() => () => {}) }));
vi.mock('../../../platform/infra/rate-limit/sseConnectionLimiter', () => ({
  attachSseHeartbeat: vi.fn(() => () => {}), getTenantSseConnectionLimiter: vi.fn(), registerSseConnection: vi.fn().mockResolvedValue({ ok: true }),
  ackSseConnection: vi.fn(), resolveLiveStreamCap: vi.fn(() => 5),
}));
vi.mock('../../../platform/email', () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true }),
  dispatchRouteExportReadyEmail: vi.fn(), dispatchRouteExportFailedEmail: vi.fn(), dispatchCompletionPhotosEmail: vi.fn(),
}));
vi.mock('../../../platform/dispatch/completionPhotoToken', () => ({
  buildCompletionPhotoUrl: () => 'https://x',
  verifyCompletionPhotoToken: () => true,
}));
vi.mock('../../../platform/integrations/routing', () => ({
  enqueueJobGeocode: vi.fn(), geocodeAddressCached: vi.fn(), getDriveEta: vi.fn(), haversineMeters: () => 0,
}));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock('../../../shared/dispatch/mergeTokens', () => ({
  DISPATCH_MERGE_TOKENS: [], countSmsSegments: () => 1, findUnknownDispatchMergeTokens: () => [], renderDispatchTemplate: (s: string) => s,
}));

import { getStorageAdapter, resetStorageAdapterForTests, storageKeys } from '../../../platform/storage';
import router from './dispatch';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const saved = {
  OBJECT_STORAGE_PROVIDER: process.env.OBJECT_STORAGE_PROVIDER,
  OBJECT_STORAGE_LOCAL_DIR: process.env.OBJECT_STORAGE_LOCAL_DIR,
};
let root: string;
let attachmentRow: Record<string, unknown> | null;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'qvo-attach-'));
  process.env.OBJECT_STORAGE_PROVIDER = 'local';
  process.env.OBJECT_STORAGE_LOCAL_DIR = root;
  resetStorageAdapterForTests();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStorageAdapterForTests();
});

beforeEach(() => {
  attachmentRow = null;
  a.poolQueryMock.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM dispatch_jobs')) return { rows: [{ id: 'jb1', status: 'open' }] };
    if (sql.includes('INSERT INTO dispatch_job_attachments')) return { rows: [{ id: 'att-1' }] };
    if (sql.includes('FROM dispatch_job_attachments')) return { rows: attachmentRow ? [attachmentRow] : [] };
    return { rows: [] };
  });
});

const inserted = () =>
  a.poolQueryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO dispatch_job_attachments'));

const attach = (object_path: string) =>
  request(app()).post('/dispatch/jobs/jb1/attachments').send({ attachment_type: 'photo', object_path });

describe('POST /dispatch/jobs/:id/attachments object_path', () => {
  it.each([
    ['absolute bucket path', '/local/uploads/u1'],
    ['relative key', 'uploads/u1'],
    ['another tenant export', '/objects/dispatch-route-exports/t2/exp.zip'],
    ['traversal', '/objects/uploads/../../secret'],
  ])('rejects %s with 400 and writes nothing', async (_name, objectPath) => {
    const res = await attach(objectPath);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid object_path');
    expect(inserted()).toHaveLength(0);
  });

  it('returns 400 when the upload does not exist', async () => {
    const res = await attach('/objects/uploads/never-uploaded');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Uploaded object not found/);
    expect(inserted()).toHaveLength(0);
  });

  it('accepts an uploaded /objects/uploads/<id> path', async () => {
    await getStorageAdapter().put(storageKeys.upload('present'), Buffer.from('img'));
    const res = await attach('/objects/uploads/present');
    expect(res.status).toBeLessThan(300);
    expect(inserted()).toHaveLength(1);
    expect(inserted()[0][1]).toContain('/objects/uploads/present');
  });
});

describe('GET /dispatch/attachments/:id/file', () => {
  it('does not serve a stored absolute bucket path', async () => {
    const stored = await getStorageAdapter().put(storageKeys.upload('abs'), Buffer.from('img'));
    attachmentRow = { id: 'att-1', object_path: stored, mime_type: 'image/png' };
    const res = await request(app()).get('/dispatch/attachments/att-1/file');
    expect(res.status).toBe(404);
  });

  it('serves a stored /objects/ path', async () => {
    await getStorageAdapter().put(storageKeys.upload('ok'), Buffer.from('img'));
    attachmentRow = { id: 'att-1', object_path: '/objects/uploads/ok', mime_type: 'image/png' };
    const res = await request(app()).get('/dispatch/attachments/att-1/file');
    expect(res.status).toBe(200);
  });
});

describe('GET /dispatch/completion-photos/:id', () => {
  it('falls back to the row mime_type when storage has no content type', async () => {
    await getStorageAdapter().put(storageKeys.upload('photo'), Buffer.from('img'));
    attachmentRow = {
      id: 'att-1',
      object_path: '/objects/uploads/photo',
      mime_type: 'image/jpeg',
      title: 'Photo',
      attachment_type: 'proof_of_completion',
    };
    const res = await request(app()).get('/dispatch/completion-photos/att-1?t=t&tid=t1&exp=9999999999');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
  });
});
