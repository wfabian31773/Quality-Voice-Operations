/**
 * Shared role-label helpers used by the console shells.
 *
 * Before this lived here, the same `roleI18nKey` function was duplicated
 * verbatim across AdminLayout.tsx and OpsLayout.tsx — fixing a role name
 * in one didn't propagate to the other.
 *
 * The NavItem / NavGroup types are also shared so console pages can
 * declare their nav structure in a typed, consistent way.
 */
import type { ComponentType, SVGProps } from 'react';

export type NavIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface NavItem {
  to: string;
  icon: NavIcon;
  i18nKey: string;
  /**
   * When true, NavLink uses `end` so nested routes don't keep the parent
   * highlighted. Use for routes that have child paths (e.g. /admin/dashboard
   * shouldn't stay active when on /admin/dashboard/details).
   */
  exact?: boolean;
}

export interface NavGroup {
  i18nKey: string;
  items: NavItem[];
}

/**
 * Map a raw user role (and platform-admin flag) to the i18n key under
 * `admin_nav.role.*`. Keep this in sync with the locale files in
 * `client-app/src/locales/*/admin.json`.
 */
export function roleI18nKey(
  rawRole: string | undefined,
  isPlatformAdmin: boolean,
): string {
  if (isPlatformAdmin) return 'admin_nav.role.platform_admin';
  switch (rawRole) {
    case 'tenant_owner':
      return 'admin_nav.role.tenant_owner';
    case 'operations_manager':
      return 'admin_nav.role.operations_manager';
    case 'billing_admin':
      return 'admin_nav.role.billing_admin';
    case 'agent_developer':
      return 'admin_nav.role.agent_developer';
    case 'support_reviewer':
      return 'admin_nav.role.support_reviewer';
    default:
      return 'admin_nav.role.viewer';
  }
}
