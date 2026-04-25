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

function buildHubspotConnector() {
  return {
    integrationId: 'hubspot-int-1',
    connectorType: 'crm',
    provider: 'hubspot',
    name: 'HubSpot',
    isEnabled: true,
    configKeys: ['access_token', 'appointment_pipeline_id', 'appointment_stage_id'],
    lastSyncAt: null,
    lastSyncStatus: 'success',
    lastSyncError: null,
    lastSyncErrorAt: null,
  };
}

function buildPipedriveConnector() {
  return {
    integrationId: 'pipedrive-int-1',
    connectorType: 'crm',
    provider: 'pipedrive',
    name: 'Pipedrive',
    isEnabled: true,
    configKeys: [
      'api_token',
      'default_pipeline_id',
      'default_stage_id',
      'appointment_stage_id',
    ],
    lastSyncAt: null,
    lastSyncStatus: 'success',
    lastSyncError: null,
    lastSyncErrorAt: null,
  };
}

const HUBSPOT_PIPELINES = [
  {
    id: 'sales-pipeline',
    label: 'Sales pipeline',
    stages: [
      { id: 'sales-discovery', label: 'Discovery' },
      { id: 'sales-meeting-booked', label: 'Meeting Booked' },
    ],
  },
  {
    id: 'enterprise-pipeline',
    label: 'Enterprise pipeline',
    stages: [
      { id: 'ent-intro', label: 'Intro Call' },
      { id: 'ent-demo-scheduled', label: 'Demo Scheduled' },
    ],
  },
];

