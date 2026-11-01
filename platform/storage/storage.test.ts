import { S3Client } from '@aws-sdk/client-s3';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidObjectPathError, ObjectNotFoundError, StorageNotConfiguredError } from './errors';
import { storageKeys } from './keys';
import { createLocalStorageAdapter, LocalDiskStorage, LOCAL_STORAGE_URL_SCHEME } from './local';
import {
  createStorageAdapter,
  getStorageAdapter,
  isObjectStorageConfigured,
  resetStorageAdapterForTests,
  resolveStorageProvider,
} from './resolve';
import { ReplitSidecarStorage } from './replit';
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

  it('prefers PRIVATE_OBJECT_DIR over S3 names unless s3 is explicit', () => {
    const env = {
      PRIVATE_OBJECT_DIR: '/bucket/private',
      S3_BUCKET: 'qvo',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
    };
    expect(resolveStorageProvider(env)).toBe('replit');
    expect(resolveStorageProvider({ ...env, OBJECT_STORAGE_PROVIDER: 's3' })).toBe('s3');
  });

  it('rejects an unknown provider name', () => {
    expect(() => resolveStorageProvider({ OBJECT_STORAGE_PROVIDER: 'gcs' })).toThrow(
      /OBJECT_STORAGE_PROVIDER must be one of/,
    );
  });

  it('treats an unknown provider as not configured and logs the name once, never the value', () => {
    resetStorageAdapterForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const env = { OBJECT_STORAGE_PROVIDER: 'hunter2-value', PRIVATE_OBJECT_DIR: '/bucket/private' };
      expect(isObjectStorageConfigured(env)).toBe(false);
      expect(isObjectStorageConfigured(env)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0][0]);
      expect(logged).toContain('OBJECT_STORAGE_PROVIDER');
      expect(logged).not.toContain('hunter2-value');
    } finally {
      warn.mockRestore();
    }
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

  it('refuses keys that resolve to the root itself', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    try {
      const adapter = new LocalDiskStorage(root);
      for (const key of ['.', './', '/objects/.', '/local/']) {
        await expect(adapter.exists(key)).rejects.toThrow(/Invalid object key/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses symlinks under the root on every operation', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    try {
      mkdirSync(root);
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'secret'), 'secret');
      symlinkSync(outside, path.join(root, 'linked-dir'));
      symlinkSync(path.join(outside, 'secret'), path.join(root, 'linked-file'));
      const adapter = new LocalDiskStorage(root);

      for (const key of ['linked-dir/secret', 'linked-file']) {
        await expect(adapter.get(key)).rejects.toThrow(/Invalid object key/);
        await expect(adapter.getMetadata(key)).rejects.toThrow(/Invalid object key/);
        await expect(adapter.exists(key)).rejects.toThrow(/Invalid object key/);
        await expect(adapter.createReadStream(key)).rejects.toThrow(/Invalid object key/);
        await expect(adapter.delete(key)).rejects.toThrow(/Invalid object key/);
      }
      await expect(adapter.put('linked-dir/new', Buffer.from('x'))).rejects.toThrow(/Invalid object key/);
      await expect(adapter.put('linked-file', Buffer.from('x'))).rejects.toThrow(/Invalid object key/);
      expect(readdirSync(outside)).toEqual(['secret']);
      expect(await readFile(path.join(outside, 'secret'), 'utf8')).toBe('secret');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('works when the root itself is reached through a symlink', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    try {
      mkdirSync(path.join(base, 'real'));
      symlinkSync(path.join(base, 'real'), path.join(base, 'alias'));
      const adapter = new LocalDiskStorage(path.join(base, 'alias'));
      await adapter.put('uploads/a', Buffer.from('ok'));
      expect(await adapter.get('uploads/a')).toEqual(Buffer.from('ok'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not treat a sibling of the root as inside it when normalizing file URLs', () => {
    const adapter = new LocalDiskStorage('/tmp/qvo-root');
    expect(adapter.normalizeObjectPath('file:///tmp/qvo-root-sibling/uploads/a')).toBe(
      'file:///tmp/qvo-root-sibling/uploads/a',
    );
    expect(adapter.normalizeObjectPath('file:///tmp/qvo-root/uploads/a')).toBe('/objects/uploads/a');
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

describe('ReplitSidecarStorage (mocked client)', () => {
  function replitAdapter(privateDir: string) {
    const fileMock = {
      save: vi.fn().mockResolvedValue(undefined),
      download: vi.fn().mockResolvedValue([Buffer.from('ok')]),
      exists: vi.fn().mockResolvedValue([true]),
      setMetadata: vi.fn().mockResolvedValue(undefined),
      getMetadata: vi.fn().mockResolvedValue([{ contentType: 'application/zip', size: 2 }]),
      createReadStream: vi.fn(() => Readable.from([Buffer.from('ok')])),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const file = vi.fn(() => fileMock);
    const bucket = vi.fn(() => ({ file }));
    const adapter = new ReplitSidecarStorage({ PRIVATE_OBJECT_DIR: privateDir }, { bucket } as never);
    return { adapter, bucket, file, fileMock };
  }

  // Path resolution itself is pinned against main in replitParity.test.ts.
  it('sets the ACL only for canonical upload paths', async () => {
    const { adapter, fileMock } = replitAdapter('/bucket/private');
    const policy = { owner: 'tenant:t1', visibility: 'private' as const };
    for (const raw of ['/bucket/private/uploads/u1', 'uploads/u1', '/objects/recordings/t1/CA1']) {
      await expect(adapter.trySetAclPolicy(raw, policy)).rejects.toBeInstanceOf(InvalidObjectPathError);
    }
    expect(fileMock.setMetadata).not.toHaveBeenCalled();
    await expect(adapter.trySetAclPolicy('/objects/uploads/u1', policy)).resolves.toBe(
      '/objects/uploads/u1',
    );
    expect(fileMock.setMetadata).toHaveBeenCalledTimes(1);

    fileMock.exists.mockResolvedValue([false]);
    await expect(adapter.trySetAclPolicy('/objects/uploads/u2', policy)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });
});

describe('ObjectStorageService path validation and streaming', () => {
  const policy = { owner: 'tenant:t1', visibility: 'private' as const };

  it('accepts only existing /objects/uploads/<id> paths on every non-Replit adapter', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    try {
      const svc = new ObjectStorageService(new LocalDiskStorage(root));
      await svc.uploadPrivateObject(storageKeys.upload('u1'), Buffer.from('x'), 'image/png');

      await expect(svc.trySetObjectEntityAclPolicy('/objects/uploads/u1', policy)).resolves.toBe(
        '/objects/uploads/u1',
      );
      await expect(
        svc.trySetObjectEntityAclPolicy(`${LOCAL_STORAGE_URL_SCHEME}local/uploads/u1`, policy),
      ).resolves.toBe('/objects/uploads/u1');
      await expect(svc.trySetObjectEntityAclPolicy('/objects/uploads/missing', policy)).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
      for (const raw of [
        '/local/uploads/u1',
        'uploads/u1',
        '/objects/recordings/t1/CA1',
        '/objects/uploads/',
        '/objects/uploads/../../secret',
        '/objects/uploads/a/b',
        'file://[',
      ]) {
        await expect(svc.trySetObjectEntityAclPolicy(raw, policy)).rejects.toBeInstanceOf(
          InvalidObjectPathError,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks existence through the S3 adapter and rejects malformed URLs', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    const svc = new ObjectStorageService(
      createS3StorageAdapter(
        { S3_BUCKET: 'qvo-objects', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' },
        { send } as never,
      ),
    );
    await expect(svc.trySetObjectEntityAclPolicy('/objects/uploads/u1', policy)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(send).toHaveBeenCalledTimes(1);
    await expect(svc.trySetObjectEntityAclPolicy('https://x/%zz', policy)).rejects.toBeInstanceOf(
      InvalidObjectPathError,
    );
    await expect(svc.trySetObjectEntityAclPolicy('/qvo-objects/uploads/u1', policy)).rejects.toBeInstanceOf(
      InvalidObjectPathError,
    );
  });

  it('getObjectEntityFile serves only /objects/ paths', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-storage-'));
    try {
      const svc = new ObjectStorageService(new LocalDiskStorage(root));
      const stored = await svc.uploadPrivateObject(storageKeys.upload('u1'), Buffer.from('x'), 'image/png');
      await expect(svc.getObjectEntityFile(stored)).rejects.toBeInstanceOf(ObjectNotFoundError);
      await expect(svc.getObjectEntityFile('/objects/uploads/u1')).resolves.toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function streamedContentType(storedType: string, fallbackContentType?: string) {
    const adapter = {
      provider: 'local' as const,
      exists: async () => true,
      getMetadata: async () => ({ contentType: storedType, size: 1 }),
      createReadStream: async () => Readable.from([Buffer.from('x')]),
    };
    const headers: Record<string, string> = {};
    const res = Object.assign(new PassThrough(), {
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
    });
    res.resume();
    await new ObjectStorageService(adapter as never).streamPrivateObject('/objects/uploads/u1', res as never, {
      fallbackContentType,
    });
    return headers['Content-Type'];
  }

  it('uses fallbackContentType only when storage has no specific type', async () => {
    expect(await streamedContentType('application/octet-stream', 'image/jpeg')).toBe('image/jpeg');
    expect(await streamedContentType('binary/octet-stream', 'image/jpeg')).toBe('image/jpeg');
    expect(await streamedContentType('', 'image/jpeg')).toBe('image/jpeg');
    expect(await streamedContentType('image/png', 'image/jpeg')).toBe('image/png');
    expect(await streamedContentType('application/octet-stream')).toBe('application/octet-stream');
  });
});

describe('S3CompatibleStorage (real SDK presigner, no network)', () => {
  it('presigns upload URLs without a body checksum', async () => {
    const adapter = createS3StorageAdapter({
      S3_BUCKET: 'qvo-objects',
      S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
    });
    const signed = await adapter.getSignedUploadUrl(storageKeys.upload('u1'), 60);
    const url = new URL(signed.url);
    const params = [...url.searchParams.keys()].map((name) => name.toLowerCase());

    expect(url.pathname).toBe('/qvo-objects/uploads/u1');
    expect(params).toContain('x-amz-signature');
    expect(params.filter((name) => name.startsWith('x-amz-checksum-'))).toEqual([]);
    expect(params).not.toContain('x-amz-sdk-checksum-algorithm');
  });

  it.each([
    { bucket: 'objects', prefix: 'prod', stored: '/objects/uploads/u1', objectKey: 'prod/uploads/u1' },
    { bucket: 'objects', prefix: undefined, stored: '/objects/uploads/u1', objectKey: 'uploads/u1' },
    { bucket: 'qvo-objects', prefix: 'prod', stored: '/qvo-objects/prod/uploads/u1', objectKey: 'prod/uploads/u1' },
    { bucket: 'qvo-objects', prefix: undefined, stored: '/qvo-objects/uploads/u1', objectKey: 'uploads/u1' },
  ])('signs $stored once under bucket=$bucket prefix=$prefix', async ({ bucket, prefix, stored, objectKey }) => {
    const adapter = createS3StorageAdapter({
      S3_BUCKET: bucket,
      S3_PREFIX: prefix,
      S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'http://localhost:9000',
    });
    for (const key of [storageKeys.upload('u1'), stored, '/objects/uploads/u1']) {
      const signed = await adapter.getSignedUploadUrl(key, 60);
      expect(new URL(signed.url).pathname).toBe(`/${bucket}/${objectKey}`);
      expect(signed.objectPath).toBe('/objects/uploads/u1');
      expect(adapter.normalizeObjectPath(signed.url)).toBe('/objects/uploads/u1');
    }
  });

  const urlStyleCases = [
    { bucket: 'uploads', prefix: undefined, objectKey: 'uploads/u1' },
    { bucket: 'objects', prefix: undefined, objectKey: 'uploads/u1' },
    { bucket: 'objects', prefix: 'prod', objectKey: 'prod/uploads/u1' },
    { bucket: 'objects', prefix: 'objects/prod', objectKey: 'objects/prod/uploads/u1' },
    { bucket: 'qvo-objects', prefix: undefined, objectKey: 'uploads/u1' },
  ];

  const urlStyles = urlStyleCases.flatMap((c) => [
    {
      ...c,
      style: 'virtual-hosted AWS',
      env: { S3_FORCE_PATH_STYLE: 'false' },
      host: `${c.bucket}.s3.us-east-1.amazonaws.com`,
      pathname: `/${c.objectKey}`,
    },
    {
      ...c,
      style: 'virtual-hosted custom endpoint',
      env: { S3_FORCE_PATH_STYLE: 'false', S3_ENDPOINT: 'https://storage.example.com' },
      host: `${c.bucket}.storage.example.com`,
      pathname: `/${c.objectKey}`,
    },
    {
      ...c,
      style: 'path-style',
      env: { S3_ENDPOINT: 'http://localhost:9000' },
      host: 'localhost:9000',
      pathname: `/${c.bucket}/${c.objectKey}`,
    },
    {
      ...c,
      style: 'path-style under an endpoint path',
      env: { S3_ENDPOINT: 'https://abc.supabase.co/storage/v1/s3' },
      host: 'abc.supabase.co',
      pathname: `/storage/v1/s3/${c.bucket}/${c.objectKey}`,
    },
    {
      ...c,
      // The SDK falls back to path-style for an IP endpoint even with the flag off.
      style: 'path-style from an IP endpoint with S3_FORCE_PATH_STYLE=false',
      env: { S3_FORCE_PATH_STYLE: 'false', S3_ENDPOINT: 'http://127.0.0.1:9000' },
      host: '127.0.0.1:9000',
      pathname: `/${c.bucket}/${c.objectKey}`,
    },
    {
      ...c,
      // A bucket-named host is only virtual-hosted when path style is off.
      style: 'path-style on a host that starts with the bucket name',
      env: { S3_ENDPOINT: `https://${c.bucket}.example.com` },
      host: `${c.bucket}.example.com`,
      pathname: `/${c.bucket}/${c.objectKey}`,
    },
  ]);

  // The SDK picks the URL style from the bucket name too, so these pin what it
  // actually emits with S3_FORCE_PATH_STYLE=false.
  const bucketNameStyles = [
    {
      bucket: 'qvo.objects',
      prefix: undefined,
      objectKey: 'uploads/u1',
      style: 'path-style for a dotted bucket over https on a custom endpoint',
      env: { S3_FORCE_PATH_STYLE: 'false', S3_ENDPOINT: 'https://qvo.objects.example.com' },
      host: 'qvo.objects.example.com',
      pathname: '/qvo.objects/uploads/u1',
    },
    {
      bucket: 'qvo.objects',
      prefix: 'prod',
      objectKey: 'prod/uploads/u1',
      style: 'path-style for a dotted bucket over https on a custom endpoint',
      env: { S3_FORCE_PATH_STYLE: 'false', S3_ENDPOINT: 'https://qvo.objects.example.com' },
      host: 'qvo.objects.example.com',
      pathname: '/qvo.objects/prod/uploads/u1',
    },
    {
      bucket: 'qvo.objects',
      prefix: undefined,
      objectKey: 'uploads/u1',
      style: 'path-style for a dotted bucket over https on an unrelated endpoint',
      env: { S3_FORCE_PATH_STYLE: 'false', S3_ENDPOINT: 'https://storage.example.com' },
      host: 'storage.example.com',
      pathname: '/qvo.objects/uploads/u1',
    },
    {
      bucket: 'qvo.objects',
      prefix: undefined,
      objectKey: 'uploads/u1',
      style: 'path-style for a dotted bucket on AWS',
      env: { S3_FORCE_PATH_STYLE: 'false' },
      host: 's3.us-east-1.amazonaws.com',
      pathname: '/qvo.objects/uploads/u1',
    },
    {
      bucket: 's3.us-east-1',
      prefix: undefined,
      objectKey: 'uploads/u1',
      style: 'path-style for a dotted bucket named like the AWS host',
      env: { S3_FORCE_PATH_STYLE: 'false' },
      host: 's3.us-east-1.amazonaws.com',
      pathname: '/s3.us-east-1/uploads/u1',
    },
    {
      bucket: 'ab',
      prefix: undefined,
      objectKey: 'uploads/u1',
      style: 'path-style for a too-short bucket on a host that starts with its name',
      env: { S3_FORCE_PATH_STYLE: 'false', S3_ENDPOINT: 'https://ab.example.com' },
      host: 'ab.example.com',
      pathname: '/ab/uploads/u1',
    },
    {
      bucket: 'qvo.objects',
      prefix: undefined,
      objectKey: 'uploads/u1',
      style: 'virtual-hosted for a dotted bucket over http',
      env: { S3_FORCE_PATH_STYLE: 'false', S3_ENDPOINT: 'http://storage.example.com' },
      host: 'qvo.objects.storage.example.com',
      pathname: '/uploads/u1',
    },
    {
      bucket: 'uploads',
      prefix: undefined,
      objectKey: 'uploads/u1',
      style: 'virtual-hosted on an endpoint that starts with the bucket name',
      env: { S3_FORCE_PATH_STYLE: 'false', S3_ENDPOINT: 'https://uploads.example.com' },
      host: 'uploads.uploads.example.com',
      pathname: '/uploads/u1',
    },
  ];

  it.each([...urlStyles, ...bucketNameStyles])(
    '$style: signed URL registers as an attachment under bucket=$bucket prefix=$prefix',
    async ({ bucket, prefix, objectKey, env, host, pathname }) => {
      const adapter = createS3StorageAdapter({
        S3_BUCKET: bucket,
        S3_PREFIX: prefix,
        S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        S3_SECRET_ACCESS_KEY: 'secret',
        ...env,
      });
      const signed = await adapter.getSignedUploadUrl(storageKeys.upload('u1'), 60);
      const url = new URL(signed.url);
      expect(url.host).toBe(host);
      expect(url.pathname).toBe(pathname);
      expect(signed.objectPath).toBe('/objects/uploads/u1');
      expect(adapter.normalizeObjectPath(signed.url)).toBe('/objects/uploads/u1');

      // No network: the presigner never calls send, only the existence check does.
      const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({}));
      try {
        const svc = new ObjectStorageService(adapter);
        const policy = { owner: 'tenant:t1', visibility: 'private' as const };
        await expect(svc.trySetObjectEntityAclPolicy(signed.url, policy)).resolves.toBe('/objects/uploads/u1');
        const commands = send.mock.calls.map(([command]) => command.input as { Bucket: string; Key: string });
        expect(commands.length).toBeGreaterThan(0);
        for (const input of commands) expect(input).toMatchObject({ Bucket: bucket, Key: objectKey });
      } finally {
        send.mockRestore();
      }
    },
  );
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

  function inMemoryS3() {
    const objects = new Map<string, Buffer>();
    const missing = () => Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    const send = vi.fn(async (command: { constructor: { name: string }; input: { Key: string; Body?: Buffer } }) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === 'PutObjectCommand') {
        objects.set(Key, Body as Buffer);
        return {};
      }
      const stored = objects.get(Key);
      if (!stored) throw missing();
      if (command.constructor.name === 'DeleteObjectCommand') objects.delete(Key);
      if (command.constructor.name === 'GetObjectCommand') {
        return { Body: Object.assign(Readable.from([stored]), { transformToByteArray: async () => stored }) };
      }
      return { ContentLength: stored.length };
    });
    return { objects, send };
  }

  it.each([
    { bucket: 'objects', prefix: 'prod', stored: '/objects/uploads/u1', objectKey: 'prod/uploads/u1' },
    { bucket: 'objects', prefix: 'tenants/prod', stored: '/objects/uploads/u1', objectKey: 'tenants/prod/uploads/u1' },
    // A prefix equal to a key namespace must not read as "already prefixed".
    { bucket: 'objects', prefix: 'uploads', stored: '/objects/uploads/u1', objectKey: 'uploads/uploads/u1' },
    { bucket: 'objects', prefix: undefined, stored: '/objects/uploads/u1', objectKey: 'uploads/u1' },
    { bucket: 'qvo-objects', prefix: 'prod', stored: '/qvo-objects/prod/uploads/u1', objectKey: 'prod/uploads/u1' },
    { bucket: 'qvo-objects', prefix: undefined, stored: '/qvo-objects/uploads/u1', objectKey: 'uploads/u1' },
  ])('round-trips a put path under bucket=$bucket prefix=$prefix', async ({ bucket, prefix, stored, objectKey }) => {
    const { objects, send } = inMemoryS3();
    const adapter = createS3StorageAdapter(
      { S3_BUCKET: bucket, S3_PREFIX: prefix, S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' },
      { send } as never,
    );

    expect(await adapter.put(storageKeys.upload('u1'), Buffer.from('ab'))).toBe(stored);
    expect([...objects.keys()]).toEqual([objectKey]);

    for (const key of [stored, '/objects/uploads/u1', storageKeys.upload('u1')]) {
      expect(await adapter.exists(key)).toBe(true);
      expect(await adapter.get(key)).toEqual(Buffer.from('ab'));
      expect((await adapter.getMetadata(key)).size).toBe(2);
      const chunks: Buffer[] = [];
      for await (const chunk of await adapter.createReadStream(key)) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(Buffer.from('ab'));
    }

    // Writing back to the stored path hits the same object.
    expect(await adapter.put(stored, Buffer.from('cd'))).toBe(stored);
    expect([...objects.keys()]).toEqual([objectKey]);

    expect(await adapter.delete(stored)).toBe(true);
    expect(objects.size).toBe(0);
    expect(await adapter.exists(stored)).toBe(false);
    expect(await adapter.delete(stored)).toBe(false);
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
