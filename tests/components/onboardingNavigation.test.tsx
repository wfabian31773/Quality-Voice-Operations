// @vitest-environment happy-dom
/**
 * Regression coverage for the three navigation paths the onboarding wizard
 * (`client-app/src/pages/Onboarding.tsx`) now supports between its three
 * steps:
 *
 *   1. Continue (forward, via `advanceTo`).
 *   2. Back (via `goBack`).
 *   3. Clicking a previously-visited progress dot (via `goToStep`).
 *
 * The wizard also persists the current step to the server through
 * `PATCH /me/preferences` so that `GET /me/preferences` on the next page
 * load can resume the user where they left off (see BL-042 prefs endpoints
 * in `tests/admin-api/userPreferences.test.ts`).
 *
 * The task that owns this file (#906) calls for a "Playwright/e2e test"
 * but explicitly requires that it "runs in CI alongside the rest of the
 * suite". The standalone Playwright runners in `tests/e2e/*.spec.ts`
 * require a live `Platform Dev` workflow + a seeded admin and are NOT
 * wired into `npm test`, so we instead exercise the wizard at the
 * component level with happy-dom + React Testing Library against a mocked
 * `api` module. This:
 *
 *   - Renders the real `Onboarding.tsx` page, so any future change that
 *     breaks `goBack` / `goToStep` / `persistStep` fails this test.
 *   - Drives the same DOM the user sees (Back button, progress dots),
 *     including aria-labels, so a regression that switches a clickable
 *     dot back to a static <div> is caught.
 *   - Verifies the persistence contract by asserting the PATCH bodies
 *     and re-mounting the wizard with the saved step to simulate the
 *     "refresh resumes on the same step" behaviour.
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
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

void React;

// The wizard pulls a tenant primary language for industry-template copy.
// That hook depends on `useAuth` and tanstack-query plumbing we don't
// care about here, so stub it out with a fixed value.
vi.mock('../../client-app/src/hooks/useTenantPrimaryLanguage', () => ({
  useTenantPrimaryLanguage: () => 'en',
}));

// Shared `api` mock — `prefs` is mutated by PATCH calls so subsequent
// GETs (and a re-mount, simulating a browser refresh) see the latest
// persisted state. Uses `vi.hoisted` so the mock factory below (which
// vitest hoists to the top of the file) can still reach the same
// vi.fn() instances we assert against in each test.
const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
let prefs: Record<string, unknown> = {};
vi.mock('../../client-app/src/lib/api', () => ({
  api: apiMock,
}));

// Imported AFTER the mocks above so it picks them up.
import Onboarding from '../../client-app/src/pages/Onboarding';

function installDefaultApi(initialPrefs: Record<string, unknown> = {}): void {
  prefs = { ...initialPrefs };
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.patch.mockReset();

  apiMock.get.mockImplementation(async (path: string) => {
    if (path === '/me/preferences') {
      return { preferences: { ...prefs } };
    }
    if (path === '/agents') {
      return { agents: [{ id: 'agent-1', type: 'answering-service' }] };
    }
    if (path === '/tenants/me/provisioning-status') {
      return { status: 'ready', agentCount: 1, phoneNumberCount: 0 };
    }
    return {};
  });

  apiMock.patch.mockImplementation(async (path: string, body: unknown) => {
    if (path === '/me/preferences' && body && typeof body === 'object') {
      prefs = { ...prefs, ...(body as Record<string, unknown>) };
      return { preferences: { ...prefs } };
    }
    return {};
  });

  apiMock.post.mockImplementation(async () => ({ status: 'ready' }));
}

function renderOnboarding() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/onboarding']}>
        <Onboarding />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The wizard renders each progress dot's accessible name as
// `Go to step N: <Label>` (e.g. "Go to step 1: Setup"). Use a regex
// anchored on the step number so the test stays robust to copy
// changes in the per-step label text.
function getDot(stepNumber: number): HTMLElement {
  return screen.getByRole('button', {
    name: new RegExp(`^Go to step ${stepNumber}:`, 'i'),
  });
}

function queryDot(stepNumber: number): HTMLElement | null {
  return screen.queryByRole('button', {
    name: new RegExp(`^Go to step ${stepNumber}:`, 'i'),
  });
}

function patchedSteps(): number[] {
  return apiMock.patch.mock.calls
    .filter(([path]) => path === '/me/preferences')
    .map(([, body]) => (body as { onboarding_step?: number }).onboarding_step ?? -1);
}

beforeEach(() => {
  installDefaultApi({});
});

afterEach(() => {
  cleanup();
});

describe('Onboarding wizard navigation', () => {
  it('moves forward from step 2 to step 3 via the Continue button and persists the advance', async () => {
    // Resume directly at step 2 (template picker). The default
    // template (`answering-service`) short-circuits the agent PATCH and
    // calls `advanceTo(3)` synchronously, so we exercise the third
    // navigation mechanism — Continue — without depending on the agent
    // update path.
    installDefaultApi({ onboarding_step: 2 });

    renderOnboarding();

    await waitFor(() =>
      expect(screen.getByText(/Choose Your Agent Template/i)).toBeTruthy(),
    );

    const continueButton = screen.getByRole('button', { name: /^Continue/i });
    fireEvent.click(continueButton);

    await waitFor(() =>
      expect(screen.getByText(/Add Your First Phone Number/i)).toBeTruthy(),
    );

    // Advancing to step 3 must be persisted so a refresh resumes there.
    await waitFor(() => {
      expect(patchedSteps()).toContain(3);
    });
  });

  it('lets the user click Back from step 2 to return to step 1 and persists the move', async () => {
    // Resume directly at step 2 — that bypasses the provisioning poll
    // and lands the user on the template-picker screen the way the task
    // description requires ("reaches step 2 of the onboarding wizard").
    installDefaultApi({ onboarding_step: 2 });

    renderOnboarding();

    await waitFor(() =>
      expect(screen.getByText(/Choose Your Agent Template/i)).toBeTruthy(),
    );

    const backButton = screen.getByRole('button', { name: /^Back$/i });
    fireEvent.click(backButton);

    // Once we're back on step 1, the page swaps to the
    // "Setting Up Your Environment" headline.
    await waitFor(() =>
      expect(screen.getByText(/Setting Up Your Environment/i)).toBeTruthy(),
    );

    // The persisted step must be 1 so that a refresh resumes there.
    await waitFor(() => {
      expect(patchedSteps()).toContain(1);
    });
  });

  it('makes the previously-visited step-1 dot clickable from step 2 and jumps back when clicked', async () => {
    installDefaultApi({ onboarding_step: 2 });
    renderOnboarding();

    await waitFor(() =>
      expect(screen.getByText(/Choose Your Agent Template/i)).toBeTruthy(),
    );

    // The step-1 dot must be a real <button> so it's interactive,
    // and clicking it must drop the wizard back to step 1.
    const stepOneDot = getDot(1);
    expect(stepOneDot.tagName).toBe('BUTTON');

    fireEvent.click(stepOneDot);

    await waitFor(() =>
      expect(screen.getByText(/Setting Up Your Environment/i)).toBeTruthy(),
    );

    await waitFor(() => {
      expect(patchedSteps()).toContain(1);
    });
  });

  it('keeps the step-3 dot non-interactive while the user is still at step 2', async () => {
    installDefaultApi({ onboarding_step: 2 });
    renderOnboarding();

    await waitFor(() =>
      expect(screen.getByText(/Choose Your Agent Template/i)).toBeTruthy(),
    );

    // A dot the user hasn't unlocked yet renders as a plain <div>
    // (no role=button, no click target). If a future refactor turns it
    // into a button we want this test to scream so we don't quietly let
    // users skip past required confirmations.
    expect(queryDot(3)).toBeNull();

    // Sanity: the step-2 dot (current) IS interactive but also disabled.
    const stepTwoDot = getDot(2);
    expect(stepTwoDot.tagName).toBe('BUTTON');
    expect((stepTwoDot as HTMLButtonElement).disabled).toBe(true);
    expect(stepTwoDot.getAttribute('aria-current')).toBe('step');

    // Confirm no spurious PATCHes happened just by rendering at step 2.
    // (The persistedStepRef short-circuits a redundant save.)
    expect(patchedSteps()).not.toContain(3);
  });

  it('persists the navigated-to step so a refresh lands on the same step', async () => {
    // First mount: user resumes at step 2, then clicks Back to step 1.
    installDefaultApi({ onboarding_step: 2 });
    const { unmount } = renderOnboarding();

    await waitFor(() =>
      expect(screen.getByText(/Choose Your Agent Template/i)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: /^Back$/i }));

    await waitFor(() =>
      expect(screen.getByText(/Setting Up Your Environment/i)).toBeTruthy(),
    );

    // Persistence call MUST have written step=1, otherwise a refresh
    // wouldn't be able to honour the user's navigation.
    await waitFor(() => {
      expect(prefs.onboarding_step).toBe(1);
    });

    // Simulate a full browser refresh: tear the component down and
    // mount a fresh copy. The mocked GET /me/preferences now returns
    // the persisted step, so the wizard should land on step 1, not
    // jump back to the original resume target of step 2.
    unmount();
    apiMock.get.mockClear();
    apiMock.patch.mockClear();

    renderOnboarding();

    await waitFor(() =>
      expect(screen.getByText(/Setting Up Your Environment/i)).toBeTruthy(),
    );

    // And `/me/preferences` was actually consulted on resume — so this
    // really does prove the GET → state pipeline, not just the default
    // step-1 starting state.
    expect(
      apiMock.get.mock.calls.some(([path]) => path === '/me/preferences'),
    ).toBe(true);
  });
});
