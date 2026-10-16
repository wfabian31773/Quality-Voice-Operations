export const CUSTOMER_TENANT_PATHS = [
  '/dashboard',
  '/agents',
  '/calls',
  '/tickets',
  '/knowledge-base',
  '/phone-numbers',
  '/billing',
  '/settings',
  '/users',
] as const;

export const INTERNAL_TENANT_PATHS = [
  '/onboarding',
  '/workflows',
  '/campaigns',
  '/connectors',
  '/analytics',
  '/marketplace',
  '/trusted-callers',
  '/quality',
  '/audit-log',
  '/compliance',
  '/widget',
  '/developer',
  '/sms-inbox',
  '/scheduling',
  '/tickets/reporting',
  '/tickets/admin',
  '/dispatch',
  '/autopilot',
  '/changelog',
] as const;

export const PUBLIC_MARKETING_PATHS = [
  '/',
  '/pricing',
  '/demo',
  '/contact',
  '/industries/healthcare',
  '/industries/dental',
  '/case-studies',
  '/case-studies/:slug',
  '/book-demo',
  '/terms',
  '/privacy',
  '/security',
  '/security/posture',
  '/subprocessors',
] as const;

interface StaffIdentity {
  isPlatformAdmin?: boolean;
  role?: string;
}

/**
 * The current authentication contract has one explicit cross-tenant staff
 * signal: `isPlatformAdmin`. Tenant roles are customer roles, even when they
 * carry owner or manager privileges, so they must never unlock internal tools.
 */
export function isQvoStaff(user: StaffIdentity | null | undefined): boolean {
  return user?.isPlatformAdmin === true;
}

export function isInternalSurfacePath(pathname: string): boolean {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/$/, '') || '/';
  if (path === '/settings/api-keys') return true;
  if (/^\/agents\/[^/]+\/builder$/.test(path)) return true;
  return INTERNAL_TENANT_PATHS.some(
    (internalPath) => path === internalPath || path.startsWith(`${internalPath}/`),
  );
}
