// Proves the Replit adapter resolves every absolute path to the object main
// resolved it to. The oracle below is a verbatim copy of the path logic at
// origin/main commit 1ba8c2bd513f160960e79be903438c63adb40d1c
// (server/replit_integrations/object_storage/objectStorage.ts). Only the
// storage client, the uuid and the response are stand-ins. Don't update it to
// match the adapter. Relative keys are the one deliberate break: they
// round-trip through put()'s join so S3, local, and Replit share one layout.
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidObjectPathError } from './errors';
import { ReplitSidecarStorage } from './replit';
import { storageKeys } from './keys';
import { ObjectStorageService } from '../../server/replit_integrations/object_storage/objectStorage';

type Location = [bucket: string, object: string];

function recordingClient() {
  const calls: Location[] = [];
  const client = {
    bucket: (bucketName: string) => ({
      file: (objectName: string) => {
        calls.push([bucketName, objectName]);
        return {
          save: async () => {},
          exists: async () => [true],
          download: async () => [Buffer.from('ok')],
          getMetadata: async () => [{ contentType: 'application/zip', size: 2 }],
          setMetadata: async () => {},
          createReadStream: () => Readable.from([Buffer.from('ok')]),
          delete: async () => {},
        };
      },
    }),
  };
  return { calls, client };
}

const FIXED_UUID = '11111111-1111-1111-1111-111111111111';
const randomUUID = () => FIXED_UUID;
const REPLIT_SIDECAR_ENDPOINT = 'http://127.0.0.1:1106';

class MainObjectNotFoundError extends Error {
  constructor() {
    super('Object not found');
  }
}

// ---- verbatim from origin/main (see header) ----
class MainObjectStorageService {
  constructor(private readonly objectStorageClient: ReturnType<typeof recordingClient>['client']) {}

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || '';
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var.",
      );
    }
    return dir;
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var.",
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    // Sign URL for PUT method with TTL
    return signObjectURL({
      bucketName,
      objectName,
      method: 'PUT',
      ttlSec: 900,
    });
  }

  async getObjectEntityFile(objectPath: string) {
    if (!objectPath.startsWith('/objects/')) {
      throw new MainObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split('/');
    if (parts.length < 2) {
      throw new MainObjectNotFoundError();
    }

    const entityId = parts.slice(1).join('/');
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith('/')) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = this.objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new MainObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith('https://storage.googleapis.com/')) {
      return rawPath;
    }

    // Extract the path from the URL by removing query parameters and domain
    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith('/')) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    // Extract the entity ID from the path
    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  async uploadPrivateObject(relativeKey: string, body: Buffer | string, contentType: string): Promise<string> {
    const dir = this.getPrivateObjectDir();
    const cleanKey = relativeKey.replace(/^\/+/, '');
    const fullPath = dir.endsWith('/') ? `${dir}${cleanKey}` : `${dir}/${cleanKey}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const file = this.objectStorageClient.bucket(bucketName).file(objectName);
    await file.save(body, { contentType, resumable: false });
    return fullPath;
  }

  async deletePrivateObject(fullObjectPath: string): Promise<boolean> {
    const { bucketName, objectName } = parseObjectPath(fullObjectPath);
    const bucket = this.objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    try {
      await file.delete();
      return true;
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === 404) return false;
      throw err;
    }
  }

  // Path handling only: main went on to set headers and pipe the file.
  async streamPrivateObject(fullObjectPath: string): Promise<void> {
    const { bucketName, objectName } = parseObjectPath(fullObjectPath);
    const bucket = this.objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      throw new MainObjectNotFoundError();
    }
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  const pathParts = path.split('/');
  if (pathParts.length < 3) {
    throw new Error('Invalid path: must contain at least a bucket name');
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join('/');

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(`${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` + `make sure you're running on Replit`,
    );
  }

  const { signed_url: signedURL } = await response.json();
  return signedURL;
}

// ---- end verbatim ----

