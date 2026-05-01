// @vitest-environment happy-dom
/**
 * Rendered-DOM coverage for the per-pitch recommendation funnel table on
 * `client-app/src/pages/PlatformAdmin.tsx`.
 *
 * The pitch dimension (tier-switch vs annual-only) on the recommendation
 * banner already has backend, webhook, and component-level type tests:
 *
 *   - tests/admin-api/billingRecommendationEvents.test.ts
 *   - tests/admin-api/billingRecommendationStatus.test.ts
 *   - tests/admin-api/billingRecommendationWebhook.test.ts
 *
 * What was missing was a check that a non-technical platform admin who
 * actually opens the dashboard sees the new "Funnel by pitch" table —
 * with both rows in a stable order and with the right impressions /
 * clicks / completed counts and savings. Without this test, a future
 * refactor that drops the `byPitch` block from
 * `RecommendationBreakdownPanel`, swaps the row ordering, or breaks
 * the i18n keys (`pitch_heading`, `pitch_tier_switch`, `pitch_annual_only`)
 * would only fail at type-check time — not in the rendered UI.
 *
 * The test mounts the real PlatformAdmin page against a mocked `api`
 * module that returns a non-empty `byPitch` array, clicks the
 * recommendation tile to expand the breakdown drawer, and asserts the
 * pitch table rows render in `[tier-switch, annual-only]` order with the
 * exact cell values an admin would see.
 */
import * as React from 'react';
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
  within,
} from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

void React;

// Hoisted `api` mock — same pattern as
// `tests/components/outageAlertDetailPanel.test.tsx`. Each test resets the
// implementation so the platform-admin page sees a deterministic response
// for `/platform/billing-recommendations`.
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('../../client-app/src/lib/api', () => ({
  api: apiMock,
  // PlatformAdmin transitively imports a few helpers that read the auth
  // token at module-evaluation time. Stub them so the import resolves
  // without touching real localStorage / JWT plumbing — request signing
  // is a no-op here because `api` is fully mocked.
  getToken: () => null,
  setToken: () => {},
}));

interface PitchRow {
  pitch: 'tier-switch' | 'annual-only';
  impressions: number;
  clicks: number;
  completedSwitches: number;
  monthlySavingsCents: number;
}

// Mirrors the `RecommendationStatsShape` interface in PlatformAdmin.tsx —
// the API returns flat top-level totals plus a handful of nested funnel
// breakdowns. The pitch table is the focus of this test, so the other
// segments use small but consistent placeholder numbers (zeros only where
// they wouldn't be a realistic 30d window).
function buildRecommendationStats(byPitch: PitchRow[]) {
  return {
    windowDays: 30,
    impressions: 100,
    clicks: 30,
    completedSwitches: 8,
    totalMonthlySavingsCents: 24_000,
    tenantsClicked: 20,
    tenantsSwitched: 5,
    clickThroughRate: 0.3,
    completionRate: 0.08,
    byRecommendedTier: [
      {
        recommendedTier: 'pro' as const,
        impressions: 70,
        clicks: 22,
        completedSwitches: 6,
        monthlySavingsCents: 18_000,
      },
      {
        recommendedTier: 'enterprise' as const,
        impressions: 30,
        clicks: 8,
        completedSwitches: 2,
        monthlySavingsCents: 6_000,
      },
    ],
    byPitch,
    byDirection: [
      {
        direction: 'upgrade' as const,
        impressions: 80,
        clicks: 25,
        completedSwitches: 6,
        monthlySavingsCents: 18_000,
      },
      {
        direction: 'downgrade' as const,
        impressions: 12,
        clicks: 3,
        completedSwitches: 2,
        monthlySavingsCents: 6_000,
      },
      {
        direction: 'lateral' as const,
        impressions: 8,
        clicks: 2,
        completedSwitches: 0,
        monthlySavingsCents: 0,
      },
    ],
    switchPairs: [],
    weeklyTrend: {
      windowWeeks: 8,
      weeks: [],
      byRecommendedTier: [],
    },
  };
}

