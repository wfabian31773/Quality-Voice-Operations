import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireApiKeyPermission } from './apiKeyScope';

function ctx(user?: Record<string, unknown>, apiKeyScopes?: string[]) {
  const req = { user, apiKeyScopes } as unknown as Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  const next = vi.fn();
  return { req, res: res as unknown as Response & { statusCode: number }, next: next as unknown as NextFunction & typeof next };
}

describe('requireApiKeyPermission', () => {
  it('401 without a user', () => {
    const { req, res, next } = ctx(undefined);
    requireApiKeyPermission('write')(req, res, next);
    expect(res.statusCode).toBe(401);
  });
  it('passes through for non-api-key (JWT) users', () => {
    const { req, res, next } = ctx({ userId: 'u1' });
    requireApiKeyPermission('admin')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('403 when an api key has no scopes', () => {
    const { req, res, next } = ctx({ userId: 'apikey:k1' }, []);
    requireApiKeyPermission('read-only')(req, res, next);
    expect(res.statusCode).toBe(403);
  });
  it('passes for a wildcard scope', () => {
    const { req, res, next } = ctx({ userId: 'apikey:k1' }, ['*']);
    requireApiKeyPermission('admin')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('passes for an admin scope', () => {
    const { req, res, next } = ctx({ userId: 'apikey:k1' }, ['admin']);
    requireApiKeyPermission('write')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('403 when the scope level is below the minimum', () => {
    const { req, res, next } = ctx({ userId: 'apikey:k1' }, ['read-only']);
    requireApiKeyPermission('write')(req, res, next);
    expect(res.statusCode).toBe(403);
  });
  it('passes when the scope meets the minimum', () => {
    const { req, res, next } = ctx({ userId: 'apikey:k1' }, ['write']);
    requireApiKeyPermission('write')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
