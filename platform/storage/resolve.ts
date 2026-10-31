import { StorageNotConfiguredError } from './errors';
import { createLocalStorageAdapter } from './local';
import { createReplitStorageAdapter } from './replit';
import { createS3StorageAdapter, isS3StorageConfigured } from './s3';
import type { ObjectStorageProvider, StorageAdapter } from './types';
import { OBJECT_STORAGE_PROVIDERS } from './types';

export type StorageEnv = Record<string, string | undefined>;

export function normalizeStorageProvider(
  raw: string | undefined,
): ObjectStorageProvider | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'disk') return 'local';
  if ((OBJECT_STORAGE_PROVIDERS as readonly string[]).includes(value)) {
    return value as ObjectStorageProvider;
  }
  throw new Error(
    `OBJECT_STORAGE_PROVIDER must be one of ${OBJECT_STORAGE_PROVIDERS.join(', ')} (got an unknown value)`,
  );
}

export function resolveStorageProvider(env: StorageEnv = process.env): ObjectStorageProvider | null {
  const explicit = normalizeStorageProvider(env.OBJECT_STORAGE_PROVIDER);
  if (explicit === 's3') return isS3StorageConfigured(env) ? 's3' : null;
  if (explicit === 'local') return 'local';
  if (explicit === 'replit') return env.PRIVATE_OBJECT_DIR?.trim() ? 'replit' : null;
  if (isS3StorageConfigured(env)) return 's3';
  if (env.PRIVATE_OBJECT_DIR?.trim()) return 'replit';
  if (env.OBJECT_STORAGE_LOCAL_DIR?.trim()) return 'local';
  return null;
}

export function isObjectStorageConfigured(env: StorageEnv = process.env): boolean {
  return resolveStorageProvider(env) !== null;
}

export function createStorageAdapter(env: StorageEnv = process.env): StorageAdapter {
  const provider = resolveStorageProvider(env);
  if (provider === 's3') return createS3StorageAdapter(env);
  if (provider === 'local') return createLocalStorageAdapter(env);
  if (provider === 'replit') return createReplitStorageAdapter(env);
  throw new StorageNotConfiguredError();
}

let cached: StorageAdapter | null = null;
let cachedSignature: string | null = null;

function adapterSignature(env: StorageEnv): string {
  return [
    env.OBJECT_STORAGE_PROVIDER ?? '',
    env.S3_BUCKET ?? '',
    env.S3_ENDPOINT ?? '',
    env.S3_PREFIX ?? '',
    env.PRIVATE_OBJECT_DIR ?? '',
    env.OBJECT_STORAGE_LOCAL_DIR ?? '',
  ].join('\0');
}

/** Process-wide adapter. Tests should call {@link resetStorageAdapterForTests}. */
export function getStorageAdapter(env: StorageEnv = process.env): StorageAdapter {
  const signature = adapterSignature(env);
  if (!cached || cachedSignature !== signature) {
    cached = createStorageAdapter(env);
    cachedSignature = signature;
  }
  return cached;
}

export function resetStorageAdapterForTests(): void {
  cached = null;
  cachedSignature = null;
}