function installApi(byPitch: PitchRow[]): void {
  apiMock.get.mockReset();
  apiMock.get.mockImplementation(async (path: string) => {
    if (path === '/platform/stats') {
      return {
        stats: {
          active_tenants: '5',
          total_tenants: '6',
          total_users: '42',
          total_calls: '1234',
          calls_last_30d: '789',
          calls_last_24h: '12',
          total_revenue_cents: '5000000',
          revenue_last_30d_cents: '500000',
        },
      };
    }
    if (path === '/support/replies/bounced-recipients/stats') {
      return { total: 0, last_7d: 0, last_30d: 0 };
    }
    if (path === '/platform/billing-recommendations') {
      return buildRecommendationStats(byPitch);
    }
    if (path === '/platform/billing-discount-events') {
      return {
        windowDays: 30,
        impressions: 0,
        clicks: 0,
        completedSwitches: 0,
        totalMonthlySavingsCents: 0,
        byCoupon: [],
      };
    }
    if (path === '/platform/tenants') {
      return { tenants: [] };
    }
    if (path.startsWith('/operations/alerts/summary')) {
      // OperationsAlertsBanner returns null when no alert categories
      // have a non-zero count, so the banner never renders in the test.
      return { counts: {} };
    }
    // Other tabs (templates, analytics, cost-monitoring, …) are gated on
    // their `enabled: activeTab === ...` flag, so no other endpoints
    // should be hit during this render. Keep a permissive empty default
    // so a future addition that fires an unrelated request on the
    // tenants tab doesn't make this file flaky.
    return {};
  });
}

