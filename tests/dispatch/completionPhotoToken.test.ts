// Unit tests for the HMAC token helpers that protect customer-facing
// completion-photo URLs. The token binds (tenantId, attachmentId,
// expiresAtSec); these tests pin down the round-trip, the cross-field
// rejections, and the expiry boundary so we can never silently
// regress to a permissive scheme.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ORIGINAL_SECRET = process.env.DISPATCH_COMPLETION_PHOTO_SECRET;
const ORIGINAL_TTL = process.env.DISPATCH_COMPLETION_PHOTO_TTL_SECONDS;

beforeEach(() => {
  process.env.DISPATCH_COMPLETION_PHOTO_SECRET = 'unit-test-secret-do-not-leak';
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.DISPATCH_COMPLETION_PHOTO_SECRET;
  else process.env.DISPATCH_COMPLETION_PHOTO_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_TTL === undefined) delete process.env.DISPATCH_COMPLETION_PHOTO_TTL_SECONDS;
  else process.env.DISPATCH_COMPLETION_PHOTO_TTL_SECONDS = ORIGINAL_TTL;
});

describe('completion-photo token round-trip', () => {
  it('verifies a freshly minted token', async () => {
    const { buildCompletionPhotoToken, verifyCompletionPhotoToken } = await import(
      '../../platform/dispatch/completionPhotoToken'
    );
    const now = Date.now();
    const t = buildCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
      nowMs: now,
    });
    expect(verifyCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
      expiresAtSec: t.expiresAtSec,
      signature: t.signature,
      nowMs: now,
    })).toBe(true);
  });

  it('rejects a token whose tenantId was swapped (tenant-binding)', async () => {
    const { buildCompletionPhotoToken, verifyCompletionPhotoToken } = await import(
      '../../platform/dispatch/completionPhotoToken'
    );
    const now = Date.now();
    const t = buildCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
      nowMs: now,
    });
    expect(verifyCompletionPhotoToken({
      tenantId: 'tenant-B',
      attachmentId: 'att-1',
      expiresAtSec: t.expiresAtSec,
      signature: t.signature,
      nowMs: now,
    })).toBe(false);
  });

  it('rejects a token whose attachmentId was swapped', async () => {
    const { buildCompletionPhotoToken, verifyCompletionPhotoToken } = await import(
      '../../platform/dispatch/completionPhotoToken'
    );
    const now = Date.now();
    const t = buildCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
      nowMs: now,
    });
    expect(verifyCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-2',
      expiresAtSec: t.expiresAtSec,
      signature: t.signature,
      nowMs: now,
    })).toBe(false);
  });

  it('rejects an expired token even with a valid signature', async () => {
    const { buildCompletionPhotoToken, verifyCompletionPhotoToken } = await import(
      '../../platform/dispatch/completionPhotoToken'
    );
    const issuedAt = Date.now();
    const t = buildCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
      ttlSeconds: 60,
      nowMs: issuedAt,
    });
    expect(verifyCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
      expiresAtSec: t.expiresAtSec,
      signature: t.signature,
      nowMs: issuedAt + 61_000,
    })).toBe(false);
  });

  it('rejects blank / malformed inputs without throwing', async () => {
    const { verifyCompletionPhotoToken } = await import(
      '../../platform/dispatch/completionPhotoToken'
    );
    expect(verifyCompletionPhotoToken({
      tenantId: '', attachmentId: 'att-1', expiresAtSec: 1, signature: 'x',
    })).toBe(false);
    expect(verifyCompletionPhotoToken({
      tenantId: 't', attachmentId: '', expiresAtSec: 1, signature: 'x',
    })).toBe(false);
    expect(verifyCompletionPhotoToken({
      tenantId: 't', attachmentId: 'a', expiresAtSec: NaN, signature: 'x',
    })).toBe(false);
    expect(verifyCompletionPhotoToken({
      tenantId: 't', attachmentId: 'a', expiresAtSec: 1, signature: '',
    })).toBe(false);
  });

  it('rejects a token signed with a different secret', async () => {
    process.env.DISPATCH_COMPLETION_PHOTO_SECRET = 'secret-A';
    let mod = await import('../../platform/dispatch/completionPhotoToken');
    const t = mod.buildCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
    });

    process.env.DISPATCH_COMPLETION_PHOTO_SECRET = 'secret-B';
    // Re-import to pick up the new secret in the module-private getter.
    // (The helper reads process.env on every call, so a fresh import
    // isn't strictly required, but doing it makes the intent obvious.)
    mod = await import('../../platform/dispatch/completionPhotoToken');
    expect(mod.verifyCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
      expiresAtSec: t.expiresAtSec,
      signature: t.signature,
    })).toBe(false);
  });
});

describe('completion-photo URL builder', () => {
  it('embeds tenant, attachment, signature, and expiry as query params', async () => {
    const { buildCompletionPhotoUrl, verifyCompletionPhotoToken } = await import(
      '../../platform/dispatch/completionPhotoToken'
    );
    const { url, expiresAtSec } = buildCompletionPhotoUrl({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/admin/dispatch/completion-photos/att-1');
    expect(parsed.searchParams.get('tid')).toBe('tenant-A');
    expect(parsed.searchParams.get('exp')).toBe(String(expiresAtSec));
    const sig = parsed.searchParams.get('t');
    expect(sig).toBeTruthy();
    expect(verifyCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
      expiresAtSec,
      signature: sig,
    })).toBe(true);
  });

  it('caps an absurd TTL at 90 days', async () => {
    process.env.DISPATCH_COMPLETION_PHOTO_TTL_SECONDS = '999999999';
    const { getCompletionPhotoTokenTtlSeconds } = await import(
      '../../platform/dispatch/completionPhotoToken'
    );
    expect(getCompletionPhotoTokenTtlSeconds()).toBe(90 * 24 * 60 * 60);
  });
});

describe('completion-photo secret fail-closed in production', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('mint throws in production when DISPATCH_COMPLETION_PHOTO_SECRET is unset', async () => {
    delete process.env.DISPATCH_COMPLETION_PHOTO_SECRET;
    process.env.NODE_ENV = 'production';
    const { buildCompletionPhotoUrl } = await import(
      '../../platform/dispatch/completionPhotoToken'
    );
    expect(() => buildCompletionPhotoUrl({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
    })).toThrow(/DISPATCH_COMPLETION_PHOTO_SECRET/);
  });

  it('verify returns false (no throw) in production when the secret is unset', async () => {
    delete process.env.DISPATCH_COMPLETION_PHOTO_SECRET;
    process.env.NODE_ENV = 'production';
    const { verifyCompletionPhotoToken } = await import(
      '../../platform/dispatch/completionPhotoToken'
    );
    // Even with a plausibly-formatted token, verify must deny rather
    // than blow up the unauthenticated handler.
    expect(verifyCompletionPhotoToken({
      tenantId: 'tenant-A',
      attachmentId: 'att-1',
      expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
      signature: 'a'.repeat(32),
    })).toBe(false);
  });
});
