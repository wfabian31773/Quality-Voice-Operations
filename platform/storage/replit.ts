import { Storage } from '@google-cloud/storage';
import type { Readable } from 'node:stream';
import {
  getObjectAclPolicy,
  setObjectAclPolicy,
  type ObjectAclPolicy,
} from '../../server/replit_integrations/object_storage/objectAcl';
import { InvalidObjectPathError, ObjectNotFoundError, StorageNotConfiguredError } from './errors';
import { isCanonicalUploadObjectPath } from './paths';
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

// The path logic below is ported verbatim from main's objectStorage.ts and
// voicePreview.ts so every key resolves to the object main resolved it to. Don't
// tidy it up: objects already live under these exact keys, doubled slashes included.

export function readReplitPrivateDir(env: Record<string, string | undefined> = process.env): string {
  const dir = env.PRIVATE_OBJECT_DIR || '';
  if (!dir) {
    throw new StorageNotConfiguredError(
      "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' tool and set PRIVATE_OBJECT_DIR env var.",
    );
  }
  return dir;
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

/** Voice-preview cache keys, the only relative keys read back through the adapter. */
const VOICE_PREVIEW_KEY = /^voice-previews\/[^/]+$/;

/** main's voicePreview getObjectLocation, which trimmed the private dir itself. */
function voicePreviewFullPath(dir: string, key: string): string {
  const trimmed = dir.replace(/\/+$/, '');
  return `${trimmed}/${key}`;
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

  /** main's getPrivateObjectDir. */
  private getPrivateObjectDir(): string {
    return readReplitPrivateDir(this.env);
  }

  /**
   * The `/<bucket>/<object>` path main's getObjectEntityFile resolved an
   * `/objects/<id>` path to. Read operations take absolute paths, so callers
   * holding an entity path translate it here first: under a bucket named
   * `objects` the same string means something else as an absolute path.
   */
  getObjectEntityPath(objectPath: string): string {
    if (!objectPath.startsWith('/objects/')) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split('/');
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join('/');
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith('/')) {
      entityDir = `${entityDir}/`;
    }
    return `${entityDir}${entityId}`;
  }

  /** main's uploadPrivateObject join, or its voice-preview one for those keys. */
  private uploadFullPath(relativeKey: string): string {
    const dir = this.getPrivateObjectDir();
    if (VOICE_PREVIEW_KEY.test(relativeKey)) return voicePreviewFullPath(dir, relativeKey);
    const cleanKey = relativeKey.replace(/^\/+/, '');
    return dir.endsWith('/') ? `${dir}${cleanKey}` : `${dir}/${cleanKey}`;
  }

  /** Reads take what main's streamPrivateObject / deletePrivateObject took. */
  private locate(key: string): { bucketName: string; objectName: string } {
    if (VOICE_PREVIEW_KEY.test(key)) {
      return parseObjectPath(voicePreviewFullPath(this.getPrivateObjectDir(), key));
    }
    return parseObjectPath(key);
  }

  /** GCS handle for the ACL helpers. */
  gcsFile(key: string) {
    const { bucketName, objectName } = this.locate(key);
    return this.client.bucket(bucketName).file(objectName);
  }

  /**
   * Upload paths a client may attach. Besides the canonical shape, a dir ending
   * in `/` signs `<dir>//uploads/<id>`, which main normalized to
   * `/objects//uploads/<id>`.
   */
  isUploadEntityPath(path: string): boolean {
    if (isCanonicalUploadObjectPath(path)) return true;
    return (
      path.startsWith('/objects//') &&
      isCanonicalUploadObjectPath(`/objects/${path.slice('/objects//'.length)}`) &&
      this.getPrivateObjectDir().endsWith('/')
    );
  }

  async put(key: string, body: Buffer | string, options?: PutObjectOptions): Promise<string> {
    const fullPath = this.uploadFullPath(key);
    const { bucketName, objectName } = parseObjectPath(fullPath);
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
    // main's getObjectEntityUploadURL always joined with `/`, even onto a dir
    // already ending in one.
    const fullPath = `${this.getPrivateObjectDir()}/${key}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const url = await signObjectURL({
      bucketName,
      objectName,
      method: 'PUT',
      ttlSec,
    });
    return {
      url,
      objectPath: this.normalizeObjectPath(url),
    };
  }

  normalizeObjectPath(rawPath: string): string {
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

  async trySetAclPolicy(rawPath: string, aclPolicy: ObjectAclPolicy): Promise<string> {
    const normalizedPath = this.normalizeObjectPath(rawPath);
    if (!this.isUploadEntityPath(normalizedPath)) throw new InvalidObjectPathError();
    const file = this.gcsFile(this.getObjectEntityPath(normalizedPath));
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
