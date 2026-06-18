import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  requireRole, requirePlatformAdmin, requireMiniSystemWrite, requireOpsRole,
  getRoleLevel, dbRoleToSimple, simpleToDatabaseRole,
} from './rbac';

function ctx(user?: Partial<{ userId: string; tenantId: string; role: string; isPlatformAdmin: boolean }>) {
  const req = { user } as unknown as Request;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  const next = vi.fn();
  return { req, res: res as unknown as Response & { statusCode: number; body: unknown }, next: next as unknown as NextFunction & typeof next };
}

describe('pure role helpers', () => {
  it('maps role levels', () => {
    expect(getRoleLevel('tenant_owner')).toBe(4);
    expect(getRoleLevel('operations_manager')).toBe(3);
    expect(getRoleLevel('unknown')).toBe(0);
  });
  it('translates db roles to simple roles', () => {
    expect(dbRoleToSimple('tenant_owner')).toBe('owner');
    expect(dbRoleToSimple('operations_manager')).toBe('manager');
    expect(dbRoleToSimple('billing_admin')).toBe('manager');
    expect(dbRoleToSimple('agent_developer')).toBe('operator');
    expect(dbRoleToSimple('support_reviewer')).toBe('viewer');
  });
  it('translates simple roles to db roles', () => {
    expect(simpleToDatabaseRole('manager')).toBe('operations_manager');
    expect(simpleToDatabaseRole('owner')).toBe('tenant_owner');
  });
});

describe('requireRole', () => {
  it('401 without a user', () => {
    const { req, res, next } = ctx(undefined);
    requireRole('manager')(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it('403 when the role is too low', () => {
    const { req, res, next } = ctx({ role: 'support_reviewer' });
    requireRole('manager')(req, res, next);
    expect(res.statusCode).toBe(403);
  });
  it('passes when the role meets the minimum', () => {
    const { req, res, next } = ctx({ role: 'operations_manager' });
    requireRole('manager')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requirePlatformAdmin', () => {
  it('401 without a user', () => {
    const { req, res, next } = ctx(undefined);
    requirePlatformAdmin(req, res, next);
    expect(res.statusCode).toBe(401);
  });
  it('403 for a non-admin', () => {
    const { req, res, next } = ctx({ isPlatformAdmin: false });
    requirePlatformAdmin(req, res, next);
    expect(res.statusCode).toBe(403);
  });
  it('passes for a platform admin', () => {
    const { req, res, next } = ctx({ isPlatformAdmin: true });
    requirePlatformAdmin(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireMiniSystemWrite', () => {
  it('403 for a viewer', () => {
    const { req, res, next } = ctx({ role: 'support_reviewer' });
    requireMiniSystemWrite(req, res, next);
    expect(res.statusCode).toBe(403);
  });
  it('passes for an operations manager', () => {
    const { req, res, next } = ctx({ role: 'operations_manager' });
    requireMiniSystemWrite(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireOpsRole', () => {
  it('401 without a user', () => {
    const { req, res, next } = ctx(undefined);
    requireOpsRole(req, res, next);
    expect(res.statusCode).toBe(401);
  });
  it('lets a platform admin through regardless of role', () => {
    const { req, res, next } = ctx({ role: 'support_reviewer', isPlatformAdmin: true });
    requireOpsRole(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  it('403 for a non-ops role', () => {
    const { req, res, next } = ctx({ role: 'agent_developer', isPlatformAdmin: false });
    requireOpsRole(req, res, next);
    expect(res.statusCode).toBe(403);
  });
  it('passes for a tenant owner', () => {
    const { req, res, next } = ctx({ role: 'tenant_owner', isPlatformAdmin: false });
    requireOpsRole(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
