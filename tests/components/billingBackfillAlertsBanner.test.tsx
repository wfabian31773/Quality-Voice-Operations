// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import BillingBackfillAlertsBanner from '../../client-app/src/components/BillingBackfillAlertsBanner';

void React;

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

let fetchHandler: FetchHandler | null = null;
let originalFetch: typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderBanner() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BillingBackfillAlertsBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    fetchHandler!(String(url), init)) as typeof fetch;
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  fetchHandler = null;
});

describe('BillingBackfillAlertsBanner', () => {
  it('renders nothing when there are no unacknowledged billing_backfill_cross_day alerts', async () => {
    fetchHandler = async () =>
      jsonResponse({ alerts: [], unacknowledgedCount: 0 });

    const { container } = renderBanner();

    // Wait for the query to settle.
    await waitFor(() => expect(fetchHandler).not.toBeNull());
    await new Promise((r) => setTimeout(r, 0));

    expect(container.textContent).toBe('');
  });

  it('requests the alerts list scoped to the billing_backfill_cross_day type so the count is exact', async () => {
    const seenUrls: string[] = [];
    fetchHandler = async (url) => {
      seenUrls.push(url);
      return jsonResponse({ alerts: [], unacknowledgedCount: 0 });
    };

    renderBanner();
    await waitFor(() => expect(seenUrls.length).toBeGreaterThan(0));

    const url = seenUrls.find((u) => u.includes('/operations/alerts'));
    expect(url).toBeTruthy();
    // Must scope by both `acknowledged=false` and `type=billing_backfill_cross_day`
    // so the server returns an unacknowledgedCount that isn't capped by `limit`.
    expect(url).toContain('acknowledged=false');
    expect(url).toContain('type=billing_backfill_cross_day');
  });

  it('shows a singular banner with a deep-link to Operations when one billing alert is unacknowledged', async () => {
    fetchHandler = async () =>
      jsonResponse({
        alerts: [
          { id: 'a1', type: 'billing_backfill_cross_day', acknowledged: false },
        ],
        unacknowledgedCount: 1,
      });

    renderBanner();

    await waitFor(() =>
      expect(screen.getByText('Billing needs attention')).toBeTruthy(),
    );
    expect(
      screen.getByText(/1 unacknowledged cross-day backfill alert\b/),
    ).toBeTruthy();
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(
      '/ops/monitor?alertType=billing_backfill_cross_day#alerts-panel',
    );
  });

  it('uses plural copy and reflects the server-side unacknowledgedCount when multiple billing alerts are unacknowledged', async () => {
    // The server is now responsible for filtering + counting by type, so we
    // trust unacknowledgedCount directly. Even if the listing is capped or
    // the rows are stale, the count should drive the displayed number.
    fetchHandler = async () =>
      jsonResponse({
        alerts: [
          { id: 'a1', type: 'billing_backfill_cross_day', acknowledged: false },
        ],
        unacknowledgedCount: 7,
      });

    renderBanner();

    await waitFor(() =>
      expect(
        screen.getByText(/7 unacknowledged cross-day backfill alerts\b/),
      ).toBeTruthy(),
    );
    expect(screen.getByText('Billing needs attention')).toBeTruthy();
  });
});
