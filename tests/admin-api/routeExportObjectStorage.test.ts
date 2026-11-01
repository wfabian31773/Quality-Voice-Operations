// Runs the real route-export download handlers and cleanup cycle against the
// real S3 and Replit adapters (only the SDK transport is faked) to prove the path
// persisted at export time resolves to the archive for every bucket / prefix /
// private-dir combination.
import { S3Client } from '@aws-sdk/client-s3';
import { PassThrough, Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withPrivilegedClient } from '../../platform/db';
import { runRouteExportArchiveCleanupCycle } from '../../platform/dispatch/RouteExportArchiveCleanupScheduler';
import { objectStorageClient, resetStorageAdapterForTests, storageKeys } from '../../platform/storage';
import { ObjectStorageService } from '../../server/replit_integrations/object_storage';

const queryMock = vi.fn();
const withPrivilegedClientMock = withPrivilegedClient as unknown as ReturnType<typeof vi.fn>;

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  getPrivilegedPool: () => ({ query: queryMock }),
  withTenantContext: vi.fn(async () => {}),
  withPrivilegedClient: vi.fn(),
}));
vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(async () => {}),
}));
vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (_req: Request, _res: Response, next: () => void) => next(),
  requireRole: () => (_req: Request, _res: Response, next: () => void) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: () => void) => next(),
}));
vi.mock('../../platform/email', () => ({
  sendEmail: vi.fn(),
  dispatchRouteExportReadyEmail: vi.fn(),
  dispatchRouteExportFailedEmail: vi.fn(),
}));

const STORAGE_ENV = [
  'OBJECT_STORAGE_PROVIDER',
  'PRIVATE_OBJECT_DIR',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PREFIX',
] as const;
const saved: Record<string, string | undefined> = {};
for (const name of STORAGE_ENV) saved[name] = process.env[name];

const TENANT_ID = 'tenant-1';
const EXPORT_ID = '33333333-3333-3333-3333-333333333333';
const TOKEN = 'a'.repeat(64);
const ARCHIVE = Buffer.from('PK-archive-bytes');

const objects = new Map<string, Buffer>();

function useS3(bucket: string, prefix?: string) {
  process.env.OBJECT_STORAGE_PROVIDER = 's3';
  process.env.S3_BUCKET = bucket;
  process.env.S3_ACCESS_KEY_ID = 'id';
  process.env.S3_SECRET_ACCESS_KEY = 'secret';
  if (prefix) process.env.S3_PREFIX = prefix;
  else delete process.env.S3_PREFIX;
  resetStorageAdapterForTests();
}

function useReplit(privateDir: string) {
  process.env.OBJECT_STORAGE_PROVIDER = 'replit';
  process.env.PRIVATE_OBJECT_DIR = privateDir;
  resetStorageAdapterForTests();
  vi.spyOn(objectStorageClient, 'bucket').mockImplementation(((bucketName: string) => ({
    file: (objectName: string) => {
      const id = `${bucketName}/${objectName}`;
      const stored = () => {
        const body = objects.get(id);
        if (!body) throw Object.assign(new Error('missing'), { code: 404 });
        return body;
      };
      return {
        save: async (body: Buffer) => void objects.set(id, body),
        exists: async () => [objects.has(id)],
        getMetadata: async () => [{ contentType: 'application/zip', size: stored().length }],
        createReadStream: () => Readable.from([stored()]),
        delete: async () => {
          stored();
          objects.delete(id);
        },
      };
    },
  })) as never);
}

function makeRes() {
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const res = Object.assign(new PassThrough(), {
    statusCode: 200,
    jsonBody: undefined as unknown,
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
    },
  });
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { res, headers, body: () => Buffer.concat(chunks) };
}

function readyRow(archivePath: string) {
  return {
    id: EXPORT_ID,
    tenant_id: TENANT_ID,
    status: 'ready',
    archive_object_path: archivePath,
    archive_filename: 'routes.zip',
    download_token: TOKEN,
    download_expires_at: new Date(Date.now() + 60_000),
  };
}

