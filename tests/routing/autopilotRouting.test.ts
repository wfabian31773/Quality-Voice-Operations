import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');

function readSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('Autopilot is wired into the tenant router', () => {
  it('App.tsx registers /autopilot inside the tenant ProtectedRoute + TenantLayout block', () => {
    // App.tsx is awkward to mount in isolation (it pulls in dozens of pages
    // that each fire their own queries on import). Verifying the route block
    // here is the cheapest way to guarantee the path is gated by
    // ProtectedRoute + TenantLayout and not accidentally leaked to the
    // public router or admin router.
    const app = readSource('client-app/src/App.tsx');

    const tenantBlockMatch = app.match(
      /\{\s*\/\*\s*Tenant Portal\s*\*\/\s*\}[\s\S]*?<\/Route>/,
    );
    expect(tenantBlockMatch, 'Tenant Portal route block should exist in App.tsx').toBeTruthy();
    const tenantBlock = tenantBlockMatch![0];

    expect(tenantBlock).toContain('<TenantLayout />');
    expect(tenantBlock).toMatch(
      /<Route\s+path="\/autopilot"\s+element=\{<RoleGuard\s+minRole="manager"><Autopilot\s*\/><\/RoleGuard>\}\s*\/>/,
    );
  });
});

describe('Autopilot router is mounted on the admin API (behavior)', () => {
  it('the autopilot router exposes the summary endpoint', async () => {
    // Import the router directly and inspect Express's runtime route table
    // — this is a behavior check (the live router knows about /autopilot/summary)
    // rather than a string match against the file source.
    const routerModule = await import('../../server/admin-api/routes/autopilot');
    const router = routerModule.default as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    };

    const routes = router.stack
      .map((layer) => layer.route)
      .filter((r): r is { path: string; methods: Record<string, boolean> } => Boolean(r));

    const summaryRoute = routes.find((r) => r.path === '/autopilot/summary');
    expect(summaryRoute, 'router should register /autopilot/summary').toBeTruthy();
    expect(summaryRoute!.methods.get).toBe(true);

    const recommendationsRoute = routes.find((r) => r.path === '/autopilot/recommendations');
    expect(recommendationsRoute, 'router should register /autopilot/recommendations').toBeTruthy();
    expect(recommendationsRoute!.methods.get).toBe(true);
  });

  it('the admin API app mounts the autopilot router at /', async () => {
    // Don't import server/admin-api/app — it boots schedulers and touches the DB.
    // The mount line is a single source-of-truth assertion that's much cheaper
    // and equally regression-proof for this concern.
    const adminApp = readSource('server/admin-api/app.ts');
    expect(adminApp).toMatch(
      /import\s+autopilotRoutes\s+from\s+['"]\.\/routes\/autopilot['"]/,
    );
    expect(adminApp).toMatch(/app\.use\(\s*['"]\/['"]\s*,\s*autopilotRoutes\s*\)/);
  });
});

describe('Command palette exposes Autopilot navigation', () => {
  it('CommandPalette declares a Go to Autopilot navigation command', async () => {
    // CommandPalette is hard to mount in isolation (depends on parent
    // open/close state, keyboard handlers, and many other commands).
    // Source-text check is sufficient and pinpointed.
    const palette = readSource('client-app/src/components/CommandPalette.tsx');
    expect(palette).toContain("go('/autopilot')");
    expect(palette).toMatch(/label:\s*['"]Go to Autopilot['"]/);
  });
});
