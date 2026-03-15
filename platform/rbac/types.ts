import type { TenantId } from '../core/types';

export type PlatformRole = 'platform_admin' | 'tenant_admin' | 'agent_manager' | 'viewer' | 'api_client';

export interface RbacUser {
  userId: string;
  tenantId: TenantId | null; // null = platform-level user
  role: PlatformRole;
  email: string;
  createdAt: Date;
}

export interface Permission {
  action: string;
  resource: string;
}

export const ROLE_PERMISSIONS: Record<PlatformRole, Permission[]> = {
  platform_admin: [{ action: '*', resource: '*' }],
  tenant_admin: [
    { action: '*', resource: 'agents' },
    { action: '*', resource: 'calls' },
    { action: '*', resource: 'billing' },
    { action: 'read', resource: 'analytics' },
  ],
  agent_manager: [
    { action: 'read', resource: 'agents' },
    { action: 'update', resource: 'agents' },
    { action: 'read', resource: 'calls' },
  ],
  viewer: [
    { action: 'read', resource: 'calls' },
    { action: 'read', resource: 'analytics' },
  ],
  api_client: [
    { action: 'create', resource: 'calls' },
    { action: 'read', resource: 'calls' },
  ],
};

export function hasPermission(role: PlatformRole, action: string, resource: string): boolean {
  const permissions = ROLE_PERMISSIONS[role] ?? [];
  return permissions.some(
    (p) =>
      (p.action === action || p.action === '*') &&
      (p.resource === resource || p.resource === '*'),
  );
}