beforeEach(() => {
  objects.clear();
  queryMock.mockReset();
  withPrivilegedClientMock.mockReset();
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: {
    constructor: { name: string };
    input: { Key: string; Body?: Buffer };
  }) => {
    const { Key, Body } = command.input;
    if (command.constructor.name === 'PutObjectCommand') {
      objects.set(Key, Body as Buffer);
      return {};
    }
    const stored = objects.get(Key);
    if (!stored) {
      throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    }
    if (command.constructor.name === 'DeleteObjectCommand') objects.delete(Key);
    if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from([stored]) };
    return { ContentType: 'application/zip', ContentLength: stored.length };
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of STORAGE_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetStorageAdapterForTests();
});

const ARCHIVE_KEY = `dispatch-route-exports/${TENANT_ID}/${EXPORT_ID}.zip`;

describe.each([
  { backend: 's3 bucket=objects prefix=prod', use: () => useS3('objects', 'prod'), objectKey: `prod/${ARCHIVE_KEY}` },
  { backend: 's3 bucket=objects', use: () => useS3('objects'), objectKey: ARCHIVE_KEY },
  { backend: 's3 bucket=qvo-objects prefix=prod', use: () => useS3('qvo-objects', 'prod'), objectKey: `prod/${ARCHIVE_KEY}` },
  { backend: 's3 bucket=qvo-objects', use: () => useS3('qvo-objects'), objectKey: ARCHIVE_KEY },
  { backend: 'replit dir=/objects/private', use: () => useReplit('/objects/private'), objectKey: `objects/private/${ARCHIVE_KEY}` },
  { backend: 'replit dir=/qvo-bucket/private', use: () => useReplit('/qvo-bucket/private'), objectKey: `qvo-bucket/private/${ARCHIVE_KEY}` },
])('route-export archive on $backend', ({ use, objectKey }) => {
  // Same call the export worker makes before saving archive_object_path.
  async function storeArchive(): Promise<string> {
    use();
    const archivePath = await new ObjectStorageService().uploadPrivateObject(
      storageKeys.routeExport(TENANT_ID, EXPORT_ID),
      ARCHIVE,
      'application/zip',
    );
    expect([...objects.keys()]).toEqual([objectKey]);
    return archivePath;
  }

  it('serves the persisted path through the token download', async () => {
    const archivePath = await storeArchive();
    withPrivilegedClientMock.mockImplementation(async (cb: (c: { query: unknown }) => unknown) =>
      cb({ query: vi.fn().mockResolvedValue({ rows: [readyRow(archivePath)] }) }),
    );

    const { downloadRouteExportHandler } = await import('../../server/admin-api/routes/dispatch');
    const { res, headers, body } = makeRes();
    await (downloadRouteExportHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { params: { id: EXPORT_ID }, query: { token: TOKEN } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(body()).toEqual(ARCHIVE);
    expect(headers['Content-Disposition']).toBe('attachment; filename="routes.zip"');
  });

  it('serves the persisted path through the authenticated download', async () => {
    const archivePath = await storeArchive();
    queryMock.mockResolvedValue({ rows: [readyRow(archivePath)] });

    const { downloadRouteExportAuthenticatedHandler } = await import('../../server/admin-api/routes/dispatch');
    const { res, body } = makeRes();
    await (downloadRouteExportAuthenticatedHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { params: { id: EXPORT_ID }, user: { tenantId: TENANT_ID } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(body()).toEqual(ARCHIVE);
  });

  it('cleanup deletes the archive instead of reporting it already gone', async () => {
    const archivePath = await storeArchive();
    const selectRows = [{ ...readyRow(archivePath), download_expires_at: new Date(Date.now() - 60_000) }];
    let call = 0;
    withPrivilegedClientMock.mockImplementation(async (cb: (c: { query: unknown }) => unknown) => {
      const rows = call === 0 ? selectRows : [];
      call += 1;
      return cb({ query: vi.fn().mockResolvedValue({ rows }) });
    });

    const result = await runRouteExportArchiveCleanupCycle();

    expect(result).toEqual({ scanned: 1, deleted: 1, alreadyGone: 0, failed: 0 });
    expect(objects.size).toBe(0);
  });
});
