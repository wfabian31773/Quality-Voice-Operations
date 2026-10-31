import type { Response } from 'express';
import { randomUUID } from 'crypto';
import type { File } from '@google-cloud/storage';
import type { Readable } from 'node:stream';
import {
  ObjectNotFoundError,
  getStorageAdapter,
  isObjectStorageConfigured,
  objectStorageClient,
  readReplitPrivateDir,
  storageKeys,
  type StorageAdapter,
  type StreamObjectOptions,
} from '../../../platform/storage';
import { ReplitSidecarStorage } from '../../../platform/storage/replit';
import {
  canAccessObject,
  getObjectAclPolicy,
  ObjectPermission,
  type ObjectAclPolicy,
} from './objectAcl';

export { ObjectNotFoundError, objectStorageClient };

export interface StorageObjectHandle {
  exists(): Promise<[boolean]>;
  getMetadata(): Promise<[{ contentType?: string; size?: string | number }]>;
  createReadStream(): Readable | Promise<Readable>;
  download(): Promise<[Buffer]>;
  /** Present only for the Replit sidecar so existing ACL helpers keep working. */
  gcsFile?: File;
}

class AdapterObjectHandle implements StorageObjectHandle {
  gcsFile?: File;

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly key: string,
  ) {}

  async exists(): Promise<[boolean]> {
    return [await this.adapter.exists(this.key)];
  }

  async getMetadata(): Promise<[{ contentType?: string; size?: string | number }]> {
    const meta = await this.adapter.getMetadata(this.key);
    return [{ contentType: meta.contentType, size: meta.size }];
  }

  createReadStream(): Promise<Readable> {
    return this.adapter.createReadStream(this.key);
  }

  async download(): Promise<[Buffer]> {
    return [await this.adapter.get(this.key)];
  }
}

/**
 * Facade over {@link StorageAdapter}. Call sites keep the historical
 * ObjectStorageService API; the backend is S3, local disk, or the Replit
 * sidecar depending on env (see docs/ops/object-storage.md).
 */
export class ObjectStorageService {
  constructor(private readonly adapterOverride?: StorageAdapter) {}

  private adapter(): StorageAdapter {
    return this.adapterOverride ?? getStorageAdapter();
  }

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || '';
    const paths = Array.from(
      new Set(
        pathsStr
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      ),
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          'tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths).',
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const adapter = this.adapter();
    if (adapter instanceof ReplitSidecarStorage) {
      return readReplitPrivateDir();
    }
    const dir = process.env.PRIVATE_OBJECT_DIR || process.env.S3_PREFIX || '';
    if (dir) return dir;
    if (adapter.provider === 's3') {
      return `/${process.env.S3_BUCKET ?? ''}`;
    }
    return '/local';
  }

  async searchPublicObject(filePath: string): Promise<StorageObjectHandle | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;
      const adapter = this.adapter();
      if (await adapter.exists(fullPath)) {
        return new AdapterObjectHandle(adapter, fullPath);
      }
    }
    return null;
  }

  async downloadObject(file: StorageObjectHandle, res: Response, cacheTtlSec: number = 3600) {
    try {
      const [metadata] = await file.getMetadata();
      let isPublic = false;
      if (file.gcsFile) {
        const aclPolicy = await getObjectAclPolicy(file.gcsFile);
        isPublic = aclPolicy?.visibility === 'public';
      }
      res.set({
        'Content-Type': metadata.contentType || 'application/octet-stream',
        'Content-Length': metadata.size,
        'Cache-Control': `${isPublic ? 'public' : 'private'}, max-age=${cacheTtlSec}`,
      });
      const stream = await file.createReadStream();
      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error streaming file' });
        }
      });
      stream.pipe(res);
    } catch (error) {
      console.error('Error downloading file:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error downloading file' });
      }
    }
  }

  async getObjectEntityUploadURL(): Promise<string> {
    const { url } = await this.adapter().getSignedUploadUrl(storageKeys.upload(randomUUID()), 900);
    return url;
  }

  async getObjectEntityFile(objectPath: string): Promise<StorageObjectHandle> {
    const adapter = this.adapter();
    if (!(await adapter.exists(objectPath))) {
      throw new ObjectNotFoundError();
    }
    const handle = new AdapterObjectHandle(adapter, objectPath);
    if (adapter instanceof ReplitSidecarStorage) {
      // ACL helpers still speak GCS File; locate via a private-dir resolve.
      try {
        const dir = process.env.PRIVATE_OBJECT_DIR || '';
        if (dir && objectPath.startsWith('/objects/')) {
          const entityId = objectPath.slice('/objects/'.length);
          const fullPath = dir.endsWith('/') ? `${dir}${entityId}` : `${dir}/${entityId}`;
          const path = fullPath.startsWith('/') ? fullPath.slice(1) : fullPath;
          const parts = path.split('/');
          if (parts.length >= 2) {
            handle.gcsFile = objectStorageClient.bucket(parts[0]).file(parts.slice(1).join('/'));
          }
        }
      } catch {
        // ACL is best-effort on Replit; streaming still works without it.
      }
    }
    return handle;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    return this.adapter().normalizeObjectPath(rawPath);
  }

  async trySetObjectEntityAclPolicy(rawPath: string, aclPolicy: ObjectAclPolicy): Promise<string> {
    const adapter = this.adapter();
    const normalizedPath = adapter.normalizeObjectPath(rawPath);
    if (!normalizedPath.startsWith('/')) {
      return normalizedPath;
    }
    if (adapter instanceof ReplitSidecarStorage) {
      return adapter.trySetAclPolicy(normalizedPath, aclPolicy);
    }
    return normalizedPath;
  }

  async uploadPrivateObject(
    relativeKey: string,
    body: Buffer | string,
    contentType: string,
  ): Promise<string> {
    return this.adapter().put(relativeKey, body, { contentType });
  }

  async deletePrivateObject(fullObjectPath: string): Promise<boolean> {
    return this.adapter().delete(fullObjectPath);
  }

  async streamPrivateObject(
    fullObjectPath: string,
    res: Response,
    options?: StreamObjectOptions,
  ): Promise<void> {
    const adapter = this.adapter();
    if (!(await adapter.exists(fullObjectPath))) {
      throw new ObjectNotFoundError();
    }
    const metadata = await adapter.getMetadata(fullObjectPath);
    res.setHeader('Content-Type', metadata.contentType || 'application/octet-stream');
    if (metadata.size != null) {
      res.setHeader('Content-Length', String(metadata.size));
    }
    res.setHeader('Cache-Control', `private, max-age=${options?.cacheTtlSec ?? 0}`);
    if (options?.downloadFilename) {
      const safe = options.downloadFilename.replace(/"/g, '');
      const disposition = options.contentDisposition ?? 'attachment';
      res.setHeader('Content-Disposition', `${disposition}; filename="${safe}"`);
    }
    const stream = await adapter.createReadStream(fullObjectPath);
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.on('close', resolve);
      stream.pipe(res);
    });
  }

  /**
   * Stream an object stored as either `/objects/<entity>` or an absolute
   * `/<bucket>/<object>` path. Used by attachment and completion-photo
   * handlers so they no longer depend on a GCS File handle.
   */
  async streamStoredObject(
    objectPath: string,
    res: Response,
    options?: StreamObjectOptions,
  ): Promise<void> {
    await this.streamPrivateObject(objectPath, res, options);
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: StorageObjectHandle;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    if (!objectFile.gcsFile) return true;
    return canAccessObject({
      userId,
      objectFile: objectFile.gcsFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

export function objectStorageIsReady(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isObjectStorageConfigured(env);
}
