import type { Readable } from 'node:stream';

export const OBJECT_STORAGE_PROVIDERS = ['s3', 'local', 'replit'] as const;
export type ObjectStorageProvider = (typeof OBJECT_STORAGE_PROVIDERS)[number];

/** Accepted OBJECT_STORAGE_PROVIDER spellings. Unset is valid (auto-detect). */
export function isKnownStorageProviderName(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'disk') return true;
  return (OBJECT_STORAGE_PROVIDERS as readonly string[]).includes(value);
}

export interface PutObjectOptions {
  contentType?: string;
  cacheControl?: string;
}

export interface StoredObjectMetadata {
  contentType: string;
  size?: number;
}

export interface SignedUploadUrl {
  /** Presigned (or local-scheme) URL the client PUTs the bytes to. */
  url: string;
  /** Persistable path (`/objects/<key>` or `/<bucket>/<object>`). */
  objectPath: string;
}

export interface StreamObjectOptions {
  downloadFilename?: string;
  cacheTtlSec?: number;
  contentDisposition?: 'attachment' | 'inline';
  /** Used when storage has no specific content type for the object. */
  fallbackContentType?: string;
}

/**
 * Backend-agnostic object store. Keys may be relative (`uploads/uuid`) or
 * persistable paths returned by {@link StorageAdapter.put}.
 */
export interface StorageAdapter {
  readonly provider: ObjectStorageProvider;

  put(key: string, body: Buffer | string, options?: PutObjectOptions): Promise<string>;
  get(key: string): Promise<Buffer>;
  getMetadata(key: string): Promise<StoredObjectMetadata>;
  exists(key: string): Promise<boolean>;
  /** `true` when an object was removed, `false` when it was already gone. */
  delete(key: string): Promise<boolean>;
  createReadStream(key: string): Promise<Readable>;
  getSignedUploadUrl(key: string, ttlSec: number): Promise<SignedUploadUrl>;
  normalizeObjectPath(rawPath: string): string;
}
