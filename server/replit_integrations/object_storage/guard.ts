import type { Request, Response, NextFunction } from 'express';
import { isObjectStorageConfigured as storageConfigured } from '../../../platform/storage';

/**
 * PR-00b: object storage is configured when an S3-compatible backend, a
 * local-disk fallback, or the Replit sidecar (`PRIVATE_OBJECT_DIR`) is
 * selected by env. See docs/ops/object-storage.md.
 */
export function isObjectStorageConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return storageConfigured(env);
}

export const STORAGE_NOT_CONFIGURED_BODY = {
  error: 'storage not configured',
  code: 'STORAGE_NOT_CONFIGURED',
} as const;

/** Route guard: 503 "storage not configured" instead of a sidecar/S3 call. */
export function requireObjectStorage(_req: Request, res: Response, next: NextFunction): void {
  if (!isObjectStorageConfigured()) {
    res.status(503).json(STORAGE_NOT_CONFIGURED_BODY);
    return;
  }
  next();
}
