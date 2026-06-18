import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const a = vi.hoisted(() => ({ validateApiKeyMock: vi.fn() }));

vi.mock('../../../platform/rbac/ApiKeyService', () => ({ validateApiKey: a.validateApiKeyMock }));
vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

import { requireApiKeyOrJwt } from './apiKeyAuth';

function ctx(authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as unknown as Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  const next = vi.fn();
  return { req, res: res as unknown as Response & { statusCode: number; body: unknown }, next: next as unknown as NextFunction & typeof next };
}

beforeEach(() => a.validateApiKeyMock.mockReset());

describe('requireApiKeyOrJwt', () => {
  it('delegates to the JWT middleware when no api-key bearer is present', async () => {
    const jwt = vi.fn();
    const { req, res, next } = ctx('Bearer some-jwt');
    await requireApiKeyOrJwt(jwt)(req, res, next);
    expect(jwt).toHaveBeenCalledWith(req, res, next);
  });
  it('401 for an invalid api key', async () => {
    a.validateApiKeyMock.mockResolvedValue(null);
    const jwt = vi.fn();
    const { req, res, next } = ctx('Bearer vai_badkey');
    await requireApiKeyOrJwt(jwt)(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(jwt).not.toHaveBeenCalled();
  });
  it('injects req.user + scopes for a valid api key', async () => {
    a.validateApiKeyMock.mockResolvedValue({ keyId: 'k1', tenantId: 't1', scopes: ['write'] });
    const jwt = vi.fn();
    const { req, res, next } = ctx('Bearer vai_goodkey');
    await requireApiKeyOrJwt(jwt)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ userId: 'apikey:k1', tenantId: 't1', role: 'tenant_owner' });
    expect(req.apiKeyScopes).toEqual(['write']);
  });
});