const DIRS: Array<string | undefined> = [
  '/objects/private',
  '/objects/private/',
  '/objects//',
  '/uploads',
  '/qvo-bucket/private',
  '/bucket/private//',
  undefined,
];

const ID = 'abc-123.png';
const EXPORT_KEY = storageKeys.routeExport('t1', 'e1');

const PATHS = [
  // Entity paths.
  `/objects/${ID}`,
  `/objects/uploads/${ID}`,
  `/objects//uploads/${ID}`,
  `/objects///uploads/${ID}`,
  `/objects/${EXPORT_KEY}`,
  '/objects/private/a',
  `/objects/private/${EXPORT_KEY}`,
  `/objects/private//uploads/${ID}`,
  '/objects/private-sibling/a',
  '/objects/',
  '/objects//',
  '/objects',
  // Absolute paths, including what put() returned for each dir.
  '/qvo-bucket/obj',
  `/qvo-bucket/private/${EXPORT_KEY}`,
  `/qvo-bucket/private/uploads/${ID}`,
  `/qvo-bucket/private//uploads/${ID}`,
  `/uploads/${EXPORT_KEY}`,
  `/uploads/uploads/${ID}`,
  `/objects//${EXPORT_KEY}`,
  '/qvo-bucket/',
  '/qvo-bucket',
  '//qvo-bucket/obj',
  '/',
  '',
  // Relative keys.
  `uploads/${ID}`,
  EXPORT_KEY,
  `/${EXPORT_KEY}`,
  `//uploads/${ID}`,
  `qvo-bucket/private/${EXPORT_KEY}`,
  storageKeys.recording('t1', 'CA1'),
  storageKeys.knowledgeDocument('t1', 'd1'),
  'bare',
  // Voice-preview relative keys round-trip through put()'s join.
  storageKeys.voicePreview('hash1'),
  `/${storageKeys.voicePreview('hash1')}`,
  `/objects/${storageKeys.voicePreview('hash1')}`,
  `/bucket/private/${storageKeys.voicePreview('hash1')}`,
  `/bucket/private//${storageKeys.voicePreview('hash1')}`,
  // Signed-URL forms reaching a read by mistake.
  `https://storage.googleapis.com/qvo-bucket/private/uploads/${ID}?X-Goog-Signature=x`,
];

const URLS = [
  `https://storage.googleapis.com/qvo-bucket/private/uploads/${ID}?X-Goog-Signature=x`,
  `https://storage.googleapis.com/qvo-bucket/private//uploads/${ID}?X-Goog-Signature=x`,
  `https://storage.googleapis.com/qvo-bucket/private-sibling/uploads/${ID}`,
  `https://storage.googleapis.com/objects/private/uploads/${ID}?X-Goog-Signature=x`,
  `https://storage.googleapis.com/objects/private//uploads/${ID}?X-Goog-Signature=x`,
  `https://storage.googleapis.com/objects///uploads/${ID}`,
  `https://storage.googleapis.com/objects//uploads/${ID}`,
  `https://storage.googleapis.com/uploads/uploads/${ID}`,
  `https://storage.googleapis.com/other/obj%20with%20space`,
  'https://storage.googleapis.com/',
  'https://storage.googleapis.com',
  `https://signed.example/qvo-bucket/private/uploads/${ID}`,
  `http://storage.googleapis.com/qvo-bucket/private/uploads/${ID}`,
  `/objects/uploads/${ID}`,
  `/qvo-bucket/private/uploads/${ID}`,
  `uploads/${ID}`,
  '',
];

/** Every bucket/object an operation touched, what it returned, what it threw. */
async function outcome<T>(calls: Location[], run: () => Promise<T>) {
  calls.length = 0;
  try {
    const value = await run();
    return { touched: [...new Set(calls.map((c) => JSON.stringify(c)))], value };
  } catch (err) {
    return { touched: [...new Set(calls.map((c) => JSON.stringify(c)))], error: (err as Error).message };
  }
}

function sink() {
  const res = Object.assign(new PassThrough(), { setHeader: () => {} });
  res.resume();
  return res as never;
}

