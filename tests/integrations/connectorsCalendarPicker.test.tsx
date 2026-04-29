// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

void React;

const fakeJwtPayload = {
  sub: 'user-test-1',
  tenantId: 'tenant-test-1',
  email: 'tester@example.com',
  role: 'tenant_owner',
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

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

let capturedRequests: CapturedRequest[] = [];

function buildGoogleConnector() {
  return {
    integrationId: 'gcal-int-1',
    connectorType: 'scheduling',
    provider: 'google-calendar',
    name: 'Google Calendar',
    isEnabled: true,
    configKeys: ['client_id', 'client_secret', 'refresh_token', 'calendar_id'],
    lastSyncAt: null,
    lastSyncStatus: 'success',
    lastSyncError: null,
    lastSyncErrorAt: null,
  };
}

function buildOutlookConnector() {
  return {
    integrationId: 'outlook-int-1',
    connectorType: 'scheduling',
    provider: 'outlook-calendar',
    name: 'Outlook Calendar',
    isEnabled: true,
    configKeys: ['client_id', 'client_secret', 'refresh_token', 'calendar_id'],
    lastSyncAt: null,
    lastSyncStatus: 'success',
    lastSyncError: null,
    lastSyncErrorAt: null,
  };
}

const GOOGLE_CALENDARS = [
  { id: 'primary', name: 'tester@example.com', primary: true },
  { id: 'team-cal-id', name: 'Team appointments', primary: false },
  { id: 'sales-cal-id', name: 'Sales calls', primary: false },
];

const OUTLOOK_CALENDARS = [
  { id: 'AAA-default', name: 'Calendar', isDefault: true },
  { id: 'BBB-team', name: 'Team appointments', isDefault: false },
];

type FetchHandler = () => unknown;

function makeFetch(handlers: Record<string, FetchHandler>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input.toString();
    const path = rawUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const pathOnly = path.split('?')[0];
    const key = `${method} ${pathOnly}`;

    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    capturedRequests.push({ method, path: pathOnly, body });

    const handler = handlers[key];
    const data = handler ? handler() : {};
    return new Response(JSON.stringify(data ?? {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('auth_token', makeFakeJwt(fakeJwtPayload));
  capturedRequests = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function loadConnectorsModule() {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const ConnectorsModule = await import('../../client-app/src/pages/Connectors');
  return {
    QueryClient,
    QueryClientProvider,
    Connectors: ConnectorsModule.default,
  };
}

function renderConnectors(
  QueryClientProvider: any,
  QueryClient: any,
  Connectors: any,
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/connectors']}>
        <Connectors />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function getSelectByOptionText(text: string): HTMLSelectElement {
  const opt = screen.getByRole('option', { name: text }) as HTMLOptionElement;
  const select = opt.closest('select') as HTMLSelectElement | null;
  if (!select) throw new Error(`Could not find <select> ancestor for option "${text}"`);
  return select;
}

describe('Connectors calendar pickers', () => {
  it('loads Google calendars from the admin API and persists the chosen ID on submit', async () => {
    const handlers: Record<string, FetchHandler> = {
      'GET /connectors': () => ({
        connectors: [buildGoogleConnector()],
        total: 1,
        limit: 100,
        offset: 0,
      }),
      'GET /connectors/gcal-int-1/settings': () => ({
        provider: 'google-calendar',
        settings: {
          calendarId: 'team-cal-id',
          timezone: 'America/New_York',
          calendarLabel: 'Team appointments',
          calendarLookupError: null,
        },
      }),
      'GET /connectors/gcal-int-1/google-calendar/calendars': () => ({
        calendars: GOOGLE_CALENDARS,
      }),
      'POST /connectors': () => ({ integrationId: 'gcal-int-1' }),
    };
    vi.stubGlobal('fetch', makeFetch(handlers));

    const { QueryClient, QueryClientProvider, Connectors } = await loadConnectorsModule();
    renderConnectors(QueryClientProvider, QueryClient, Connectors);

    const manageButton = await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /Manage/i });
      expect(buttons.length).toBeGreaterThan(0);
      return buttons[0];
    });
    fireEvent.click(manageButton);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Reconnect Google Calendar/i }),
      ).toBeTruthy();
    });

    const calendarSelect = await waitFor(() =>
      getSelectByOptionText('Team appointments'),
    );
    expect(calendarSelect.value).toBe('team-cal-id');
    const optionTexts = Array.from(calendarSelect.options).map((o) => o.textContent);
    expect(optionTexts).toEqual(
      expect.arrayContaining([
        '— Primary calendar —',
        'tester@example.com (default)',
        'Team appointments',
        'Sales calls',
      ]),
    );

    fireEvent.change(calendarSelect, { target: { value: 'sales-cal-id' } });
    expect(calendarSelect.value).toBe('sales-cal-id');

    const submitButton = screen.getByRole('button', { name: /^Reconnect$/ });
    fireEvent.click(submitButton);

    const postRequest = await waitFor(() => {
      const req = capturedRequests.find(
        (r) => r.method === 'POST' && r.path === '/connectors',
      );
      expect(req).toBeTruthy();
      return req!;
    });

    const body = postRequest.body as {
      provider: string;
      credentials: Record<string, string>;
      credentialsToDelete?: string[];
    };
    expect(body.provider).toBe('google-calendar');
    expect(body.credentials.calendar_id).toBe('sales-cal-id');
    expect(body.credentialsToDelete ?? []).not.toContain('calendar_id');

    expect(
      capturedRequests.some(
        (r) =>
          r.method === 'GET' &&
          r.path === '/connectors/gcal-int-1/google-calendar/calendars',
      ),
    ).toBe(true);
  });

  it('loads Outlook calendars and clearing the picker queues a credential deletion on submit', async () => {
    const handlers: Record<string, FetchHandler> = {
      'GET /connectors': () => ({
        connectors: [buildOutlookConnector()],
        total: 1,
        limit: 100,
        offset: 0,
      }),
      'GET /connectors/outlook-int-1/settings': () => ({
        provider: 'outlook-calendar',
        settings: {
          calendarId: 'BBB-team',
          timezone: 'America/New_York',
          calendarLabel: 'Team appointments',
          calendarLookupError: null,
        },
      }),
      'GET /connectors/outlook-int-1/outlook-calendar/calendars': () => ({
        calendars: OUTLOOK_CALENDARS,
      }),
      'POST /connectors': () => ({ integrationId: 'outlook-int-1' }),
    };
    vi.stubGlobal('fetch', makeFetch(handlers));

    const { QueryClient, QueryClientProvider, Connectors } = await loadConnectorsModule();
    renderConnectors(QueryClientProvider, QueryClient, Connectors);

    const manageButton = await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /Manage/i });
      expect(buttons.length).toBeGreaterThan(0);
      return buttons[0];
    });
    fireEvent.click(manageButton);

    const calendarSelect = await waitFor(() =>
      getSelectByOptionText('Team appointments'),
    );
    expect(calendarSelect.value).toBe('BBB-team');
    const optionTexts = Array.from(calendarSelect.options).map((o) => o.textContent);
    expect(optionTexts).toEqual(
      expect.arrayContaining([
        '— Default calendar —',
        'Calendar (default)',
        'Team appointments',
      ]),
    );

    fireEvent.change(calendarSelect, { target: { value: '' } });
    expect(calendarSelect.value).toBe('');

    const submitButton = screen.getByRole('button', { name: /^Reconnect$/ });
    fireEvent.click(submitButton);

    const postRequest = await waitFor(() => {
      const req = capturedRequests.find(
        (r) => r.method === 'POST' && r.path === '/connectors',
      );
      expect(req).toBeTruthy();
      return req!;
    });

    const body = postRequest.body as {
      provider: string;
      credentials: Record<string, string>;
      credentialsToDelete?: string[];
    };
    expect(body.provider).toBe('outlook-calendar');
    expect(body.credentials.calendar_id).toBeUndefined();
    expect(body.credentialsToDelete ?? []).toContain('calendar_id');
  });

  it('shows the calendar dropdown immediately after OAuth on a brand-new Google Calendar connection (Task #927)', async () => {
    // Initially no connectors exist — the user sees "Connect Google Calendar".
    // After the OAuth popup posts `oauth_complete`, the connectors query is
    // invalidated and the next GET returns the freshly-saved connector. The
    // modal must stay open and load the calendar dropdown without forcing the
    // admin through a save→reopen cycle.
    let connectorsExist = false;
    const handlers: Record<string, FetchHandler> = {
      'GET /connectors': () => ({
        connectors: connectorsExist ? [buildGoogleConnector()] : [],
        total: connectorsExist ? 1 : 0,
        limit: 100,
        offset: 0,
      }),
      'GET /connectors/oauth/availability': () => ({
        providers: { google: { available: true, providerLabel: 'Google' } },
      }),
      'GET /connectors/gcal-int-1/settings': () => ({
        provider: 'google-calendar',
        settings: {
          calendarId: null,
          timezone: 'America/New_York',
          calendarLabel: null,
          calendarLookupError: null,
        },
      }),
      'GET /connectors/gcal-int-1/google-calendar/calendars': () => ({
        calendars: GOOGLE_CALENDARS,
      }),
      'POST /connectors': () => ({ integrationId: 'gcal-int-1' }),
    };
    vi.stubGlobal('fetch', makeFetch(handlers));

    const { QueryClient, QueryClientProvider, Connectors } = await loadConnectorsModule();
    renderConnectors(QueryClientProvider, QueryClient, Connectors);

    // Click the suggested-first "Connect Google Calendar" tile to open the
    // modal (the modal is not yet open).
    const tileButton = await waitFor(() =>
      screen.getByRole('button', { name: /Connect Google Calendar/i }),
    );
    fireEvent.click(tileButton);

    // Modal opens in "Connect" mode (the Reconnect copy must not flip after
    // OAuth completes, so the dialog header stays as "Connect Google Calendar").
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Connect Google Calendar/i }),
      ).toBeTruthy();
    });

    // Simulate the OAuth popup posting back `oauth_complete`. Flip the GET
    // /connectors mock to start returning the freshly-saved connector so the
    // invalidate+refetch picks it up.
    connectorsExist = true;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'oauth_complete', provider: 'google-calendar' },
        origin: window.location.origin,
      }),
    );

    // The "loading your calendars" interstitial appears while the connectors
    // query is refetching.
    await waitFor(() => {
      expect(
        screen.getByText(/Google Calendar connected\. Loading your calendars…/i),
      ).toBeTruthy();
    });

    // Once the refetch lands, the calendar dropdown is rendered and populated
    // from the GET /connectors/:id/google-calendar/calendars endpoint.
    const calendarSelect = await waitFor(() =>
      getSelectByOptionText('Team appointments'),
    );

    // Default selection is "primary" (no calendar_id saved yet).
    expect(calendarSelect.value).toBe('');

    // Pick a non-default calendar and save.
    fireEvent.change(calendarSelect, { target: { value: 'sales-cal-id' } });
    expect(calendarSelect.value).toBe('sales-cal-id');

    // Header still says "Connect" (frozen at modal open) — the button label
    // becomes "Save calendar" once the freshly-saved connector lands.
    const saveButton = await waitFor(() =>
      screen.getByRole('button', { name: /Save calendar/i }),
    );
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveButton);

    const postRequest = await waitFor(() => {
      const req = capturedRequests.find(
        (r) => r.method === 'POST' && r.path === '/connectors',
      );
      expect(req).toBeTruthy();
      return req!;
    });

    const body = postRequest.body as {
      provider: string;
      credentials: Record<string, string>;
    };
    expect(body.provider).toBe('google-calendar');
    expect(body.credentials.calendar_id).toBe('sales-cal-id');
    // The OAuth-supplied tokens must not be touched by this save (the
    // calendar-only save must not overwrite client_id/client_secret/
    // refresh_token, which the OAuth callback already persisted).
    expect(body.credentials.client_id).toBeUndefined();
    expect(body.credentials.client_secret).toBeUndefined();
    expect(body.credentials.refresh_token).toBeUndefined();

    // The calendars endpoint was hit at least once after OAuth completed.
    expect(
      capturedRequests.some(
        (r) =>
          r.method === 'GET' &&
          r.path === '/connectors/gcal-int-1/google-calendar/calendars',
      ),
    ).toBe(true);
  });

  it('shows the calendar dropdown immediately after OAuth on a brand-new Outlook Calendar connection (Task #927)', async () => {
    // Outlook parity for the Google first-run OAuth test above. Same flow:
    // no connector initially, OAuth popup posts `oauth_complete`, the
    // connectors query is invalidated, and the modal stays open to let the
    // admin pick a calendar from the dropdown.
    let connectorsExist = false;
    const handlers: Record<string, FetchHandler> = {
      'GET /connectors': () => ({
        connectors: connectorsExist ? [buildOutlookConnector()] : [],
        total: connectorsExist ? 1 : 0,
        limit: 100,
        offset: 0,
      }),
      'GET /connectors/oauth/availability': () => ({
        providers: { outlook: { available: true, providerLabel: 'Outlook' } },
      }),
      'GET /connectors/outlook-int-1/settings': () => ({
        provider: 'outlook-calendar',
        settings: {
          calendarId: null,
          timezone: 'America/New_York',
          calendarLabel: null,
          calendarLookupError: null,
        },
      }),
      'GET /connectors/outlook-int-1/outlook-calendar/calendars': () => ({
        calendars: OUTLOOK_CALENDARS,
      }),
      'POST /connectors': () => ({ integrationId: 'outlook-int-1' }),
    };
    vi.stubGlobal('fetch', makeFetch(handlers));

    const { QueryClient, QueryClientProvider, Connectors } = await loadConnectorsModule();
    renderConnectors(QueryClientProvider, QueryClient, Connectors);

    // Outlook Calendar isn't in SUGGESTED_FIRST, so click the inline tile
    // "Connect" button on the Available list. The tile root carries
    // `data-provider="outlook-calendar"`, so scope the button lookup to it.
    const tile = await waitFor(() => {
      const el = document.querySelector('[data-provider="outlook-calendar"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const tileConnect = Array.from(tile.querySelectorAll('button')).find(
      (b) => /^Connect$/.test((b.textContent ?? '').trim()),
    );
    expect(tileConnect).toBeTruthy();
    fireEvent.click(tileConnect!);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Connect Outlook Calendar/i }),
      ).toBeTruthy();
    });

    connectorsExist = true;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'oauth_complete', provider: 'outlook-calendar' },
        origin: window.location.origin,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Outlook Calendar connected\. Loading your calendars…/i),
      ).toBeTruthy();
    });

    const calendarSelect = await waitFor(() =>
      getSelectByOptionText('Team appointments'),
    );
    fireEvent.change(calendarSelect, { target: { value: 'BBB-team' } });
    expect(calendarSelect.value).toBe('BBB-team');

    const saveButton = await waitFor(() =>
      screen.getByRole('button', { name: /Save calendar/i }),
    );
    fireEvent.click(saveButton);

    const postRequest = await waitFor(() => {
      const req = capturedRequests.find(
        (r) => r.method === 'POST' && r.path === '/connectors',
      );
      expect(req).toBeTruthy();
      return req!;
    });
    const body = postRequest.body as {
      provider: string;
      credentials: Record<string, string>;
    };
    expect(body.provider).toBe('outlook-calendar');
    expect(body.credentials.calendar_id).toBe('BBB-team');
    expect(body.credentials.client_id).toBeUndefined();
    expect(body.credentials.client_secret).toBeUndefined();
    expect(body.credentials.refresh_token).toBeUndefined();

    expect(
      capturedRequests.some(
        (r) =>
          r.method === 'GET' &&
          r.path === '/connectors/outlook-int-1/outlook-calendar/calendars',
      ),
    ).toBe(true);
  });

  it('falls back to the legacy text input when the calendar list lookup fails', async () => {
    const handlers: Record<string, FetchHandler> = {
      'GET /connectors': () => ({
        connectors: [buildGoogleConnector()],
        total: 1,
        limit: 100,
        offset: 0,
      }),
      'GET /connectors/gcal-int-1/settings': () => ({
        provider: 'google-calendar',
        settings: {
          calendarId: 'legacy-id-from-google',
          timezone: 'America/New_York',
          calendarLabel: null,
          calendarLookupError: 'token expired',
        },
      }),
      'POST /connectors': () => ({ integrationId: 'gcal-int-1' }),
    };
    const errorFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === 'string' ? input : input.toString();
      const path = rawUrl.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
      const method = (init?.method ?? 'GET').toUpperCase();
      const pathOnly = path.split('?')[0];
      const key = `${method} ${pathOnly}`;

      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      capturedRequests.push({ method, path: pathOnly, body });

      if (pathOnly === '/connectors/gcal-int-1/google-calendar/calendars') {
        return new Response(JSON.stringify({ error: 'token expired' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const handler = handlers[key];
      const data = handler ? handler() : {};
      return new Response(JSON.stringify(data ?? {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', errorFetch);

    const { QueryClient, QueryClientProvider, Connectors } = await loadConnectorsModule();
    renderConnectors(QueryClientProvider, QueryClient, Connectors);

    const manageButton = await waitFor(() => {
      const buttons = screen.getAllByRole('button', { name: /Manage/i });
      expect(buttons.length).toBeGreaterThan(0);
      return buttons[0];
    });
    fireEvent.click(manageButton);

    await waitFor(() => {
      expect(screen.getByText(/Could not load calendars/i)).toBeTruthy();
    });

    const fallback = await waitFor(() => {
      const inputs = Array.from(
        document.querySelectorAll('input[placeholder="primary"]'),
      ) as HTMLInputElement[];
      expect(inputs.length).toBeGreaterThan(0);
      return inputs[0];
    });
    expect(fallback.value).toBe('legacy-id-from-google');

    fireEvent.change(fallback, { target: { value: 'manually-typed-id' } });

    const submitButton = screen.getByRole('button', { name: /^Reconnect$/ });
    fireEvent.click(submitButton);

    const postRequest = await waitFor(() => {
      const req = capturedRequests.find(
        (r) => r.method === 'POST' && r.path === '/connectors',
      );
      expect(req).toBeTruthy();
      return req!;
    });

    const body = postRequest.body as {
      credentials: Record<string, string>;
    };
    expect(body.credentials.calendar_id).toBe('manually-typed-id');
  });
});
