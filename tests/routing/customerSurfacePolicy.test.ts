import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CUSTOMER_TENANT_PATHS,
  INTERNAL_TENANT_PATHS,
  PUBLIC_MARKETING_PATHS,
  isInternalSurfacePath,
  isQvoStaff,
} from '../../client-app/src/lib/surfacePolicy';
import { extractPublicRoutePaths } from '../../scripts/check-sitemap-coverage.mjs';
import { STATIC_ROUTES } from '../../scripts/generate-sitemap.mjs';

const repoRoot = join(__dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

const hiddenPublicPaths = [
  '/product',
  '/product/federated-ingest',
  '/product/global-intelligence-network',
  '/features',
  '/ai-agents',
  '/use-cases',
  '/integrations',
  '/docs',
  '/signup',
  '/industries/vertical-agents',
  '/industries/legal',
  '/industries/real-estate',
  '/industries/home-services',
  '/blog',
  '/resources',
] as const;

describe('customer surface policy', () => {
  it('keeps the tenant portal focused on receptionist operations', () => {
    expect(CUSTOMER_TENANT_PATHS).toEqual([
      '/dashboard',
      '/calls',
      '/tickets',
      '/knowledge-base',
      '/phone-numbers',
      '/billing',
      '/settings',
      '/users',
    ]);
  });

  it('classifies generic platform modules as internal-only', () => {
    expect(INTERNAL_TENANT_PATHS).toEqual(expect.arrayContaining([
      '/onboarding',
      '/agents',
      '/workflows',
      '/campaigns',
      '/connectors',
      '/analytics',
      '/marketplace',
      '/developer',
      '/sms-inbox',
      '/scheduling',
      '/dispatch',
      '/autopilot',
    ]));
  });

  it('recognizes only platform admins as QVO staff in the current auth model', () => {
    expect(isQvoStaff({ isPlatformAdmin: true, role: 'support_reviewer' })).toBe(true);
    expect(isQvoStaff({ isPlatformAdmin: false, role: 'tenant_owner' })).toBe(false);
    expect(isQvoStaff({ isPlatformAdmin: false, role: 'operations_manager' })).toBe(false);
    expect(isQvoStaff({ isPlatformAdmin: false, role: 'agent_developer' })).toBe(false);
    expect(isQvoStaff(null)).toBe(false);
  });

  it('recognizes nested, query-string, and settings variants of internal routes', () => {
    expect(isInternalSurfacePath('/agents/agent-1/builder?tab=voice')).toBe(true);
    expect(isInternalSurfacePath('/marketplace/installed')).toBe(true);
    expect(isInternalSurfacePath('/settings/api-keys')).toBe(true);
    expect(isInternalSurfacePath('/calls?status=completed')).toBe(false);
    expect(isInternalSurfacePath('/settings/notifications')).toBe(false);
  });

  it('keeps only focused public routes in the marketing bundles', () => {
    const appPaths = extractPublicRoutePaths(readSource('client-app/src/App.tsx')) ?? [];
    const publicAppPaths = extractPublicRoutePaths(readSource('client-app/src/PublicApp.tsx')) ?? [];

    expect(appPaths).toEqual(publicAppPaths);
    expect(appPaths).toEqual(PUBLIC_MARKETING_PATHS);
    for (const path of hiddenPublicPaths) {
      expect(appPaths).not.toContain(path);
    }
  });

  it('keeps hidden public routes out of the sitemap', () => {
    const sitemapPaths = STATIC_ROUTES.map((route: { path: string }) => route.path);
    for (const path of hiddenPublicPaths) {
      expect(sitemapPaths).not.toContain(path);
    }
    const staticPublicPaths = PUBLIC_MARKETING_PATHS.filter((path) => !path.includes(':'));
    expect(sitemapPaths).toEqual(expect.arrayContaining(staticPublicPaths));
  });

  it('guards retained internal tenant routes with the platform-admin guard', () => {
    const app = readSource('client-app/src/App.tsx');
    expect(app).toContain('<PlatformAdminGuard>');
    expect(app).toMatch(/path="\/internal\/design-directions"[\s\S]*?<ProtectedRoute>[\s\S]*?<PlatformAdminGuard>/);
    const internalBlock = app.match(
      /<Route\s+element=\{<PlatformAdminGuard><Outlet\s*\/><\/PlatformAdminGuard>\}>([\s\S]*?)<\/Route>/,
    )?.[1];
    expect(internalBlock).toBeTruthy();
    expect(internalBlock).toContain('path="/autopilot"');
    expect(internalBlock).toContain('path="/developer"');
  });

  it('filters command-palette commands with the same staff policy', () => {
    const palette = readSource('client-app/src/components/CommandPalette.tsx');
    expect(palette).toContain('isQvoStaff(user)');
    expect(palette).toContain('internalOnly: true');
    expect(palette).toMatch(/commands\.filter\(\(command\) => isStaff \|\| !command\.internalOnly\)/);
  });
});
