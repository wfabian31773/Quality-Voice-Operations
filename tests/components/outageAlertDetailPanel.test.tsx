// @vitest-environment happy-dom
/**
 * Frontend coverage for the outage alert detail side panel rendered by
 * `OutageAlertHistory` + `OutageAlertDetailPanel` + `OutageAlertDetailBody`
 * in `client-app/src/pages/Connectors.tsx`.
 *
 * The new `GET /connectors/alerts/:id` endpoint already has thorough route
 * tests, but the React side panel that consumes it was previously only
 * exercised manually. This file mocks the `api.get` call and verifies:
 *
 *   1. Clicking a row in the alert history opens the modal and triggers
 *      the detail fetch.
 *   2. Each per-recipient delivery status (`sent`, `failed`, `skipped`)
 *      renders its own badge with the right label and a per-recipient
 *      error string when the dispatch failed.
 *   3. When the alert predates the per-recipient feature
 *      (`recipientsAvailable: false`), the panel shows the empty-state
 *      copy explaining that only aggregate counts exist.
 *   4. Pressing Enter or Space on a row also opens the modal — keyboard
 *      navigation must stay on parity with mouse clicks for accessibility.
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
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

void React;

// Hoisted api mock — the same pattern as
// `tests/components/onboardingNavigation.test.tsx`. We reset the
// implementations per-test so each test can return its own alert
// payload + detail body without leaking across cases.
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
  // `useRole` -> `auth.ts` reads the JWT via `getToken` at import time.
  // Provide a stub so the module evaluates cleanly without touching
  // localStorage. We never sign requests in this test because `api` is
  // fully mocked above.
  getToken: () => null,
  setToken: () => {},
}));

// Imported AFTER the mock above so it picks up the stub.
import { OutageAlertHistory } from '../../client-app/src/pages/Connectors';

interface AlertRow {
  id: string;
  integrationId: string;
  integrationName: string | null;
  provider: string | null;
  connectorType: string | null;
  type: string;
  channel: 'email' | 'sms';
  title: string | null;
  message: string | null;
  createdAt: string;
  recipientCount: number | null;
  inAppRecipientCount: number;
  outageMinutes: number | null;
  firstFailedAt: string | null;
  errorMessage: string | null;
  smsAttempted: number | null;
  smsSucceeded: number | null;
  twilioConfigured: boolean | null;
  dispatchId: string | null;
}

interface RecipientRow {
  userId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  deliveryStatus: string;
  deliveryError: string | null;
  twilioStatusCode: number | null;
  dispatchedAt: string;
}

interface AlertDetail extends AlertRow {
  reconnectLink: string | null;
  recipientsAvailable: boolean;
  recipients: RecipientRow[];
  integration: null | {
    id: string;
    name: string | null;
    provider: string | null;
    connectorType: string | null;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    lastSyncError: string | null;
    lastSyncErrorAt: string | null;
  };
}

const ALERT_ID = 'gcal-int-1:outage:1700000000000';
const ALERT_CREATED_AT = '2026-04-29T12:00:00.000Z';
const ALERT_FIRST_FAILED_AT = '2026-04-29T11:30:00.000Z';

function buildAlert(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: ALERT_ID,
    integrationId: 'gcal-int-1',
    integrationName: 'Google Calendar',
    provider: 'google-calendar',
    connectorType: 'scheduling',
    type: 'outage',
    channel: 'sms',
    title: 'Google Calendar is down',
    message: null,
    createdAt: ALERT_CREATED_AT,
    recipientCount: 3,
    inAppRecipientCount: 3,
    outageMinutes: 30,
    firstFailedAt: ALERT_FIRST_FAILED_AT,
    errorMessage: 'token expired',
    smsAttempted: 3,
    smsSucceeded: 1,
    twilioConfigured: true,
    dispatchId: 'dispatch-1',
    ...overrides,
  };
}

function buildDetail(overrides: Partial<AlertDetail> = {}): AlertDetail {
  return {
    ...buildAlert(),
    reconnectLink: '/connectors?provider=google-calendar',
    recipientsAvailable: true,
    recipients: [],
    integration: {
      id: 'gcal-int-1',
      name: 'Google Calendar',
      provider: 'google-calendar',
      connectorType: 'scheduling',
      lastSyncAt: ALERT_CREATED_AT,
      lastSyncStatus: 'error',
      lastSyncError: 'token expired',
      lastSyncErrorAt: ALERT_CREATED_AT,
    },
    ...overrides,
  };
}

interface InstallOptions {
  alerts?: AlertRow[];
  detail?: AlertDetail;
}

function installApi({ alerts, detail }: InstallOptions = {}): void {
  apiMock.get.mockReset();
  const alertList = alerts ?? [buildAlert()];
  const alertDetail = detail ?? buildDetail();

  apiMock.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/connectors/alerts?')) {
      return {
        alerts: alertList,
        total: alertList.length,
        limit: 10,
        offset: 0,
      };
    }
    if (path.startsWith('/connectors/alerts/')) {
      return alertDetail;
    }
    throw new Error(`Unexpected api.get call: ${path}`);
  });
}

function renderHistory() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <OutageAlertHistory connectors={[]} />
    </QueryClientProvider>,
  );
}

async function openAlertRow(): Promise<HTMLElement> {
  // The alert row exposes itself as `role="button"` with an
  // aria-label of `View timeline for <provider> alert sent <when>`.
  // Targeting that role/name keeps the test resilient to className
  // refactors on the underlying <tr>.
  return waitFor(() =>
    screen.getByRole('button', { name: /^View timeline for /i }),
  );
}

async function waitForDetailPanel(): Promise<HTMLElement> {
  return waitFor(() =>
    screen.getByRole('dialog', { name: /Outage alert details/i }),
  );
}

beforeEach(() => {
  installApi();
});

afterEach(() => {
  cleanup();
  apiMock.get.mockReset();
});

describe('OutageAlertDetailPanel', () => {
  it('opens the modal on row click and fetches the detail from /connectors/alerts/:id', async () => {
    renderHistory();

    // Initial list call should fire.
    await waitFor(() => {
      const listed = apiMock.get.mock.calls.some(([p]) =>
        String(p).startsWith('/connectors/alerts?'),
      );
      expect(listed).toBe(true);
    });

    // Modal should NOT be open yet — useQuery is disabled until a row
    // is selected, so no detail call should have fired.
    expect(
      screen.queryByRole('dialog', { name: /Outage alert details/i }),
    ).toBeNull();
    expect(
      apiMock.get.mock.calls.some(([p]) =>
        String(p).startsWith('/connectors/alerts/'),
      ),
    ).toBe(false);

    fireEvent.click(await openAlertRow());

    const dialog = await waitForDetailPanel();
    expect(dialog).toBeTruthy();
    // Modal header copy from OutageAlertDetailPanel.
    expect(screen.getByText(/Outage alert timeline/i)).toBeTruthy();

    // The composite alert id contains colons, which the panel encodes
    // before hitting the route.
    await waitFor(() => {
      const detailCall = apiMock.get.mock.calls.find(([p]) =>
        String(p).startsWith('/connectors/alerts/'),
      );
      expect(detailCall).toBeTruthy();
      expect(detailCall![0]).toBe(
        `/connectors/alerts/${encodeURIComponent(ALERT_ID)}`,
      );
    });
  });

  it('renders sent / failed / skipped badges per recipient and surfaces the per-recipient error text', async () => {
    installApi({
      detail: buildDetail({
        recipientsAvailable: true,
        recipients: [
          {
            userId: 'u-sent',
            name: 'Alice Sent',
            email: 'alice@example.com',
            phone: '+15555550100',
            deliveryStatus: 'sent',
            deliveryError: null,
            twilioStatusCode: 201,
            dispatchedAt: ALERT_CREATED_AT,
          },
          {
            userId: 'u-failed',
            name: 'Bob Failed',
            email: 'bob@example.com',
            phone: '+15555550101',
            deliveryStatus: 'failed',
            deliveryError: 'Twilio error 21610: unsubscribed recipient',
            twilioStatusCode: 400,
            dispatchedAt: ALERT_CREATED_AT,
          },
          {
            userId: 'u-skipped',
            name: 'Carol Skipped',
            email: 'carol@example.com',
            phone: null,
            deliveryStatus: 'skipped',
            deliveryError: null,
            twilioStatusCode: null,
            dispatchedAt: ALERT_CREATED_AT,
          },
        ],
      }),
    });

    renderHistory();
    fireEvent.click(await openAlertRow());
    await waitForDetailPanel();

    await waitFor(() => {
      expect(screen.getByText('Alice Sent')).toBeTruthy();
    });

    // Each delivery status maps to its own badge label. We look the
    // badges up via their text so a future restyle that swaps icons
    // out doesn't break this test.
    const sentBadge = screen.getByText(/^Sent/);
    const failedBadge = screen.getByText(/^Failed/);
    const skippedBadge = screen.getByText(/^Skipped/);
    expect(sentBadge).toBeTruthy();
    expect(failedBadge).toBeTruthy();
    expect(skippedBadge).toBeTruthy();

    // SMS rows include the Twilio HTTP status code in the badge so
    // on-call admins can grep the right log line. Verify it's appended
    // to the failed badge (which carries a numeric `twilioStatusCode`)
    // but not the skipped badge (which has `twilioStatusCode: null`).
    expect(failedBadge.textContent ?? '').toContain('HTTP 400');
    expect(skippedBadge.textContent ?? '').not.toContain('HTTP');

    // Per-recipient delivery error string is rendered next to the
    // failed row so admins can act on it without leaving the panel.
    expect(
      screen.getByText(/Twilio error 21610: unsubscribed recipient/i),
    ).toBeTruthy();

    // The recipients header should show the count.
    expect(screen.getByText(/Recipients \(3\)/i)).toBeTruthy();
  });

  it("shows the 'no per-recipient data on file' empty state for legacy alerts that predate per-recipient logging", async () => {
    installApi({
      detail: buildDetail({
        recipientsAvailable: false,
        recipients: [],
      }),
    });

    renderHistory();
    fireEvent.click(await openAlertRow());
    await waitForDetailPanel();

    // The legacy empty state explains why we can only show aggregate
    // counts for old alerts, and must NOT render any recipient rows
    // or status badges.
    await waitFor(() => {
      expect(
        screen.getByText(
          /Per-recipient delivery data is only recorded for outage alerts/i,
        ),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/^Sent/)).toBeNull();
    expect(screen.queryByText(/^Failed/)).toBeNull();
    expect(screen.queryByText(/^Skipped/)).toBeNull();
    // The alternate empty state ("No per-recipient rows on file for
    // this dispatch.") is reserved for `recipientsAvailable: true`
    // with an empty array — it should NOT show here.
    expect(
      screen.queryByText(/No per-recipient rows on file for this dispatch/i),
    ).toBeNull();
  });

  it('opens the modal when the user presses Enter on a focused row', async () => {
    renderHistory();
    const row = await openAlertRow();

    fireEvent.keyDown(row, { key: 'Enter', code: 'Enter' });

    await waitForDetailPanel();
    expect(screen.getByText(/Outage alert timeline/i)).toBeTruthy();
    await waitFor(() => {
      expect(
        apiMock.get.mock.calls.some(([p]) =>
          String(p).startsWith('/connectors/alerts/'),
        ),
      ).toBe(true);
    });
  });

  it('opens the modal when the user presses Space on a focused row', async () => {
    renderHistory();
    const row = await openAlertRow();

    fireEvent.keyDown(row, { key: ' ', code: 'Space' });

    await waitForDetailPanel();
    expect(screen.getByText(/Outage alert timeline/i)).toBeTruthy();
    await waitFor(() => {
      expect(
        apiMock.get.mock.calls.some(([p]) =>
          String(p).startsWith('/connectors/alerts/'),
        ),
      ).toBe(true);
    });
  });
});