async function renderPlatformAdmin(): Promise<{ client: QueryClient }> {
  // Defer imports so the per-file `vi.mock` calls above are honored, and
  // pre-load the `admin` namespace so `useTranslation('admin')` in
  // PlatformAdmin returns the real English copy on the first render
  // instead of the raw key strings.
  vi.resetModules();
  const i18nMod = await import('../../client-app/src/lib/i18n');
  await i18nMod.default.changeLanguage('en');
  await i18nMod.default.loadNamespaces(['admin', 'common', 'tenant']);

  const PlatformAdminMod = await import(
    '../../client-app/src/pages/PlatformAdmin'
  );
  const PlatformAdmin =
    PlatformAdminMod.default as React.ComponentType;

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  render(
    <I18nextProvider i18n={i18nMod.default}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/admin']}>
          <PlatformAdmin />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { client };
}

beforeEach(() => {
  installApi([
    {
      pitch: 'tier-switch',
      impressions: 60,
      clicks: 18,
      completedSwitches: 5,
      monthlySavingsCents: 15_000,
    },
    {
      pitch: 'annual-only',
      impressions: 40,
      clicks: 12,
      completedSwitches: 3,
      monthlySavingsCents: 9_000,
    },
  ]);
});

afterEach(() => {
  cleanup();
  apiMock.get.mockReset();
});

describe('PlatformAdmin recommendation pitch table (rendered DOM)', () => {
  it('renders the "Funnel by pitch" rows in [tier-switch, annual-only] order with the right cell values and i18n labels', async () => {
    await renderPlatformAdmin();

    // The recommendation tile uses an `onClick` so StatCard renders as a
    // <button>. The accessible name is the i18n label —
    // "Plan switches from banner (30d)" — which is what a non-technical
    // admin actually sees on the dashboard. We wait until it has a
    // resolved completedSwitches value (anything other than '...') so the
    // click happens after the recommendation query has resolved and the
    // breakdown panel has real data to render.
    const tile = await waitFor(() =>
      screen.getByRole('button', {
        name: /Plan switches from banner \(30d\)/i,
      }),
    );
    await waitFor(() => {
      expect(tile.textContent ?? '').not.toContain('...');
    });

    fireEvent.click(tile);

    // The drawer mounts via `aria-label` set to the panel title — same
    // English copy a sighted admin would scan for.
    const drawer = await waitFor(() =>
      screen.getByRole('region', {
        name: /Recommendation funnel by tier \(30d\)/i,
      }),
    );

    // Pitch heading is rendered above the pitch table — non-technical
    // admins navigate to it by reading "Funnel by pitch", so this is the
    // first thing to lock in.
    expect(within(drawer).getByText('Funnel by pitch')).toBeTruthy();

    // Both rows must mount, identified by the test ids the production
    // table tags onto each <tr>. Looking up via the component's own
    // testids keeps the assertion stable against className refactors.
    const tierSwitchRow = within(drawer).getByTestId(
      'recommendation-pitch-row-tier-switch',
    );
    const annualOnlyRow = within(drawer).getByTestId(
      'recommendation-pitch-row-annual-only',
    );

    // Order matters — the panel's `pitchOrder` array hard-codes
    // `tier-switch` first so the table doesn't shuffle as data changes.
    // `compareDocumentPosition` returns FOLLOWING when the second arg
    // appears after the first in document order.
    expect(
      tierSwitchRow.compareDocumentPosition(annualOnlyRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Per-row cell content. Each row renders 5 cells: [label, impressions,
    // clicks, completed, savings]. We assert on textContent so a stray
    // formatter swap (e.g. impressions getting locale-grouped or savings
    // dropping the dollar sign) surfaces here.
    const tierSwitchCells = within(tierSwitchRow).getAllByRole('cell');
    expect(tierSwitchCells).toHaveLength(5);
    expect(tierSwitchCells[0].textContent).toBe('Tier switch');
    expect(tierSwitchCells[1].textContent).toBe('60');
    expect(tierSwitchCells[2].textContent).toBe('18');
    expect(tierSwitchCells[3].textContent).toBe('5');
    expect(tierSwitchCells[4].textContent).toBe('$150.00');

    const annualOnlyCells = within(annualOnlyRow).getAllByRole('cell');
    expect(annualOnlyCells).toHaveLength(5);
    expect(annualOnlyCells[0].textContent).toBe('Annual billing');
    expect(annualOnlyCells[1].textContent).toBe('40');
    expect(annualOnlyCells[2].textContent).toBe('12');
    expect(annualOnlyCells[3].textContent).toBe('3');
    expect(annualOnlyCells[4].textContent).toBe('$90.00');

    // Defensive: only the two known pitches render. A regression that
    // accidentally added a third row from an unknown server-side pitch
    // value would surface here as a third matching testid.
    const allPitchRows = within(drawer).getAllByTestId(
      /^recommendation-pitch-row-/,
    );
    expect(allPitchRows).toHaveLength(2);
  });

  it('still renders both pitch rows in stable order when the API only returns the annual-only row (zero-fills the missing pitch)', async () => {
    // Force the server to return only `annual-only` in `byPitch`. The
    // panel's `pitchOrder.map(...)` is supposed to zero-fill any missing
    // pitch so the table never silently drops a row — without that
    // guarantee a non-technical admin would see one column of data and
    // wrongly conclude the tier-switch pitch was never shown.
    installApi([
      {
        pitch: 'annual-only',
        impressions: 25,
        clicks: 7,
        completedSwitches: 2,
        monthlySavingsCents: 6_000,
      },
    ]);

    await renderPlatformAdmin();

    const tile = await waitFor(() =>
      screen.getByRole('button', {
        name: /Plan switches from banner \(30d\)/i,
      }),
    );
    await waitFor(() => {
      expect(tile.textContent ?? '').not.toContain('...');
    });
    fireEvent.click(tile);

    const drawer = await waitFor(() =>
      screen.getByRole('region', {
        name: /Recommendation funnel by tier \(30d\)/i,
      }),
    );

    const tierSwitchRow = within(drawer).getByTestId(
      'recommendation-pitch-row-tier-switch',
    );
    const annualOnlyRow = within(drawer).getByTestId(
      'recommendation-pitch-row-annual-only',
    );

    // Tier-switch row was missing from the payload; the panel must
    // zero-fill it instead of dropping the row entirely.
    const tierSwitchCells = within(tierSwitchRow).getAllByRole('cell');
    expect(tierSwitchCells[0].textContent).toBe('Tier switch');
    expect(tierSwitchCells[1].textContent).toBe('0');
    expect(tierSwitchCells[2].textContent).toBe('0');
    expect(tierSwitchCells[3].textContent).toBe('0');
    expect(tierSwitchCells[4].textContent).toBe('$0.00');

    // Annual-only row keeps its real numbers …
    const annualOnlyCells = within(annualOnlyRow).getAllByRole('cell');
    expect(annualOnlyCells[0].textContent).toBe('Annual billing');
    expect(annualOnlyCells[1].textContent).toBe('25');
    expect(annualOnlyCells[2].textContent).toBe('7');
    expect(annualOnlyCells[3].textContent).toBe('2');
    expect(annualOnlyCells[4].textContent).toBe('$60.00');

    // …and the [tier-switch, annual-only] order is preserved even when
    // the missing row had to be synthesised.
    expect(
      tierSwitchRow.compareDocumentPosition(annualOnlyRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