const PIPEDRIVE_PIPELINES = [
  {
    id: 7,
    name: 'Inbound deals',
    stages: [
      { id: 71, name: 'Lead in' },
      { id: 72, name: 'Demo scheduled' },
    ],
  },
  {
    id: 8,
    name: 'Outbound deals',
    stages: [
      { id: 81, name: 'Cold reach' },
      { id: 82, name: 'Meeting booked' },
    ],
  },
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

function getAllSelectsContainingOption(text: string): HTMLSelectElement[] {
  const opts = screen.getAllByRole('option', { name: text }) as HTMLOptionElement[];
  const selects = opts
    .map((o) => o.closest('select') as HTMLSelectElement | null)
    .filter((s): s is HTMLSelectElement => s !== null);
  return Array.from(new Set(selects));
}

describe('Connectors pipeline pickers', () => {
  it('loads HubSpot pipeline & stage dropdowns from the admin API and persists IDs on submit', async () => {
    const handlers: Record<string, FetchHandler> = {
      'GET /connectors': () => ({
        connectors: [buildHubspotConnector()],
        total: 1,
        limit: 100,
        offset: 0,
      }),
      'GET /connectors/hubspot-int-1/settings': () => ({
        provider: 'hubspot',
        settings: {
          appointmentPipelineId: 'sales-pipeline',
          appointmentStageId: 'sales-discovery',
          dispositionMap: null,
          dispositionMapError: null,
          leadStatusMap: null,
          leadStatusMapError: null,
        },
      }),
      'GET /connectors/hubspot-int-1/hubspot/pipelines': () => ({
        pipelines: HUBSPOT_PIPELINES,
      }),
      'POST /connectors': () => ({ integrationId: 'hubspot-int-1' }),
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
        screen.getByRole('heading', { name: /Reconnect HubSpot/i }),
      ).toBeTruthy();
    });

    const pipelineSelect = await waitFor(() =>
      getSelectByOptionText('Sales pipeline'),
    );
    expect(pipelineSelect.value).toBe('sales-pipeline');
    expect(
      Array.from(pipelineSelect.options).map((o) => o.textContent),
    ).toEqual(
      expect.arrayContaining([
        '— Use HubSpot default pipeline —',
        'Sales pipeline',
        'Enterprise pipeline',
      ]),
    );

    const stageSelect = await waitFor(() => getSelectByOptionText('Discovery'));
    expect(stageSelect).not.toBe(pipelineSelect);
    expect(stageSelect.value).toBe('sales-discovery');
    expect(
      Array.from(stageSelect.options).map((o) => o.textContent),
    ).toEqual(
      expect.arrayContaining(['Discovery', 'Meeting Booked']),
    );

    fireEvent.change(pipelineSelect, { target: { value: 'enterprise-pipeline' } });
    expect(pipelineSelect.value).toBe('enterprise-pipeline');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Demo Scheduled' })).toBeTruthy();
      expect(screen.queryByRole('option', { name: 'Discovery' })).toBeNull();
    });

    const refreshedStageSelect = getSelectByOptionText('Demo Scheduled');
    expect(refreshedStageSelect.value).toBe('');
    fireEvent.change(refreshedStageSelect, { target: { value: 'ent-demo-scheduled' } });
    expect(refreshedStageSelect.value).toBe('ent-demo-scheduled');

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
      connectorType: string;
      credentials: Record<string, string>;
    };
    expect(body.provider).toBe('hubspot');
    expect(body.connectorType).toBe('crm');
    expect(body.credentials.appointment_pipeline_id).toBe('enterprise-pipeline');
    expect(body.credentials.appointment_stage_id).toBe('ent-demo-scheduled');

    expect(
      capturedRequests.some(
        (r) =>
          r.method === 'GET' &&
          r.path === '/connectors/hubspot-int-1/hubspot/pipelines',
      ),
    ).toBe(true);
    expect(
      capturedRequests.some(
        (r) =>
          r.method === 'GET' && r.path === '/connectors/hubspot-int-1/settings',
      ),
    ).toBe(true);
  });

  it('loads Pipedrive default pipeline + default stage + appointment stage dropdowns and persists all three IDs on submit', async () => {
    const handlers: Record<string, FetchHandler> = {
      'GET /connectors': () => ({
        connectors: [buildPipedriveConnector()],
        total: 1,
        limit: 100,
        offset: 0,
      }),
      'GET /connectors/pipedrive-int-1/settings': () => ({
        provider: 'pipedrive',
        settings: {
          defaultPipelineId: '7',
          defaultStageId: '71',
          appointmentStageId: '72',
          dispositionMap: null,
          dispositionMapError: null,
          leadStatusMap: null,
          leadStatusMapError: null,
        },
      }),
      'GET /connectors/pipedrive-int-1/pipedrive/pipelines': () => ({
        pipelines: PIPEDRIVE_PIPELINES,
      }),
      'POST /connectors': () => ({ integrationId: 'pipedrive-int-1' }),
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
        screen.getByRole('heading', { name: /Reconnect Pipedrive/i }),
      ).toBeTruthy();
    });

    const pipelineSelect = await waitFor(() =>
      getSelectByOptionText('Inbound deals'),
    );
    expect(pipelineSelect.value).toBe('7');
    expect(
      Array.from(pipelineSelect.options).map((o) => o.textContent),
    ).toEqual(
      expect.arrayContaining([
        '— Use Pipedrive default pipeline —',
        'Inbound deals',
        'Outbound deals',
      ]),
    );

    const stageSelectsForPipeline7 = await waitFor(() => {
      const selects = getAllSelectsContainingOption('Lead in');
      expect(selects.length).toBe(2);
      return selects;
    });
    expect(stageSelectsForPipeline7).not.toContain(pipelineSelect);

    const defaultStageSelect = stageSelectsForPipeline7.find(
      (s) =>
        Array.from(s.options).some(
          (o) => o.textContent === '— Use Pipedrive first stage —',
        ),
    );
    const appointmentStageSelect = stageSelectsForPipeline7.find(
      (s) =>
        Array.from(s.options).some(
          (o) => o.textContent === '— No automatic stage move —',
        ),
    );
    expect(defaultStageSelect).toBeTruthy();
    expect(appointmentStageSelect).toBeTruthy();
    expect(defaultStageSelect).not.toBe(appointmentStageSelect);
    expect(defaultStageSelect!.value).toBe('71');
    expect(appointmentStageSelect!.value).toBe('72');

    fireEvent.change(pipelineSelect, { target: { value: '8' } });
    expect(pipelineSelect.value).toBe('8');

    await waitFor(() => {
      const coldReach = screen.getAllByRole('option', { name: 'Cold reach' });
      expect(coldReach.length).toBe(2);
      expect(screen.queryAllByRole('option', { name: 'Lead in' })).toHaveLength(0);
    });

    const refreshedSelects = getAllSelectsContainingOption('Cold reach');
    expect(refreshedSelects.length).toBe(2);

    const newDefaultStageSelect = refreshedSelects.find(
      (s) =>
        Array.from(s.options).some(
          (o) => o.textContent === '— Use Pipedrive first stage —',
        ),
    );
    const newAppointmentStageSelect = refreshedSelects.find(
      (s) =>
        Array.from(s.options).some(
          (o) => o.textContent === '— No automatic stage move —',
        ),
    );
    expect(newDefaultStageSelect).toBeTruthy();
    expect(newAppointmentStageSelect).toBeTruthy();
    expect(newDefaultStageSelect).not.toBe(newAppointmentStageSelect);
    expect(newDefaultStageSelect!.value).toBe('');
    expect(newAppointmentStageSelect!.value).toBe('');

    fireEvent.change(newDefaultStageSelect!, { target: { value: '81' } });
    fireEvent.change(newAppointmentStageSelect!, { target: { value: '82' } });

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
      connectorType: string;
      credentials: Record<string, string>;
    };
    expect(body.provider).toBe('pipedrive');
    expect(body.connectorType).toBe('crm');
    expect(body.credentials.default_pipeline_id).toBe('8');
    expect(body.credentials.default_stage_id).toBe('81');
    expect(body.credentials.appointment_stage_id).toBe('82');

    expect(
      capturedRequests.some(
        (r) =>
          r.method === 'GET' &&
          r.path === '/connectors/pipedrive-int-1/pipedrive/pipelines',
      ),
    ).toBe(true);
    expect(
      capturedRequests.some(
        (r) =>
          r.method === 'GET' &&
          r.path === '/connectors/pipedrive-int-1/settings',
      ),
    ).toBe(true);
  });

  it('blocks submission and shows an error when the saved appointment stage does not belong to the selected pipeline', async () => {
    const handlers: Record<string, FetchHandler> = {
      'GET /connectors': () => ({
        connectors: [buildHubspotConnector()],
        total: 1,
        limit: 100,
        offset: 0,
      }),
      'GET /connectors/hubspot-int-1/settings': () => ({
        provider: 'hubspot',
        settings: {
          appointmentPipelineId: 'sales-pipeline',
          appointmentStageId: 'ent-intro',
          dispositionMap: null,
          dispositionMapError: null,
          leadStatusMap: null,
          leadStatusMapError: null,
        },
      }),
      'GET /connectors/hubspot-int-1/hubspot/pipelines': () => ({
        pipelines: HUBSPOT_PIPELINES,
      }),
      'POST /connectors': () => ({ integrationId: 'hubspot-int-1' }),
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

    const pipelineSelect = await waitFor(() =>
      getSelectByOptionText('Sales pipeline'),
    );
    expect(pipelineSelect.value).toBe('sales-pipeline');

    const submitButton = screen.getByRole('button', { name: /^Reconnect$/ });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(
        screen.getByText(
          /selected appointment stage does not belong to the selected pipeline/i,
        ),
      ).toBeTruthy();
    });

    const postRequest = capturedRequests.find(
      (r) => r.method === 'POST' && r.path === '/connectors',
    );
    expect(postRequest).toBeUndefined();
  });
});
