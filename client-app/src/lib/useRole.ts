import { useAuth } from './auth';

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

export function dbRoleToSimple(dbRole: string): SimpleRole {
  if (dbRole === 'tenant_owner') return 'owner';
  if (dbRole === 'operations_manager' || dbRole === 'billing_admin') return 'manager';
  if (dbRole === 'agent_developer') return 'operator';
  return 'viewer';
}

export function getRoleLevel(role: string): number {
  return ROLE_HIERARCHY[role] ?? 0;
}

export function hasMinRole(userRole: string, minimumRole: SimpleRole): boolean {
  return getRoleLevel(userRole) >= getRoleLevel(minimumRole);
}

export const ROLE_LABELS: Record<SimpleRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  operator: 'Operator',
  viewer: 'Viewer',
};

export interface RoleCapability {
  label: string;
  owner: boolean;
  manager: boolean;
  operator: boolean;
  viewer: boolean;
}

export const PERMISSIONS_MATRIX: RoleCapability[] = [
  { label: 'View Dashboard & Analytics', owner: true, manager: true, operator: true, viewer: true },
  { label: 'View Call History', owner: true, manager: true, operator: true, viewer: true },
  { label: 'View Agents', owner: true, manager: true, operator: true, viewer: true },
  { label: 'View Team Members', owner: true, manager: true, operator: true, viewer: true },
  { label: 'Edit Agents', owner: true, manager: true, operator: false, viewer: false },
  { label: 'Manage Phone Numbers', owner: true, manager: true, operator: false, viewer: false },
  { label: 'Manage Connectors', owner: true, manager: true, operator: false, viewer: false },
  { label: 'Manage Knowledge Base', owner: true, manager: true, operator: false, viewer: false },
  { label: 'Launch Campaigns', owner: true, manager: true, operator: false, viewer: false },
  { label: 'Manage Widget', owner: true, manager: true, operator: false, viewer: false },
  { label: 'View Billing', owner: true, manager: true, operator: false, viewer: false },
  { label: 'View Security & Compliance', owner: true, manager: true, operator: false, viewer: false },
  { label: 'Manage API Keys', owner: true, manager: true, operator: false, viewer: false },
  { label: 'Invite & Manage Users', owner: true, manager: false, operator: false, viewer: false },
  { label: 'Change User Roles', owner: true, manager: false, operator: false, viewer: false },
  { label: 'Edit Organization Settings', owner: true, manager: false, operator: false, viewer: false },
  { label: 'GDPR Data Erasure', owner: true, manager: false, operator: false, viewer: false },
  { label: 'Encryption Key Management', owner: true, manager: false, operator: false, viewer: false },
];

export function useRole() {
  const { user } = useAuth();
  const role = user?.role ?? 'viewer';
  const simpleRole = dbRoleToSimple(role);

  return {
    role: simpleRole,
    rawRole: role,
    isOwner: hasMinRole(role, 'owner'),
    isManager: hasMinRole(role, 'manager'),
    isOperator: hasMinRole(role, 'operator'),
    isViewer: hasMinRole(role, 'viewer'),
    hasMinRole: (min: SimpleRole) => hasMinRole(role, min),
    isPlatformAdmin: user?.isPlatformAdmin ?? false,
  };
}
