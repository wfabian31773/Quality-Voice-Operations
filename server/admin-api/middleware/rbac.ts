import type { Request, Response, NextFunction } from 'express';

export type TenantRole =
  | 'tenant_owner'
  | 'operations_manager'
  | 'billing_admin'
  | 'agent_developer'
  | 'support_reviewer';

export type SimpleRole = 'viewer' | 'operator' | 'manager' | 'owner';

const ROLE_HIERARCHY: Record<string, number> = {
  support_reviewer: 1,
  viewer: 1,
  agent_developer: 2,
  operator: 2,
  billing_admin: 3,
  operations_manager: 3,
  manager: 3,
  tenant_owner: 4,
  owner: 4,
};

const SIMPLE_TO_DB: Record<SimpleRole, TenantRole> = {
  viewer: 'support_reviewer',
  operator: 'agent_developer',
  manager: 'operations_manager',
  owner: 'tenant_owner',
};

export function dbRoleToSimple(dbRole: string): SimpleRole {
  if (dbRole === 'tenant_owner') return 'owner';
  if (dbRole === 'operations_manager' || dbRole === 'billing_admin') return 'manager';
  if (dbRole === 'agent_developer') return 'operator';
  return 'viewer';
}

export function simpleToDatabaseRole(simple: SimpleRole): TenantRole {
  return SIMPLE_TO_DB[simple];
}

export function getRoleLevel(role: string): number {
  return ROLE_HIERARCHY[role] ?? 0;
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

const MINI_SYSTEM_WRITE_ROLES = ['tenant_owner', 'operations_manager'];

export function requireMiniSystemWrite(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!MINI_SYSTEM_WRITE_ROLES.includes(req.user.role)) {
    res.status(403).json({ error: 'Owner or Manager role required for this action' });
    return;
  }
  next();
}

export function requireOpsRole(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (req.user.isPlatformAdmin) {
    next();
    return;
  }
  const opsRoles = ['tenant_owner', 'operations_manager'];
  if (!opsRoles.includes(req.user.role)) {
    res.status(403).json({ error: 'Operations access required' });
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
        error: `Insufficient permissions. Required: ${minimumRole}, current: ${dbRoleToSimple(req.user.role)}`,
      });
      return;
    }

    next();
  };
}
