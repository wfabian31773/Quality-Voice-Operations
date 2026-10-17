import { describe, expect, it } from 'vitest';
import {
  authenticate,
  bearerToken,
  chainResolvers,
  envKeyResolver,
  hashKey,
  McpAuthError,
  normalizeScopes,
  parseEnvKeys,
} from './auth';
import { resolveStdioPrincipal } from './stdio';

const READ_KEY = 'qvo_test_read_key';
const ENV_KEYS = JSON.stringify([
  { id: 'reader-a', sha256: hashKey(READ_KEY), tenantId: 'tenant-a', scopes: ['qvo:read'] },
  { id: 'platform', sha256: hashKey('qvo_test_platform_key'), platformAdmin: true, scopes: ['qvo:admin'] },
]);

describe('normalizeScopes', () => {
  it('keeps only qvo:* scopes; admin implies read; * grants nothing', () => {
    expect(normalizeScopes(['*'])).toEqual([]);
    expect(normalizeScopes(['read', 'qvo:read'])).toEqual(['qvo:read']);
    expect(normalizeScopes(['qvo:admin'])).toEqual(['qvo:read', 'qvo:admin']);
    expect(normalizeScopes('qvo:admin')).toEqual([]);
  });
});

describe('env key list', () => {
  it('resolves a hashed key to its tenant and scopes', async () => {
    const resolve = envKeyResolver(ENV_KEYS);
    expect(await resolve(READ_KEY)).toEqual({ keyId: 'env:reader-a', tenantId: 'tenant-a', scopes: ['qvo:read'] });
    expect(await resolve('qvo_test_platform_key')).toEqual({
      keyId: 'env:platform',
      tenantId: null,
      scopes: ['qvo:read', 'qvo:admin'],
    });
    expect(await resolve('wrong')).toBeNull();
  });

  it('rejects malformed config instead of running open', () => {
    expect(() => parseEnvKeys('{')).toThrow(/valid JSON/);
    expect(() => parseEnvKeys('[{"id":"x","sha256":"abc","tenantId":"t","scopes":["qvo:read"]}]')).toThrow(/sha256/);
    const sha256 = hashKey('k');
    expect(() => parseEnvKeys(JSON.stringify([{ id: 'x', sha256, scopes: ['qvo:read'] }]))).toThrow(/exactly one/);
    expect(() =>
      parseEnvKeys(JSON.stringify([{ id: 'x', sha256, tenantId: 't', platformAdmin: true, scopes: ['qvo:read'] }])),
    ).toThrow(/exactly one/);
    expect(() => parseEnvKeys(JSON.stringify([{ id: 'x', sha256, tenantId: 't', scopes: ['*'] }]))).toThrow(/scopes/);
    expect(parseEnvKeys(undefined)).toEqual([]);
  });
});

describe('authenticate', () => {
  const resolve = envKeyResolver(ENV_KEYS);

  it('refuses a missing key', async () => {
    await expect(authenticate(undefined, resolve)).rejects.toMatchObject({ status: 401, message: 'Missing API key' });
    await expect(authenticate('', resolve)).rejects.toBeInstanceOf(McpAuthError);
  });

  it('refuses an unknown key', async () => {
    await expect(authenticate('nope', resolve)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a key with no qvo:* scope', async () => {
    const noScope = async () => ({ keyId: 'x', tenantId: 't', scopes: [] });
    await expect(authenticate('k', noScope)).rejects.toMatchObject({ status: 403 });
  });

  it('fails closed when the resolver throws', async () => {
    const broken = chainResolvers(async () => {
      throw new Error('db down');
    });
    await expect(authenticate('k', broken)).rejects.toMatchObject({ status: 401 });
  });

  it('accepts a valid key', async () => {
    expect((await authenticate(READ_KEY, resolve)).tenantId).toBe('tenant-a');
  });
});

describe('stdio key', () => {
  it('refuses to start without QVO_MCP_API_KEY', async () => {
    await expect(resolveStdioPrincipal({ QVO_MCP_API_KEYS: ENV_KEYS }, envKeyResolver(ENV_KEYS))).rejects.toThrow(
      'Missing API key',
    );
  });

  it('binds the stdio session to the key', async () => {
    const principal = await resolveStdioPrincipal({ QVO_MCP_API_KEY: READ_KEY }, envKeyResolver(ENV_KEYS));
    expect(principal.keyId).toBe('env:reader-a');
  });
});

describe('bearerToken', () => {
  it('parses Bearer headers only', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});
