import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectNotFoundError, StorageNotConfiguredError } from './errors';
import { storageKeys } from './keys';
import { createLocalStorageAdapter, LocalDiskStorage, LOCAL_STORAGE_URL_SCHEME } from './local';
import {
  createStorageAdapter,
  getStorageAdapter,
  isObjectStorageConfigured,
  resetStorageAdapterForTests,
  resolveStorageProvider,
} from './resolve';
import { createS3StorageAdapter, isS3StorageConfigured } from './s3';
import { ObjectStorageService } from '../../server/replit_integrations/object_storage/objectStorage';

const STORAGE_ENV = [
  'OBJECT_STORAGE_PROVIDER',
  'OBJECT_STORAGE_LOCAL_DIR',
  'PRIVATE_OBJECT_DIR',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_PREFIX',
  'S3_FORCE_PATH_STYLE',
] as const;

const saved: Record<string, string | undefined> = {};
for (const key of STORAGE_ENV) saved[key] = process.env[key];

function clearStorageEnv() {
  for (const key of STORAGE_ENV) delete process.env[key];
  resetStorageAdapterForTests();
}

afterEach(() => {
  for (const key of STORAGE_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetStorageAdapterForTests();
});

describe('resolveStorageProvider', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveStorageProvider({})).toBeNull();
    expect(isObjectStorageConfigured({})).toBe(false);
  });

  it('selects s3 when OBJECT_STORAGE_PROVIDER=s3 and credentials are present', () => {
    expect(
      resolveStorageProvider({
        OBJECT_STORAGE_PROVIDER: 's3',
        S3_BUCKET: 'qvo',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toBe('s3');
  });

  it('does not select s3 when the operator asked for s3 but left credentials unset', () => {
    expect(resolveStorageProvider({ OBJECT_STORAGE_PROVIDER: 's3', S3_BUCKET: 'qvo' })).toBeNull();
    expect(isS3StorageConfigured({ S3_BUCKET: 'qvo' })).toBe(false);
  });

  it('selects local when OBJECT_STORAGE_PROVIDER=local (or disk)', () => {
    expect(resolveStorageProvider({ OBJECT_STORAGE_PROVIDER: 'local' })).toBe('local');
    expect(resolveStorageProvider({ OBJECT_STORAGE_PROVIDER: 'disk' })).toBe('local');
  });

  it('selects replit when PRIVATE_OBJECT_DIR is set', () => {
    expect(resolveStorageProvider({ PRIVATE_OBJECT_DIR: '/bucket/private' })).toBe('replit');
  });

  it('prefers an explicit provider over auto-detect', () => {
    expect(
      resolveStorageProvider({
        OBJECT_STORAGE_PROVIDER: 'local',
        PRIVATE_OBJECT_DIR: '/bucket/private',
        S3_BUCKET: 'qvo',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toBe('local');
  });

  it('auto-selects s3 when the credential trio is set', () => {
    expect(
      resolveStorageProvider({
        S3_BUCKET: 'qvo',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toBe('s3');
  });

  it('rejects an unknown provider name', () => {
    expect(() => resolveStorageProvider({ OBJECT_STORAGE_PROVIDER: 'gcs' })).toThrow(
      /OBJECT_STORAGE_PROVIDER must be one of/,
    );
  });

  it('does not treat NODE_ENV=test as an implicit local backend', () => {
    expect(resolveStorageProvider({ NODE_ENV: 'test', VITEST: 'true' })).toBeNull();
  });
});

describe('LocalDiskStorage', () => {
  it('writes, reads, streams, and deletes under the configured root', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    try {
      const adapter = new LocalDiskStorage(root);
      const stored = await adapter.put(storageKeys.recording('t1', 'CA123'), Buffer.from('audio'), {
        contentType: 'audio/mpeg',
      });
      expect(stored).toBe('/local/recordings/t1/CA123');
      expect(await adapter.exists(stored)).toBe(true);
      expect(await adapter.get(stored)).toEqual(Buffer.from('audio'));
      expect((await adapter.getMetadata(stored)).size).toBe(5);

      const stream = await adapter.createReadStream(storageKeys.recording('t1', 'CA123'));
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('audio');

      expect(await adapter.delete(stored)).toBe(true);
      expect(await adapter.exists(stored)).toBe(false);
      expect(await adapter.delete(stored)).toBe(false);
      await expect(adapter.get(stored)).rejects.toBeInstanceOf(ObjectNotFoundError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses path traversal', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    try {
      const adapter = new LocalDiskStorage(root);
      await expect(adapter.put('../outside', Buffer.from('x'))).rejects.toThrow(/Invalid object key/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes local-storage signed upload URLs to /objects/ paths', async () => {
    const adapter = new LocalDiskStorage('/tmp/unused');
    const signed = await adapter.getSignedUploadUrl(storageKeys.upload('abc'), 60);
    expect(signed.url.startsWith(LOCAL_STORAGE_URL_SCHEME)).toBe(true);
    expect(signed.objectPath).toBe('/objects/uploads/abc');
    expect(adapter.normalizeObjectPath(signed.url)).toBe('/objects/uploads/abc');
  });

  it('persists export and upload keys next to recordings', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    try {
      const adapter = new LocalDiskStorage(root);
      const exportPath = await adapter.put(
        storageKeys.routeExport('t1', 'exp-1'),
        Buffer.from('zip'),
        { contentType: 'application/zip' },
      );
      const uploadPath = await adapter.put(storageKeys.upload('u1'), Buffer.from('img'), {
        contentType: 'image/jpeg',
      });
      expect(exportPath).toBe('/local/dispatch-route-exports/t1/exp-1.zip');
      expect(uploadPath).toBe('/local/uploads/u1');
      expect(await readFile(path.join(root, 'dispatch-route-exports/t1/exp-1.zip'), 'utf8')).toBe(
        'zip',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createStorageAdapter / getStorageAdapter', () => {
  it('throws when storage is not configured', () => {
    clearStorageEnv();
    expect(() => createStorageAdapter({})).toThrow(StorageNotConfiguredError);
  });

  it('returns a local adapter when OBJECT_STORAGE_PROVIDER=local', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    try {
      const adapter = createStorageAdapter({
        OBJECT_STORAGE_PROVIDER: 'local',
        OBJECT_STORAGE_LOCAL_DIR: root,
      });
      expect(adapter.provider).toBe('local');
      expect(createLocalStorageAdapter({ OBJECT_STORAGE_LOCAL_DIR: root }).provider).toBe('local');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ObjectStorageService routes uploads and deletes through the local adapter', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    try {
      process.env.OBJECT_STORAGE_PROVIDER = 'local';
      process.env.OBJECT_STORAGE_LOCAL_DIR = root;
      resetStorageAdapterForTests();
      const svc = new ObjectStorageService();
      const stored = await svc.uploadPrivateObject(
        storageKeys.recording('t1', 'CA1'),
        Buffer.from('rec'),
        'audio/mpeg',
      );
      expect(stored).toBe('/local/recordings/t1/CA1');
      expect(await svc.deletePrivateObject(stored)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caches the process-wide adapter until reset', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    try {
      process.env.OBJECT_STORAGE_PROVIDER = 'local';
      process.env.OBJECT_STORAGE_LOCAL_DIR = root;
      resetStorageAdapterForTests();
      const first = getStorageAdapter();
      expect(getStorageAdapter()).toBe(first);
      resetStorageAdapterForTests();
      expect(getStorageAdapter()).not.toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('S3CompatibleStorage (mocked SDK)', () => {
  it('puts, heads, gets, and deletes through the S3 client', async () => {
    const send = vi.fn();
    send
      .mockResolvedValueOnce({}) // put
      .mockResolvedValueOnce({}) // exists head
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2]) } }) // get
      .mockResolvedValueOnce({}) // delete exists head
      .mockResolvedValueOnce({}) // delete
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })); // exists after delete

    const adapter = createS3StorageAdapter(
      {
        S3_BUCKET: 'qvo-objects',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
        S3_PREFIX: 'prod',
      },
      { send } as never,
    );

    const stored = await adapter.put(storageKeys.upload('u1'), Buffer.from('ab'), {
      contentType: 'image/png',
    });
    expect(stored).toBe('/qvo-objects/prod/uploads/u1');
    expect(await adapter.exists(stored)).toBe(true);
    expect(await adapter.get(stored)).toEqual(Buffer.from([1, 2]));
    expect(await adapter.delete(stored)).toBe(true);
    expect(await adapter.exists(stored)).toBe(false);
    expect(send).toHaveBeenCalled();
  });

  it('normalizes a Supabase-style presigned URL to /objects/<key>', () => {
    const adapter = createS3StorageAdapter(
      {
        S3_BUCKET: 'qvo-objects',
        S3_ACCESS_KEY_ID: 'id',
        S3_SECRET_ACCESS_KEY: 'secret',
        S3_ENDPOINT: 'https://abc.supabase.co/storage/v1/s3',
      },
      { send: vi.fn() } as never,
    );
    const url =
      'https://abc.supabase.co/storage/v1/s3/qvo-objects/uploads/u1?X-Amz-Algorithm=AWS4-HMAC-SHA256';
    expect(adapter.normalizeObjectPath(url)).toBe('/objects/uploads/u1');
  });
});
