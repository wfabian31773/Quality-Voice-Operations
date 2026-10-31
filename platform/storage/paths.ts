/**
 * Persistable object paths are `/<bucket>/<object>` (what callers store in
 * Postgres) or the upload-flow form `/objects/<entityId>`.
 */
export function stripLeadingSlashes(value: string): string {
  return value.replace(/^\/+/, '');
}

export function joinObjectPath(bucket: string, objectName: string): string {
  const cleanBucket = stripLeadingSlashes(bucket).replace(/\/+$/, '');
  const cleanKey = stripLeadingSlashes(objectName);
  return `/${cleanBucket}/${cleanKey}`;
}

export function parseAbsoluteObjectPath(path: string): { bucketName: string; objectName: string } {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const parts = normalized.split('/');
  if (parts.length < 3 || !parts[1]) {
    throw new Error('Invalid path: must contain at least a bucket name');
  }
  return {
    bucketName: parts[1],
    objectName: parts.slice(2).join('/'),
  };
}

export function isEntityObjectPath(path: string): boolean {
  return path.startsWith('/objects/');
}

/** The only path shape a client may attach: `/objects/uploads/<id>`. */
export function isCanonicalUploadObjectPath(path: string): boolean {
  return /^\/objects\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path);
}

export function entityIdFromObjectPath(path: string): string {
  if (!isEntityObjectPath(path)) {
    throw new Error('Not an /objects/ entity path');
  }
  return path.slice('/objects/'.length);
}