const savedDir = process.env.PRIVATE_OBJECT_DIR;
let signRequests: Array<Record<string, unknown>>;

beforeEach(() => {
  signRequests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const { bucket_name, object_name, method } = JSON.parse(String(init.body));
      signRequests.push({ bucket_name, object_name, method });
      return new Response(
        JSON.stringify({
          signed_url: `https://storage.googleapis.com/${bucket_name}/${object_name}?X-Goog-Signature=x`,
        }),
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedDir === undefined) delete process.env.PRIVATE_OBJECT_DIR;
  else process.env.PRIVATE_OBJECT_DIR = savedDir;
});

describe.each(DIRS.map((dir) => ({ dir: dir ?? '(unset)', raw: dir })))(
  'Replit adapter parity with PRIVATE_OBJECT_DIR=$dir',
  ({ raw }) => {
    function setup() {
      if (raw === undefined) delete process.env.PRIVATE_OBJECT_DIR;
      else process.env.PRIVATE_OBJECT_DIR = raw;
      const oracleSide = recordingClient();
      const adapterSide = recordingClient();
      const adapter = new ReplitSidecarStorage(process.env, adapterSide.client as never);
      return {
        main: new MainObjectStorageService(oracleSide.client),
        oracleCalls: oracleSide.calls,
        adapter,
        svc: new ObjectStorageService(adapter),
        adapterCalls: adapterSide.calls,
      };
    }

    it.each(PATHS.map((path) => ({ path })))('put $path', async ({ path }) => {
      const { main, oracleCalls, svc, adapter, adapterCalls } = setup();
      const expected = await outcome(oracleCalls, () => main.uploadPrivateObject(path, 'x', 'text/plain'));
      expect(await outcome(adapterCalls, () => svc.uploadPrivateObject(path, 'x', 'text/plain'))).toEqual(expected);
      expect(await outcome(adapterCalls, () => adapter.put(path, 'x'))).toEqual(expected);
    });

    it.each(PATHS.map((path) => ({ path })))('reads and deletes $path as main did', async ({ path }) => {
      const { main, oracleCalls, svc, adapter, adapterCalls } = setup();
      const relative = path.length > 0 && !path.startsWith('/') && !/^https?:\/\//i.test(path);
      // Relative keys round-trip through put()'s join (provider parity). Absolute
      // paths still match main's stream/delete parse.
      const streamed = relative
        ? await outcome(adapterCalls, () => adapter.put(path, 'x'))
        : await outcome(oracleCalls, () => main.streamPrivateObject(path));
      const located = { touched: streamed.touched, error: streamed.error };
      const reads: Array<() => Promise<unknown>> = relative
        ? [
            () => adapter.get(path),
            () => adapter.exists(path),
            () => adapter.getMetadata(path),
            async () => (await adapter.createReadStream(path)).destroy(),
          ]
        : [
            () => adapter.get(path),
            () => adapter.exists(path),
            () => adapter.getMetadata(path),
            async () => (await adapter.createReadStream(path)).destroy(),
            () => svc.streamPrivateObject(path, sink()),
          ];
      for (const read of reads) {
        const actual = await outcome(adapterCalls, read);
        expect({ touched: actual.touched, error: actual.error }).toEqual(located);
      }

      if (relative) {
        const deleted = await outcome(adapterCalls, () => adapter.delete(path));
        expect({ touched: deleted.touched, error: deleted.error }).toEqual(located);
        return;
      }

      const deleted = await outcome(oracleCalls, () => main.deletePrivateObject(path));
      expect(await outcome(adapterCalls, () => svc.deletePrivateObject(path))).toEqual(deleted);
      expect(await outcome(adapterCalls, () => adapter.delete(path))).toEqual(deleted);
    });

    it.each(PATHS.map((path) => ({ path })))('resolves entity lookups of $path as main did', async ({ path }) => {
      const { main, oracleCalls, svc, adapter, adapterCalls } = setup();
      const expected = await outcome(oracleCalls, async () => {
        await main.getObjectEntityFile(path);
      });
      const located = { touched: expected.touched, error: expected.error };

      const viaHandle = await outcome(adapterCalls, async () => {
        const handle = await svc.getObjectEntityFile(path);
        await handle.exists();
        await handle.getMetadata();
        await handle.download();
        (await handle.createReadStream() as Readable).destroy();
      });
      expect({ touched: viaHandle.touched, error: viaHandle.error }).toEqual(located);

      const relative = path.length > 0 && !path.startsWith('/') && !/^https?:\/\//i.test(path);
      if (relative) {
        const written = await outcome(adapterCalls, () => adapter.put(path, 'x'));
        const viaStream = await outcome(adapterCalls, () => svc.streamStoredObject(path, sink()));
        expect({ touched: viaStream.touched, error: viaStream.error }).toEqual({
          touched: written.touched,
          error: written.error,
        });
        return;
      }

      // Attachments and completion photos: main's branch on the /objects/ prefix.
      const stored = path.startsWith('/objects/')
        ? expected
        : await outcome(oracleCalls, () => main.streamPrivateObject(path));
      const viaStream = await outcome(adapterCalls, () => svc.streamStoredObject(path, sink()));
      expect({ touched: viaStream.touched, error: viaStream.error }).toEqual({
        touched: stored.touched,
        error: stored.error,
      });
    });

    it('signs uploads and normalizes the result as main did', async () => {
      const { main, adapter } = setup();
      const url = await outcome([], () => main.getObjectEntityUploadURL());
      const mainRequests = signRequests;
      signRequests = [];
      const signed = await outcome([], () => adapter.getSignedUploadUrl(storageKeys.upload(FIXED_UUID), 900));
      expect(signRequests).toEqual(mainRequests);
      if (raw === undefined) {
        expect(signed.error).toBe(url.error);
        return;
      }
      expect(signed.value).toEqual({
        url: url.value,
        objectPath: main.normalizeObjectEntityPath(url.value as string),
      });
      // main's own upload route then read the normalized path back.
      expect(adapter.getObjectEntityPath(signed.value?.objectPath as string)).toBeTruthy();
    });

    it.each(URLS.map((url) => ({ url })))('normalizes $url', async ({ url }) => {
      const { main, adapter, svc } = setup();
      const expected = await outcome([], async () => main.normalizeObjectEntityPath(url));
      expect(await outcome([], async () => adapter.normalizeObjectPath(url))).toEqual(expected);
      expect(await outcome([], async () => svc.normalizeObjectEntityPath(url))).toEqual(expected);
    });

    it.each(['hash1', 'a'.repeat(64)])('round-trips voice-preview key %s through put() join', async (hash) => {
      const { adapter, adapterCalls } = setup();
      const key = storageKeys.voicePreview(hash);
      const written = await outcome(adapterCalls, () => adapter.put(key, 'x'));
      const located = { touched: written.touched, error: written.error };
      const operations: Array<() => Promise<unknown>> = [
        () => adapter.exists(key),
        () => adapter.get(key),
        () => adapter.getMetadata(key),
        async () => (await adapter.createReadStream(key)).destroy(),
        () => adapter.delete(key),
      ];
      for (const operation of operations) {
        const actual = await outcome(adapterCalls, operation);
        expect({ touched: actual.touched, error: actual.error }).toEqual(located);
      }
    });
  },
);

