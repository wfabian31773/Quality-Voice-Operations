import type { Request, Response, NextFunction } from 'express';

/**
 * PR-00 (Render): the Replit object-storage sidecar (127.0.0.1:1106) only
 * exists on Replit. Nothing may call it unless PRIVATE_OBJECT_DIR is set.
 * The S3 / Supabase Storage provider lands in PR-00b.
 */
export function isObjectStorageConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.PRIVATE_OBJECT_DIR?.trim();
}

export const STORAGE_NOT_CONFIGURED_BODY = {
  error: 'storage not configured',
  code: 'STORAGE_NOT_CONFIGURED',
} as const;

/** Route guard: 503 "storage not configured" instead of a sidecar call. */
export function requireObjectStorage(_req: Request, res: Response, next: NextFunction): void {
  if (!isObjectStorageConfigured()) {
    res.status(503).json(STORAGE_NOT_CONFIGURED_BODY);
    return;
  }
  next();
}
