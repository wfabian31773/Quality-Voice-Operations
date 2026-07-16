import { afterEach, describe, expect, it } from 'vitest';
import {
  constantTimeHashMatch,
  createPiiLookupHash,
  createPiiLookupHashCandidates,
  createPiiLookupHashRecord,
  createScopedIdentifierHash,
  getPiiLookupKeyringStatus,
  normalizeLookupPhone,
} from './PiiLookupHash';

const originalKey = process.env.QVO_PII_LOOKUP_HMAC_KEY;
const originalVersion = process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION;
const originalPreviousKey = process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY;
const originalPreviousVersion = process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION;

afterEach(() => {
  if (originalKey === undefined) delete process.env.QVO_PII_LOOKUP_HMAC_KEY;
  else process.env.QVO_PII_LOOKUP_HMAC_KEY = originalKey;
  if (originalVersion === undefined) delete process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION;
  else process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION = originalVersion;
  if (originalPreviousKey === undefined) delete process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY;
  else process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY = originalPreviousKey;
  if (originalPreviousVersion === undefined) delete process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION;
  else process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION = originalPreviousVersion;
});

describe('PII lookup hashing', () => {
  it.each([
    ['(555) 123-4567', '+15551234567'],
    ['+1 555 123 4567', '+15551234567'],
    ['+442071838750', '+442071838750'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeLookupPhone(input)).toBe(expected);
  });

  it.each(['', '911', 'not-a-phone', '+00000000000'])('rejects invalid phone %s', (input) => {
    expect(normalizeLookupPhone(input)).toBeNull();
  });

  it('fails closed without a sufficiently strong key', () => {
    delete process.env.QVO_PII_LOOKUP_HMAC_KEY;
    expect(createPiiLookupHash('tenant-1', '+15551234567', 'caller_memory')).toBeNull();
    process.env.QVO_PII_LOOKUP_HMAC_KEY = 'short';
    expect(createPiiLookupHash('tenant-1', '+15551234567', 'caller_memory')).toBeNull();
  });

  it('is stable for one tenant and purpose but separated across tenants and purposes', () => {
    process.env.QVO_PII_LOOKUP_HMAC_KEY = 'a-secure-lookup-key-with-at-least-32-characters';
    const memory = createPiiLookupHash('tenant-1', '+15551234567', 'caller_memory');
    expect(memory).toMatch(/^[a-f0-9]{64}$/);
    expect(createPiiLookupHash('tenant-1', '(555) 123-4567', 'caller_memory')).toBe(memory);
    expect(createPiiLookupHash('tenant-2', '+15551234567', 'caller_memory')).not.toBe(memory);
    expect(createPiiLookupHash('tenant-1', '+15551234567', 'synthetic_test')).not.toBe(memory);
  });

  it('returns the current key version with newly created lookup hashes', () => {
    process.env.QVO_PII_LOOKUP_HMAC_KEY = 'current-lookup-key-with-at-least-32-characters';
    process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION = '2026-07-blue';
    expect(createPiiLookupHashRecord('tenant-1', '+15551234567', 'caller_memory')).toEqual({
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      keyVersion: '2026-07-blue',
    });
  });

  it('queries with current and previous key candidates during a bounded rotation window', () => {
    process.env.QVO_PII_LOOKUP_HMAC_KEY = 'current-lookup-key-with-at-least-32-characters';
    process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION = 'v2';
    process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY = 'previous-lookup-key-with-at-least-32-characters';
    process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION = 'v1';
    const candidates = createPiiLookupHashCandidates('tenant-1', '+15551234567', 'caller_memory');
    expect(candidates.map((candidate) => candidate.keyVersion)).toEqual(['v2', 'v1']);
    expect(new Set(candidates.map((candidate) => candidate.hash)).size).toBe(2);
    expect(getPiiLookupKeyringStatus()).toEqual({
      valid: true, currentVersion: 'v2', previousVersion: 'v1', dualRead: true,
    });
  });

  it('fails closed for partial, duplicate, or malformed rotation configuration', () => {
    process.env.QVO_PII_LOOKUP_HMAC_KEY = 'current-lookup-key-with-at-least-32-characters';
    process.env.QVO_PII_LOOKUP_HMAC_KEY_VERSION = 'v2';
    process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_KEY = 'previous-lookup-key-with-at-least-32-characters';
    delete process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION;
    expect(createPiiLookupHashCandidates('tenant-1', '+15551234567', 'caller_memory')).toEqual([]);

    process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION = 'v2';
    expect(createPiiLookupHashRecord('tenant-1', '+15551234567', 'caller_memory')).toBeNull();

    process.env.QVO_PII_LOOKUP_HMAC_PREVIOUS_VERSION = 'bad version';
    expect(createPiiLookupHashCandidates('tenant-1', '+15551234567', 'caller_memory')).toEqual([]);
  });

  it('compares valid hashes without accepting malformed values', () => {
    const hash = 'a'.repeat(64);
    expect(constantTimeHashMatch(hash, [hash])).toBe(true);
    expect(constantTimeHashMatch('b'.repeat(64), [hash])).toBe(false);
    expect(constantTimeHashMatch('not-a-hash', [hash])).toBe(false);
  });

  it('creates a purpose-separated tenant deletion fingerprint without exposing the identifier', () => {
    process.env.QVO_PII_LOOKUP_HMAC_KEY = 'a-secure-lookup-key-with-at-least-32-characters';
    const fingerprint = createScopedIdentifierHash('tenant-1', 'tenant-1', 'tenant_deletion');
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain('tenant-1');
    expect(createScopedIdentifierHash('tenant-1', 'tenant-1', 'approval_evidence')).not.toBe(fingerprint);
    expect(createScopedIdentifierHash('tenant-1', 'tenant-1', 'deletion_executor')).not.toBe(fingerprint);
  });
});
