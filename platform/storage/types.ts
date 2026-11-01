import type { Readable } from 'node:stream';

export const OBJECT_STORAGE_PROVIDERS = ['s3', 'local', 'replit'] as const;
export type ObjectStorageProvider = (typeof OBJECT_STORAGE_PROVIDERS)[number];

/** Accepted OBJECT_STORAGE_PROVIDER spellings. Unset is valid (auto-detect). */
export function isKnownStorageProviderName(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'disk') return true;
  return (OBJECT_STORAGE_PROVIDERS as readonly string[]).includes(value);
}

export interface ObjectKeyOptions {
  /**
   * The key is voice-preview cache, which the Replit adapter locates by its own
   * rules. S3 and local disk ignore this.
   */
  voicePreview?: boolean;
}

export interface PutObjectOptions extends ObjectKeyOptions {
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
  get(key: string, options?: ObjectKeyOptions): Promise<Buffer>;
  getMetadata(key: string, options?: ObjectKeyOptions): Promise<StoredObjectMetadata>;
  exists(key: string, options?: ObjectKeyOptions): Promise<boolean>;
  /** `true` when an object was removed, `false` when it was already gone. */
  delete(key: string, options?: ObjectKeyOptions): Promise<boolean>;
  createReadStream(key: string, options?: ObjectKeyOptions): Promise<Readable>;
  getSignedUploadUrl(key: string, ttlSec: number): Promise<SignedUploadUrl>;
  normalizeObjectPath(rawPath: string): string;
}
