// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

void React;

function makeFakeJwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
  return [
    b64(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    b64(JSON.stringify(payload)),
    'sig',
  ].join('.');
}

function loginAs(opts: { isPlatformAdmin: boolean }) {
  localStorage.setItem(
    'auth_token',
    makeFakeJwt({
      sub: 'user-1',
      tenantId: 'tenant-1',
      email: opts.isPlatformAdmin ? 'admin@qvo.dev' : 'user@tenant.dev',
      role: opts.isPlatformAdmin ? 'admin' : 'manager',
      isPlatformAdmin: opts.isPlatformAdmin,
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    }),
  );
}

let maintenanceResponse: {
  enabled: boolean;
  message: string | null;
  scheduled_for: string | null;
} = { enabled: false, message: null, scheduled_for: null };

beforeEach(() => {
  localStorage.clear();
  maintenanceResponse = { enabled: false, message: null, scheduled_for: null };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
      if (path.startsWith('/platform/maintenance')) {
        return new Response(JSON.stringify(maintenanceResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function loadGate() {
  // Re-import auth so the module-level token snapshot picks up our localStorage
  vi.resetModules();
  const mod = await import('../../client-app/src/components/MaintenanceGate');
  return mod.default;
}

function Children() {
  return <div data-testid="protected">protected content</div>;
}

async function renderAt(path: string) {
  const Gate = await loadGate();
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <Gate>
        <Children />
      </Gate>
    </MemoryRouter>,
  );
  // Let the initial maintenance fetch resolve.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

describe('MaintenanceGate (BL-013)', () => {
  describe('with maintenance OFF', () => {
    it('renders children for tenant users without showing the banner', async () => {
      maintenanceResponse = { enabled: false, message: null, scheduled_for: null };
      loginAs({ isPlatformAdmin: false });

      await renderAt('/dashboard');

      await waitFor(() => expect(screen.getByTestId('protected')).toBeTruthy());
      expect(screen.queryByTestId('maintenance-status-banner')).toBeNull();
      expect(screen.queryByText(/QVO is briefly offline/i)).toBeNull();
    });
  });

  describe('first-paint race (fail-closed)', () => {
    it('does NOT leak protected content while /platform/maintenance is in flight for an authenticated tenant user', async () => {
      // Replace the global fetch with one whose maintenance call never resolves
      // synchronously. We resolve it manually after asserting the splash.
      let resolveMaint: ((v: unknown) => void) | null = null;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input.toString();
          const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
          if (path.startsWith('/platform/maintenance')) {
            return new Promise((resolve) => {
              resolveMaint = (body) =>
                resolve(
                  new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                  }),
                );
            });
          }
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }) as unknown as typeof fetch,
      );

      loginAs({ isPlatformAdmin: false });

      const Gate = await loadGate();
      render(
        <MemoryRouter initialEntries={['/dashboard']}>
          <Gate>
            <Children />
          </Gate>
        </MemoryRouter>,
      );

      // Before the /platform/maintenance call resolves, protected content
      // must NOT be rendered — the gate must hold a neutral splash.
      expect(screen.queryByTestId('protected')).toBeNull();
      expect(screen.getByTestId('maintenance-gate-loading')).toBeTruthy();

      // Now resolve the in-flight call with maintenance ENABLED. The gate
      // must transition to the full maintenance page, not to children.
      await act(async () => {
        resolveMaint!({ enabled: true, message: null, scheduled_for: null });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(screen.getByText(/QVO is briefly offline/i)).toBeTruthy(),
      );
      expect(screen.queryByTestId('protected')).toBeNull();
    });

    it('lets logged-out users render through immediately (no splash) — login is whitelisted anyway', async () => {
      // Don't log in. Stub a never-resolving maintenance fetch.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Promise(() => {}) as unknown as Response) as unknown as typeof fetch,
      );

      const Gate = await loadGate();
      render(
        <MemoryRouter initialEntries={['/login']}>
          <Gate>
            <Children />
          </Gate>
        </MemoryRouter>,
      );

      // Logged-out user on /login should NOT see the splash — login is
      // whitelisted, so we render straight through to children.
      expect(screen.getByTestId('protected')).toBeTruthy();
      expect(screen.queryByTestId('maintenance-gate-loading')).toBeNull();
    });
  });

  describe('with maintenance ON', () => {
    beforeEach(() => {
      maintenanceResponse = {
        enabled: true,
        message: 'Upgrading database — back in 10 minutes.',
        scheduled_for: null,
      };
    });

    it('shows the maintenance page to a tenant user on /dashboard', async () => {
      loginAs({ isPlatformAdmin: false });

      await renderAt('/dashboard');

      await waitFor(() =>
        expect(screen.getByText(/QVO is briefly offline/i)).toBeTruthy(),
      );
      expect(screen.queryByTestId('protected')).toBeNull();
      expect(screen.queryByTestId('maintenance-status-banner')).toBeNull();
    });

    it('lets a tenant user reach /login (whitelisted) and shows the status banner', async () => {
      loginAs({ isPlatformAdmin: false });

      await renderAt('/login');

      await waitFor(() => expect(screen.getByTestId('protected')).toBeTruthy());
      expect(screen.getByTestId('maintenance-status-banner')).toBeTruthy();
      expect(screen.queryByText(/QVO is briefly offline/i)).toBeNull();
    });

    it('lets a tenant user reach /healthz (whitelisted)', async () => {
      loginAs({ isPlatformAdmin: false });

      await renderAt('/healthz');

      await waitFor(() => expect(screen.getByTestId('protected')).toBeTruthy());
      expect(screen.queryByText(/QVO is briefly offline/i)).toBeNull();
    });

    it('lets a tenant user reach /accept-invite/abc (whitelisted prefix)', async () => {
      loginAs({ isPlatformAdmin: false });

      await renderAt('/accept-invite/abc-123');

      await waitFor(() => expect(screen.getByTestId('protected')).toBeTruthy());
    });

    it('lets ANY user reach /admin/* (whitelisted) so admins can recover access', async () => {
      // Even without an admin token (e.g. logged out), /admin/* must render
      // so the platform-admin guard / login prompt can take over.
      await renderAt('/admin/dashboard');

      await waitFor(() => expect(screen.getByTestId('protected')).toBeTruthy());
      expect(screen.getByTestId('maintenance-status-banner')).toBeTruthy();
      expect(screen.queryByText(/QVO is briefly offline/i)).toBeNull();
    });

    it('lets a platform admin through on a non-whitelisted path and shows the banner', async () => {
      loginAs({ isPlatformAdmin: true });

      await renderAt('/dashboard');

      await waitFor(() => expect(screen.getByTestId('protected')).toBeTruthy());
      expect(screen.getByTestId('maintenance-status-banner')).toBeTruthy();
      // Banner surfaces the operator-set message across all consoles.
      expect(
        screen.getByText(/Upgrading database — back in 10 minutes\./),
      ).toBeTruthy();
      expect(screen.queryByText(/QVO is briefly offline/i)).toBeNull();
    });

    it('does NOT match /admin-substring paths that are not actually under /admin/', async () => {
      // Defensive: a path like "/administrate" must NOT be whitelisted by
      // accident — only "/admin" exact and "/admin/*".
      loginAs({ isPlatformAdmin: false });

      await renderAt('/administrate-tenants');

      await waitFor(() =>
        expect(screen.getByText(/QVO is briefly offline/i)).toBeTruthy(),
      );
      expect(screen.queryByTestId('protected')).toBeNull();
    });
  });
});
