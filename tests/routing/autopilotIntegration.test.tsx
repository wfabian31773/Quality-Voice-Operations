// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

void React;

const fakeJwtPayload = {
  sub: 'user-test-1',
  tenantId: 'tenant-test-1',
  email: 'tester@example.com',
  role: 'manager',
  isPlatformAdmin: false,
  exp: Math.floor(Date.now() / 1000) + 60 * 60,
};

function makeFakeJwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
  return [
    b64(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    b64(JSON.stringify(payload)),
    'sig',
  ].join('.');
}

const fakeTenantStatus = {
  status: 'ready',
  phoneNumberCount: 1,
  tenantCreatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
};

const fetchHandlers: Record<string, unknown> = {
  '/tenants/me/provisioning-status': fakeTenantStatus,
  '/platform/changelog/unread-count': { count: 0 },
  '/call-saved-views/pinned': { views: [] },
  '/platform/notifications/unread-count': { count: 0 },
  '/platform/notifications': { notifications: [] },
  '/tenants/me/trial-status': { status: 'active', trialEndsAt: null },
  '/platform/maintenance': { enabled: false, message: null, scheduled_for: null },
  '/autopilot/summary': {
    totalInsights: 0,
    activeInsights: 0,
    totalRecommendations: 0,
    pendingRecommendations: 0,
    approvedRecommendations: 0,
    rejectedRecommendations: 0,
    executedActions: 0,
    totalRevenueImpactCents: 0,
    totalCostSavingsCents: 0,
    lastRunAt: null,
  },
  '/autopilot/insights': { insights: [], total: 0 },
  '/autopilot/recommendations': { recommendations: [], total: 0 },
  '/autopilot/actions': { actions: [], total: 0 },
  '/autopilot/runs': { runs: [] },
  '/autopilot/policies': { policies: [] },
  '/autopilot/notifications': { notifications: [], unreadCount: 0 },
  '/autopilot/industry-packs': { packs: [] },
  '/autopilot/impact-reports': { reports: [] },
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('auth_token', makeFakeJwt(fakeJwtPayload));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
      const matched = Object.keys(fetchHandlers).find((p) => path.startsWith(p));
      const body = matched ? fetchHandlers[matched] : {};
      return new Response(JSON.stringify(body), {
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

function AutopilotMarker() {
  return <div data-testid="autopilot-mounted">Autopilot route mounted</div>;
}

async function loadDeps() {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const TenantLayoutModule = await import(
    '../../client-app/src/components/TenantLayout'
  );
  const AutopilotModule = await import('../../client-app/src/pages/Autopilot');
  return {
    QueryClient,
    QueryClientProvider,
    TenantLayout: TenantLayoutModule.default,
    Autopilot: AutopilotModule.default,
  };
}

describe('Tenant sidebar → Autopilot integration', () => {
  it('mounts the real TenantLayout, shows the Autopilot sidebar link, and navigates to /autopilot on click', async () => {
    const { QueryClient, QueryClientProvider, TenantLayout } = await loadDeps();

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes>
            <Route element={<TenantLayout />}>
              <Route path="/dashboard" element={<div data-testid="dashboard">dashboard</div>} />
              <Route path="/autopilot" element={<AutopilotMarker />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const opsToggle = await waitFor(() =>
      screen.getByRole('button', { name: /Operations/ }),
    );
    fireEvent.click(opsToggle);

    const autopilotLink = await waitFor(() =>
      screen.getByRole('link', { name: 'Autopilot' }),
    );
    expect(autopilotLink.getAttribute('href')).toBe('/autopilot');

    fireEvent.click(autopilotLink);

    await waitFor(() => {
      expect(screen.getByTestId('autopilot-mounted')).toBeTruthy();
    });

    expect(screen.queryByTestId('dashboard')).toBeNull();
  });

  it('renders the real Autopilot page inside TenantLayout without crashing', async () => {
    const { QueryClient, QueryClientProvider, TenantLayout, Autopilot } = await loadDeps();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/autopilot']}>
          <Routes>
            <Route element={<TenantLayout />}>
              <Route path="/autopilot" element={<Autopilot />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('AI Business Autopilot')).toBeTruthy();
    });

    const fetchMock = (globalThis as { fetch: ReturnType<typeof vi.fn> }).fetch;
    const calledPaths = fetchMock.mock.calls.map(
      (call: unknown[]) => String(call[0]).replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '').split('?')[0],
    );
    expect(calledPaths).toContain('/autopilot/summary');

    const pageCrashErrors = consoleErrorSpy.mock.calls.filter(
      (args) => /uncaught|cannot read|crash/i.test(String(args[0])),
    );
    expect(pageCrashErrors).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });
});
