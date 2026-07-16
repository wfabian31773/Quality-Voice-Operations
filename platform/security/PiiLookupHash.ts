import { createHmac, timingSafeEqual } from 'node:crypto';

export type PiiLookupPurpose = 'caller_memory' | 'synthetic_test';
export type ScopedIdentifierPurpose = 'tenant_deletion' | 'deletion_executor' | 'approval_evidence';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const KEY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export interface PiiLookupHashRecord {
  hash: string;
  keyVersion: string;
}

interface PiiLookupKey {
  key: string;
  version: string;
}

export function normalizeLookupPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  const normalized = digits.length === 10
    ? `+1${digits}`
    : digits.length === 11 && digits.startsWith('1')
      ? `+${digits}`
      : `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) return null;
  return normalized;
}

function lookupKeyring(): readonly PiiLookupKey[] | null {
  const key = process.env.QVO_PII_LOOKUP_HMAC_KEY;
  if (typeof key !== 'string' || key.length < 32) return null;
  const rawVersion = process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION;
  const version = rawVersion === undefined ? 'v1' : rawVersion.trim();
  if (!KEY_VERSION_PATTERN.test(version)) return null;

  const previousKey = process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY;
  const rawPreviousVersion = process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION;
  if (previousKey === undefined && rawPreviousVersion === undefined) {
    return [{ key, version }];
  }
  if (
    typeof previousKey !== 'string'
    || previousKey.length < 32
    || typeof rawPreviousVersion !== 'string'
  ) return null;
  const previousVersion = rawPreviousVersion.trim();
  if (
    !KEY_VERSION_PATTERN.test(previousVersion)
    || previousVersion === version
    || previousKey === key
  ) return null;
  return [{ key, version }, { key: previousKey, version: previousVersion }];
}

export function getCurrentPiiLookupKeyVersion(): string | null {
  return lookupKeyring()?.[0]?.version ?? null;
}

export function getPiiLookupKeyringStatus(): {
  valid: boolean;
  currentVersion: string | null;
  previousVersion: string | null;
  dualRead: boolean;
} {
  const keyring = lookupKeyring();
  if (!keyring) {
    return { valid: false, currentVersion: null, previousVersion: null, dualRead: false };
  }
  return {
    valid: true,
    currentVersion: keyring[0].version,
    previousVersion: keyring[1]?.version ?? null,
    dualRead: keyring.length === 2,
  };
}

function hashLookupValue(
  key: string,
  tenant: string,
  phone: string,
  purpose: PiiLookupPurpose,
): string {
  return createHmac('sha256', key)
    .update(`qvo:${purpose}:v1:${tenant}:${phone}`, 'utf8')
    .digest('hex');
}

export function createPiiLookupHashCandidates(
  tenantId: string,
  value: unknown,
  purpose: PiiLookupPurpose,
): PiiLookupHashRecord[] {
  const keyring = lookupKeyring();
  const phone = normalizeLookupPhone(value);
  const tenant = tenantId.trim();
  if (!keyring || !phone || !tenant || tenant.length > 255) return [];
  return keyring.map(({ key, version }) => ({
    hash: hashLookupValue(key, tenant, phone, purpose),
    keyVersion: version,
  }));
}

export function createPiiLookupHashRecord(
  tenantId: string,
  value: unknown,
  purpose: PiiLookupPurpose,
): PiiLookupHashRecord | null {
  return createPiiLookupHashCandidates(tenantId, value, purpose)[0] ?? null;
}

export function createPiiLookupHash(
  tenantId: string,
  value: unknown,
  purpose: PiiLookupPurpose,
): string | null {
  return createPiiLookupHashRecord(tenantId, value, purpose)?.hash ?? null;
}

export function createScopedIdentifierHash(
  scopeId: string,
  identifier: string,
  purpose: ScopedIdentifierPurpose,
): string | null {
  const key = lookupKeyring()?.[0]?.key;
  const scope = scopeId.trim();
  const value = identifier.trim();
  if (!key || !scope || !value || scope.length > 255 || value.length > 500) return null;
  if (/[\u0000-\u001F]/.test(scope) || /[\u0000-\u001F]/.test(value)) return null;
  return createHmac('sha256', key)
    .update(`qvo:${purpose}:v1:${scope}:${value}`, 'utf8')
    .digest('hex');
}

export function constantTimeHashMatch(candidate: string | null, allowed: unknown): boolean {
  if (!candidate || !HASH_PATTERN.test(candidate) || !Array.isArray(allowed)) return false;
  const candidateBuffer = Buffer.from(candidate, 'hex');
  let matched = false;
  for (const value of allowed) {
    if (typeof value !== 'string' || !HASH_PATTERN.test(value)) continue;
    matched = timingSafeEqual(candidateBuffer, Buffer.from(value, 'hex')) || matched;
  }
  return matched;
}