// Literal values, so a bad edit to the oracle can't move both sides together.
describe('pinned keys', () => {
  function adapterFor(dir: string) {
    process.env.PRIVATE_OBJECT_DIR = dir;
    const { calls, client } = recordingClient();
    return { calls, adapter: new ReplitSidecarStorage(process.env, client as never) };
  }

  it.each([
    { dir: '/objects/private', stored: `/objects/private/${EXPORT_KEY}`, bucket: 'objects', object: `private/${EXPORT_KEY}` },
    { dir: '/objects/private/', stored: `/objects/private/${EXPORT_KEY}`, bucket: 'objects', object: `private/${EXPORT_KEY}` },
    { dir: '/objects//', stored: `/objects//${EXPORT_KEY}`, bucket: 'objects', object: `/${EXPORT_KEY}` },
    { dir: '/uploads', stored: `/uploads/${EXPORT_KEY}`, bucket: 'uploads', object: EXPORT_KEY },
    { dir: '/qvo-bucket/private', stored: `/qvo-bucket/private/${EXPORT_KEY}`, bucket: 'qvo-bucket', object: `private/${EXPORT_KEY}` },
  ])('put under $dir reads back from the same object', async ({ dir, stored, bucket, object }) => {
    const { adapter, calls } = adapterFor(dir);
    expect(await adapter.put(EXPORT_KEY, 'x')).toBe(stored);
    await adapter.get(stored);
    expect(await adapter.delete(stored)).toBe(true);
    expect(calls).toEqual([[bucket, object], [bucket, object], [bucket, object]]);
  });

  it.each([
    { dir: '/objects/private', path: '/objects/uploads/u1', full: '/objects/private/uploads/u1' },
    { dir: '/objects/private/', path: '/objects//uploads/u1', full: '/objects/private//uploads/u1' },
    { dir: '/objects/private/', path: '/objects/uploads/u1', full: '/objects/private/uploads/u1' },
    { dir: '/objects//', path: '/objects//uploads/u1', full: '/objects///uploads/u1' },
    { dir: '/qvo-bucket/private', path: '/objects//uploads/u1', full: '/qvo-bucket/private//uploads/u1' },
  ])('$path under $dir is the entity at $full', ({ dir, path, full }) => {
    expect(adapterFor(dir).adapter.getObjectEntityPath(path)).toBe(full);
  });

  describe('voice-preview keys under /bucket/private//', () => {
    const key = 'voice-previews/hash.mp3';

    it('put/get/delete the same object without a Replit-only option', async () => {
      const { adapter, calls } = adapterFor('/bucket/private//');
      expect(await adapter.put(key, 'x')).toBe('/bucket/private//voice-previews/hash.mp3');
      await adapter.get(key);
      expect(await adapter.delete(key)).toBe(true);
      expect(calls).toEqual(Array(3).fill(['bucket', 'private//voice-previews/hash.mp3']));
    });
  });
});

