// Canonical relative keys must put/get/delete the same object on every
// provider. Voice-preview cache is one of those keys — it must not need a
// Replit-only option.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { storageKeys } from './keys';
import { LocalDiskStorage } from './local';
import { ReplitSidecarStorage } from './replit';
import { createS3StorageAdapter } from './s3';
import type { StorageAdapter } from './types';

const BODY = Buffer.from('preview-bytes');
const HASH = 'a'.repeat(64);

const CANONICAL_KEYS = [
  storageKeys.upload('u1'),
  storageKeys.recording('t1', 'CA1'),
  storageKeys.routeExport('t1', 'e1'),
  storageKeys.voicePreview(HASH),
  storageKeys.knowledgeDocument('t1', 'd1'),
] as const;

function inMemoryS3() {
  const objects = new Map<string, Buffer>();
  const missing = () =>
    Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
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
    return { ContentLength: stored.length, ContentType: 'application/octet-stream' };
  });
  return { objects, send };
}

function recordingReplitClient() {
  const objects = new Map<string, Buffer>();
  const client = {
    bucket: (bucketName: string) => ({
      file: (objectName: string) => {
        const id = `${bucketName}/${objectName}`;
        return {
          save: async (body: Buffer | string) => {
            objects.set(id, typeof body === 'string' ? Buffer.from(body) : body);
          },
          exists: async () => [objects.has(id)],
          download: async () => {
            const stored = objects.get(id);
            if (!stored) {
              throw Object.assign(new Error('missing'), { code: 404 });
            }
            return [stored];
          },
          getMetadata: async () => {
            const stored = objects.get(id);
            if (!stored) {
              throw Object.assign(new Error('missing'), { code: 404 });
            }
            return [{ contentType: 'application/octet-stream', size: stored.length }];
          },
          createReadStream: () => {
            const stored = objects.get(id);
            if (!stored) {
              throw Object.assign(new Error('missing'), { code: 404 });
            }
            return Readable.from([stored]);
          },
          delete: async () => {
            if (!objects.has(id)) {
              throw Object.assign(new Error('missing'), { code: 404 });
            }
            objects.delete(id);
          },
        };
      },
    }),
  };
  return { objects, client };
}

async function roundTrip(adapter: StorageAdapter, key: string) {
  const stored = await adapter.put(key, BODY, { contentType: 'audio/mpeg' });
  expect(await adapter.exists(key)).toBe(true);
  expect(await adapter.get(key)).toEqual(BODY);
  expect(await adapter.exists(stored)).toBe(true);
  expect(await adapter.get(stored)).toEqual(BODY);
  expect((await adapter.getMetadata(key)).size).toBe(BODY.length);
  const chunks: Buffer[] = [];
  for await (const chunk of await adapter.createReadStream(key)) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(BODY);
  expect(await adapter.delete(key)).toBe(true);
  expect(await adapter.exists(key)).toBe(false);
  expect(await adapter.delete(key)).toBe(false);
  return stored;
}

describe('provider parity for canonical relative keys', () => {
  it.each(CANONICAL_KEYS.map((key) => ({ key })))('local round-trips $key', async ({ key }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-parity-'));
    try {
      const adapter = new LocalDiskStorage(root);
      await roundTrip(adapter, key);
      expect(() => readFileSync(path.join(root, key))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(CANONICAL_KEYS.map((key) => ({ key })))('s3 round-trips $key (with and without prefix)', async ({ key }) => {
    for (const prefix of [undefined, 'prod']) {
      const { objects, send } = inMemoryS3();
      const adapter = createS3StorageAdapter(
        {
          S3_BUCKET: 'qvo-objects',
          S3_ACCESS_KEY_ID: 'id',
          S3_SECRET_ACCESS_KEY: 'secret',
          S3_PREFIX: prefix,
        },
        { send } as never,
      );
      await roundTrip(adapter, key);
      expect(objects.size).toBe(0);
    }
  });

  it.each(
    ['/bucket/private', '/bucket/private/', '/qvo-bucket/private'].flatMap((dir) =>
      CANONICAL_KEYS.map((key) => ({ dir, key })),
    ),
  )('replit round-trips $key under PRIVATE_OBJECT_DIR=$dir', async ({ dir, key }) => {
    const { client } = recordingReplitClient();
    const adapter = new ReplitSidecarStorage({ PRIVATE_OBJECT_DIR: dir }, client as never);
    await roundTrip(adapter, key);
  });

  it('voice-preview put/get hit the same object on every provider, including a trailing-slash Replit dir', async () => {
    const key = storageKeys.voicePreview(HASH);
    const root = mkdtempSync(path.join(os.tmpdir(), 'qvo-parity-vp-'));
    try {
      const local = new LocalDiskStorage(root);
      const { send } = inMemoryS3();
      const s3 = createS3StorageAdapter(
        { S3_BUCKET: 'qvo-objects', S3_ACCESS_KEY_ID: 'id', S3_SECRET_ACCESS_KEY: 'secret' },
        { send } as never,
      );
      const { objects, client } = recordingReplitClient();
      const replit = new ReplitSidecarStorage({ PRIVATE_OBJECT_DIR: '/bucket/private/' }, client as never);

      for (const adapter of [local, s3, replit]) {
        await adapter.put(key, BODY);
        expect(await adapter.get(key)).toEqual(BODY);
      }

      expect([...objects.keys()]).toEqual(['bucket/private/voice-previews/' + HASH + '.mp3']);
      expect(readFileSync(path.join(root, key))).toEqual(BODY);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
