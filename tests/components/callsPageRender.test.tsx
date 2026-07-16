// @vitest-environment happy-dom
/**
 * Page-level integration coverage for `client-app/src/pages/Calls.tsx`.
 *
 * Background (task #1008): until the page's drag-and-drop pinned-views bar
 * was extracted into its own lazily-loaded subcomponent, importing
 * `Calls.tsx` from a vitest test file pulled in `@dnd-kit/core` from the
 * nested `client-app/node_modules`. dnd-kit then resolved a *second* React
 * copy and the page would explode at render time with the classic
 * "Invalid hook call" error. This test exists primarily to lock in that
 * regression: if anyone re-introduces a top-level dnd-kit import inside
 * `Calls.tsx`, this test starts failing again.
 *
 * It also lightly exercises the page in an empty-state shape: the call
 * list endpoint returns no rows, and we assert that the "No calls yet"
 * empty state renders. That gives us a real page-level integration foot
 * print to hang future tests off (filters, saved views, drag-to-reorder
 * pinned views, etc.) without each having to rebuild the rendering rig.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

function loginAs(role: string = 'owner') {
  localStorage.setItem(
    'auth_token',
    makeFakeJwt({
      sub: 'user-1',
      tenantId: 'tenant-1',
      email: 'owner@acme.test',
      role,
      isPlatformAdmin: false,
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    }),
  );
}

interface ApiHandlers {
  [pathPrefix: string]: () => unknown;
}

let handlers: ApiHandlers = {};

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; },
  });
  localStorage.clear();
  handlers = {
    '/auth/me': () => ({ user: { userId: 'user-1', email: 'owner@acme.test' } }),
    '/tenants/me': () => ({
      tenant: {
        id: 'tenant-1',
        name: 'Acme',
        slug: 'acme',
        plan: 'pro',
        status: 'active',
        billing_currency: 'usd',
      },
    }),
    '/call-saved-views': () => ({ views: [] }),
    '/agents': () => ({ agents: [{ id: 'agent-1', name: 'Default Agent' }] }),
    '/calls': () => ({ calls: [], total: 0 }),
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
      // Longest-prefix match so '/calls/<id>' doesn't accidentally answer
      // '/calls'. Sort handler keys by descending length.
      const prefixes = Object.keys(handlers).sort((a, b) => b.length - a.length);
      for (const prefix of prefixes) {
        if (path.startsWith(prefix)) {
          return new Response(JSON.stringify(handlers[prefix]()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
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
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function renderPage(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/calls']}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Calls page renders end-to-end (task #1008)', () => {
  it('mounts without React-duplication errors and shows the empty state', async () => {
    loginAs('owner');

    // Loading the page itself must not throw — historically it did, because
    // `Calls.tsx` pulled in `@dnd-kit/core` at the top level which dragged
    // in a second React copy and caused "Invalid hook call".
    vi.resetModules();
    const mod = await import('../../client-app/src/pages/Calls');
    const Calls = mod.default as React.ComponentType;

    renderPage(<Calls />);

    // Page header copy from `tenant.json -> calls.page_title`. i18n inside
    // the test runs in English-eager mode; we accept either the resolved
    // translation OR the raw key as a sanity floor in case the namespace
    // hasn't been loaded yet.
    await waitFor(() => {
      const headings = screen.getAllByRole('heading');
      const text = headings.map((h) => h.textContent ?? '').join('|');
      expect(text).toMatch(/Conversations|calls\.page_title/);
    });

    // The empty CTA only appears once `/calls` resolves — proves the page
    // got past its initial query without crashing.
    await waitFor(() => {
      expect(
        screen.getByText(/No calls (yet|match your filters)|calls\.empty\.no_calls_title/i),
      ).toBeTruthy();
    });
  });

  it('exposes CallDetailDrawer as a named export so it can be rendered in isolation', async () => {
    vi.resetModules();
    const mod = await import('../../client-app/src/pages/Calls');
    expect(typeof mod.CallDetailDrawer).toBe('function');
  });

  it('renders an actionable healthcare outcome in the focused call drawer', async () => {
    handlers = {
      '/calls/call-1/outcome': () => ({ projection: {
        callId: 'call-1', language: 'es', lifecycleState: 'CALL_COMPLETED', startedAt: null, endedAt: null,
        caller: { firstName: 'Ana', lastName: 'Lopez', phone: '+15555550100', type: 'patient', organizationName: null },
        patient: null, intent: 'Needs an annual eye exam',
        outcome: { type: 'appointment_request', summary: 'Appointment request; staff confirmation required.', requestedAction: 'Call back to arrange a time', urgency: 'routine', callbackPreference: 'weekday afternoons', identityVerificationStatus: 'partially_verified', consentToContact: true, evidenceSource: ['caller_statement'] },
        transcript: { available: true, lineCount: 2 }, recording: { policy: 'disabled', status: 'not_recorded', url: null },
        delivery: { id: 'out-1', status: 'sent', error: null, externalReference: null },
        followUp: { ticketId: 'ticket-1', ticketNumber: 17, ownerId: null, ownerLabel: 'Unassigned', priority: 'medium', status: 'open', nextAction: 'Call back to arrange a time' },
        tool: { id: 'tool-1', name: 'createServiceTicket', status: 'success', error: null, invokedAt: null, result: null },
        escalation: null, operationalValue: { state: 'staff_follow_up_created', evidence: 'A staff follow-up ticket was created.' },
      } }),
      '/calls/call-1/transcript': () => ({ transcript: [] }),
      '/calls/call-1/events': () => ({ events: [] }),
      '/calls/call-1': () => ({ call: { id: 'call-1', caller_number: '***', called_number: '***', direction: 'inbound', lifecycle_state: 'CALL_COMPLETED', start_time: '2026-07-12T10:00:00Z', end_time: '2026-07-12T10:03:00Z', agent_id: 'agent-1', agent_name: 'Healthcare Receptionist', duration_seconds: 180, language: 'es' }, costBreakdown: null }),
      '/tool-executions': () => ({ executions: [] }),
      '/tenants/me': () => ({ tenant: { billing_currency: 'usd' } }),
    };
    vi.resetModules();
    const { CallDetailDrawer } = await import('../../client-app/src/pages/Calls');
    renderPage(<CallDetailDrawer callId="call-1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /receptionist outcome/i })).toBeTruthy());
    expect(screen.getByRole('link', { name: /open follow-up ticket/i }).getAttribute('href')).toBe('/tickets/ticket-1');
    expect(screen.getByText(/not recorded/i)).toBeTruthy();
  });
});
