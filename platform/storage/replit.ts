import { Storage } from '@google-cloud/storage';
import type { Readable } from 'node:stream';
import {
  getObjectAclPolicy,
  setObjectAclPolicy,
  type ObjectAclPolicy,
} from '../../server/replit_integrations/object_storage/objectAcl';
import { InvalidObjectPathError, ObjectNotFoundError, StorageNotConfiguredError } from './errors';
import {
  isCanonicalUploadObjectPath,
  isEntityObjectPath,
  parseAbsoluteObjectPath,
  stripLeadingSlashes,
} from './paths';
import type {
  PutObjectOptions,
  SignedUploadUrl,
  StorageAdapter,
  StoredObjectMetadata,
} from './types';

const REPLIT_SIDECAR_ENDPOINT = 'http://127.0.0.1:1106';

export const objectStorageClient = new Storage({
  credentials: {
    audience: 'replit',
    subject_token_type: 'access_token',
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: 'external_account',
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: 'json',
        subject_token_field_name: 'access_token',
      },
    },
    universe_domain: 'googleapis.com',
  },
  projectId: '',
});

export function readReplitPrivateDir(env: Record<string, string | undefined> = process.env): string {
  const dir = env.PRIVATE_OBJECT_DIR?.trim() ?? '';
  if (!dir) {
    throw new StorageNotConfiguredError(
      "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' tool and set PRIVATE_OBJECT_DIR env var.",
    );
  }
  return dir;
}

function toFullPath(privateDir: string, relativeKey: string): string {
  const cleanKey = stripLeadingSlashes(relativeKey);
  if (!cleanKey) throw new Error('Invalid object key');
  return privateDir.endsWith('/') ? `${privateDir}${cleanKey}` : `${privateDir}/${cleanKey}`;
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, make sure you're running on Replit`,
    );
  }
  const { signed_url: signedURL } = await response.json();
  return signedURL as string;
}

export class ReplitSidecarStorage implements StorageAdapter {
  readonly provider = 'replit' as const;

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly client: Storage = objectStorageClient,
  ) {}

  /** `/<bucket>/<dir>`, whatever slashes PRIVATE_OBJECT_DIR was written with. */
  private privateDir(): string {
    return `/${stripLeadingSlashes(readReplitPrivateDir(this.env)).replace(/\/+$/, '')}`;
  }

  private locate(key: string): { bucketName: string; objectName: string; fullPath: string } {
    if (isEntityObjectPath(key)) {
      return this.locateAbsolute(toFullPath(this.privateDir(), key.slice('/objects/'.length)));
    }
    if (key.startsWith('/')) {
      return this.locateAbsolute(key);
    }
    const dir = this.privateDir();
    // Already under the private dir, just missing its leading slash.
    if (`/${key}`.startsWith(`${dir}/`)) {
      return this.locateAbsolute(`/${key}`);
    }
    return this.locateAbsolute(toFullPath(dir, key));
  }

  private locateAbsolute(fullPath: string): {
    bucketName: string;
    objectName: string;
    fullPath: string;
  } {
    const parsed = parseAbsoluteObjectPath(fullPath);
    if (!parsed.objectName) throw new Error('Invalid object key');
    return { ...parsed, fullPath };
  }

  async put(key: string, body: Buffer | string, options?: PutObjectOptions): Promise<string> {
    const { bucketName, objectName, fullPath } = this.locate(key);
    const file = this.client.bucket(bucketName).file(objectName);
    await file.save(body, {
      contentType: options?.contentType,
      resumable: false,
      metadata: options?.cacheControl ? { cacheControl: options.cacheControl } : undefined,
    });
    return fullPath;
  }

  async get(key: string): Promise<Buffer> {
    const { bucketName, objectName } = this.locate(key);
    const file = this.client.bucket(bucketName).file(objectName);
    try {
      const [buf] = await file.download();
      return buf;
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === 404) throw new ObjectNotFoundError();
      throw err;
    }
  }

  async getMetadata(key: string): Promise<StoredObjectMetadata> {
    const { bucketName, objectName } = this.locate(key);
    const file = this.client.bucket(bucketName).file(objectName);
    try {
      const [metadata] = await file.getMetadata();
      const sizeRaw = metadata.size;
      const size =
        typeof sizeRaw === 'number' ? sizeRaw : sizeRaw != null ? Number(sizeRaw) : undefined;
      return {
        contentType: metadata.contentType || 'application/octet-stream',
        size: Number.isFinite(size) ? size : undefined,
      };
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === 404) throw new ObjectNotFoundError();
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    const { bucketName, objectName } = this.locate(key);
    const file = this.client.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    return exists;
  }

  async delete(key: string): Promise<boolean> {
    const { bucketName, objectName } = this.locate(key);
    const file = this.client.bucket(bucketName).file(objectName);
    try {
      await file.delete();
      return true;
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === 404) return false;
      throw err;
    }
  }

  async createReadStream(key: string): Promise<Readable> {
    const { bucketName, objectName } = this.locate(key);
    const file = this.client.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();
    return file.createReadStream();
  }

  async getSignedUploadUrl(key: string, ttlSec: number): Promise<SignedUploadUrl> {
    const { bucketName, objectName } = this.locate(key);
    const url = await signObjectURL({
      bucketName,
      objectName,
      method: 'PUT',
      ttlSec,
    });
    return {
      url,
      objectPath: this.normalizeObjectPath(url) || `/objects/${stripLeadingSlashes(key)}`,
    };
  }

  normalizeObjectPath(rawPath: string): string {
    if (!rawPath.startsWith('https://storage.googleapis.com/')) {
      return rawPath;
    }
    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;
    const objectEntityDir = `${this.privateDir()}/`;
    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }
    return `/objects/${rawObjectPath.slice(objectEntityDir.length)}`;
  }

  async trySetAclPolicy(rawPath: string, aclPolicy: ObjectAclPolicy): Promise<string> {
    const normalizedPath = this.normalizeObjectPath(rawPath);
    if (!isCanonicalUploadObjectPath(normalizedPath)) throw new InvalidObjectPathError();
    const { bucketName, objectName } = this.locate(normalizedPath);
    const file = this.client.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();
    await setObjectAclPolicy(file, aclPolicy);
    return normalizedPath;
  }

  async readAclVisibility(key: string): Promise<'public' | 'private'> {
    const { bucketName, objectName } = this.locate(key);
    const file = this.client.bucket(bucketName).file(objectName);
    const aclPolicy = await getObjectAclPolicy(file);
    return aclPolicy?.visibility === 'public' ? 'public' : 'private';
  }
}

export function createReplitStorageAdapter(
  env: Record<string, string | undefined> = process.env,
): ReplitSidecarStorage {
  return new ReplitSidecarStorage(env);
}
