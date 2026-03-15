import type { Request, Response, NextFunction } from 'express';

export type TenantRole =
  | 'tenant_owner'
  | 'operations_manager'
  | 'billing_admin'
  | 'agent_developer'
  | 'support_reviewer';

export type SimpleRole = 'member' | 'admin' | 'owner';

const ROLE_HIERARCHY: Record<string, number> = {
  support_reviewer: 1,
  member: 1,
  agent_developer: 2,
  billing_admin: 2,
  operations_manager: 2,
  admin: 2,
  tenant_owner: 3,
  owner: 3,
};

const SIMPLE_TO_DB: Record<SimpleRole, TenantRole> = {
  member: 'support_reviewer',
  admin: 'operations_manager',
  owner: 'tenant_owner',
};

export function dbRoleToSimple(dbRole: string): SimpleRole {
  if (dbRole === 'tenant_owner') return 'owner';
  if (['operations_manager', 'billing_admin', 'agent_developer'].includes(dbRole)) return 'admin';
  return 'member';
}

export function simpleToDatabaseRole(simple: SimpleRole): TenantRole {
  return SIMPLE_TO_DB[simple];
}

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!req.user.isPlatformAdmin) {
    res.status(403).json({ error: 'Platform admin access required' });
    return;
  }
  next();
}

export function requireRole(minimumRole: SimpleRole) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userLevel = ROLE_HIERARCHY[req.user.role] ?? 0;
    const requiredLevel = ROLE_HIERARCHY[minimumRole] ?? 0;

    if (userLevel < requiredLevel) {
      res.status(403).json({
        error: `Insufficient permissions. Required: ${minimumRole}, current: ${req.user.role}`,
      });
      return;
    }

    next();
  };
}
