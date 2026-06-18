import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../../platform/core/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

import { requireTenantContext } from './tenantGuard';

function ctx(opts: { user?: Record<string, unknown>; body?: unknown; query?: Record<string, unknown> }) {
  const req = { user: opts.user, body: opts.body, query: opts.query ?? {}, path: '/x' } as unknown as Request;
  const res = {
    statusCode: 0,
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
  };
  const next = vi.fn();
  return { req, res: res as unknown as Response & { statusCode: number }, next: next as unknown as NextFunction & typeof next };
}

describe('requireTenantContext', () => {
  it('401 without a user', () => {
    const { req, res, next } = ctx({});
    requireTenantContext(req, res, next);
    expect(res.statusCode).toBe(401);
  });
  it('403 when the user has no tenant', () => {
    const { req, res, next } = ctx({ user: { userId: 'u1' } });
    requireTenantContext(req, res, next);
    expect(res.statusCode).toBe(403);
  });
  it('passes for a normal in-tenant request', () => {
    const { req, res, next } = ctx({ user: { userId: 'u1', tenantId: 't1' } });
    requireTenantContext(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('blocks a cross-tenant body tenant_id', () => {
    const { req, res, next } = ctx({ user: { userId: 'u1', tenantId: 't1' }, body: { tenant_id: 't2' } });
    requireTenantContext(req, res, next);
    expect(res.statusCode).toBe(403);
  });
  it('allows a matching body tenantId', () => {
    const { req, res, next } = ctx({ user: { userId: 'u1', tenantId: 't1' }, body: { tenantId: 't1' } });
    requireTenantContext(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('blocks a cross-tenant query for a non-admin', () => {
    const { req, res, next } = ctx({ user: { userId: 'u1', tenantId: 't1', isPlatformAdmin: false }, query: { tenantId: 't2' } });
    requireTenantContext(req, res, next);
    expect(res.statusCode).toBe(403);
  });
  it('allows a cross-tenant query for a platform admin', () => {
    const { req, res, next } = ctx({ user: { userId: 'u1', tenantId: 't1', isPlatformAdmin: true }, query: { tenantId: 't2' } });
    requireTenantContext(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