// main never validated the attach path; this PR does. A dir ending in `/` still
// signs and saves `/objects//uploads/<id>`, so that exact shape stays attachable.
describe('attaching a freshly signed upload', () => {
  const policy = { owner: 'tenant:t1', visibility: 'private' as const };

  it.each(['/objects/private', '/objects/private/', '/objects//', '/uploads', '/qvo-bucket/private'])(
    'keeps working under %s',
    async (dir) => {
      process.env.PRIVATE_OBJECT_DIR = dir;
      const { client } = recordingClient();
      const svc = new ObjectStorageService(new ReplitSidecarStorage(process.env, client as never));
      const url = await svc.getObjectEntityUploadURL();
      const saved = svc.normalizeObjectEntityPath(url);
      await expect(svc.trySetObjectEntityAclPolicy(url, policy)).resolves.toBe(saved);
      await expect(svc.getObjectEntityFile(saved)).resolves.toBeTruthy();
    },
  );

  it.each([
    ['/qvo-bucket/private', '/objects//uploads/u1'],
    ['/qvo-bucket/private/', '/objects///uploads/u1'],
    ['/qvo-bucket/private/', '/objects//recordings/t1/CA1'],
    ['/qvo-bucket/private/', '/qvo-bucket/private/uploads/u1'],
  ])('under %s still refuses %s', async (dir, path) => {
    process.env.PRIVATE_OBJECT_DIR = dir;
    const { client } = recordingClient();
    const svc = new ObjectStorageService(new ReplitSidecarStorage(process.env, client as never));
    await expect(svc.trySetObjectEntityAclPolicy(path, policy)).rejects.toBeInstanceOf(InvalidObjectPathError);
  });
});
