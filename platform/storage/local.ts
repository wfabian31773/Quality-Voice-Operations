import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { ObjectNotFoundError } from './errors';
import {
  isEntityObjectPath,
  joinObjectPath,
  parseAbsoluteObjectPath,
  stripLeadingSlashes,
} from './paths';
import type {
  PutObjectOptions,
  SignedUploadUrl,
  StorageAdapter,
  StoredObjectMetadata,
} from './types';

export const LOCAL_STORAGE_BUCKET = 'local';
export const LOCAL_STORAGE_URL_SCHEME = 'local-storage://';

export function defaultLocalStorageDir(): string {
  return path.join(os.tmpdir(), 'qvo-object-storage');
}

function resolveLocalRoot(env: Record<string, string | undefined>): string {
  return env.OBJECT_STORAGE_LOCAL_DIR?.trim() || defaultLocalStorageDir();
}

export class LocalDiskStorage implements StorageAdapter {
  readonly provider = 'local' as const;

  constructor(private readonly rootDir: string) {}

  private toRelativeKey(key: string): string {
    if (isEntityObjectPath(key)) {
      return key.slice('/objects/'.length);
    }
    if (key.startsWith(LOCAL_STORAGE_URL_SCHEME)) {
      return stripLeadingSlashes(key.slice(LOCAL_STORAGE_URL_SCHEME.length).replace(/^local\//, ''));
    }
    if (key.startsWith('/') && key !== '/') {
      const { bucketName, objectName } = parseAbsoluteObjectPath(key);
      if (bucketName === LOCAL_STORAGE_BUCKET) return objectName;
      return stripLeadingSlashes(`${bucketName}/${objectName}`);
    }
    return stripLeadingSlashes(key);
  }

  private resolveFsPath(key: string): string {
    const relative = this.toRelativeKey(key);
    if (!relative || relative.split('/').some((part) => part === '..')) {
      throw new Error('Invalid object key');
    }
    const root = path.resolve(this.rootDir);
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error('Invalid object key');
    }
    return resolved;
  }

  /**
   * {@link resolveFsPath} plus the on-disk check: no path component under the
   * root may be a symlink, and the deepest existing one must really be inside
   * the root.
   */
  private async resolveContainedFsPath(key: string): Promise<string> {
    const fsPath = this.resolveFsPath(key);
    const root = path.resolve(this.rootDir);
    let deepestExisting = root;
    try {
      for (const part of path.relative(root, fsPath).split(path.sep)) {
        const next = path.join(deepestExisting, part);
        if ((await lstat(next)).isSymbolicLink()) throw new Error('Invalid object key');
        deepestExisting = next;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
    try {
      const realRoot = await realpath(root);
      const real = await realpath(deepestExisting);
      if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
        throw new Error('Invalid object key');
      }
    } catch (err) {
      // The root itself does not exist yet, so nothing below it can escape.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return fsPath;
  }

  private persistablePath(key: string): string {
    return joinObjectPath(LOCAL_STORAGE_BUCKET, this.toRelativeKey(key));
  }

  async put(key: string, body: Buffer | string, _options?: PutObjectOptions): Promise<string> {
    const fsPath = await this.resolveContainedFsPath(key);
    await mkdir(path.dirname(fsPath), { recursive: true });
    await writeFile(fsPath, body);
    return this.persistablePath(key);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(await this.resolveContainedFsPath(key));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new ObjectNotFoundError();
      throw err;
    }
  }

  async getMetadata(key: string): Promise<StoredObjectMetadata> {
    try {
      const info = await stat(await this.resolveContainedFsPath(key));
      return { contentType: 'application/octet-stream', size: info.size };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new ObjectNotFoundError();
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(await this.resolveContainedFsPath(key));
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await unlink(await this.resolveContainedFsPath(key));
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      throw err;
    }
  }

  async createReadStream(key: string): Promise<Readable> {
    if (!(await this.exists(key))) throw new ObjectNotFoundError();
    return createReadStream(await this.resolveContainedFsPath(key));
  }

  async getSignedUploadUrl(key: string, _ttlSec: number): Promise<SignedUploadUrl> {
    const relative = this.toRelativeKey(key);
    const objectPath = `/objects/${relative}`;
    return {
      url: `${LOCAL_STORAGE_URL_SCHEME}${LOCAL_STORAGE_BUCKET}/${relative}`,
      objectPath,
    };
  }

  normalizeObjectPath(rawPath: string): string {
    if (rawPath.startsWith(LOCAL_STORAGE_URL_SCHEME)) {
      return `/objects/${this.toRelativeKey(rawPath)}`;
    }
    if (rawPath.startsWith('file://')) {
      const pathname = new URL(rawPath).pathname;
      const root = path.resolve(this.rootDir);
      if (pathname.startsWith(`${root}/`)) {
        return `/objects/${stripLeadingSlashes(pathname.slice(root.length))}`;
      }
    }
    return rawPath;
  }
}

export function createLocalStorageAdapter(
  env: Record<string, string | undefined> = process.env,
): LocalDiskStorage {
  return new LocalDiskStorage(resolveLocalRoot(env));
}
