// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import OperationsAlertsBanner, {
  OPERATIONS_ALERT_CATEGORIES,
} from '../../client-app/src/components/OperationsAlertsBanner';

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
        <OperationsAlertsBanner />
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

describe('OperationsAlertsBanner', () => {
  it('renders nothing when no curated category has unacknowledged alerts', async () => {
    fetchHandler = async () => jsonResponse({ counts: {} });

    const { container } = renderBanner();

    await waitFor(() => expect(fetchHandler).not.toBeNull());
    await new Promise((r) => setTimeout(r, 0));

    expect(container.textContent).toBe('');
  });

  it('requests the summary endpoint scoped to the curated category list', async () => {
    const seenUrls: string[] = [];
    fetchHandler = async (url) => {
      seenUrls.push(url);
      return jsonResponse({ counts: {} });
    };

    renderBanner();
    await waitFor(() => expect(seenUrls.length).toBeGreaterThan(0));

    const url = seenUrls.find((u) => u.includes('/operations/alerts/summary'));
    expect(url).toBeTruthy();
    for (const cat of OPERATIONS_ALERT_CATEGORIES) {
      expect(decodeURIComponent(url!)).toContain(cat.type);
    }
  });

  it('renders one row per category with a non-zero count and deep-links to Operations', async () => {
    fetchHandler = async () =>
      jsonResponse({
        counts: {
          billing_backfill_cross_day: 1,
          support_email_delivery_failed: 3,
        },
      });

    renderBanner();

    await waitFor(() =>
      expect(screen.getByText('Billing needs verification')).toBeTruthy(),
    );
    expect(screen.getByText('Support email delivery failed')).toBeTruthy();

    const hrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(hrefs).toContain(
      '/ops/monitor?alertType=billing_backfill_cross_day#alerts-panel',
    );
    expect(hrefs).toContain(
      '/ops/monitor?alertType=support_email_delivery_failed#alerts-panel',
    );

    expect(
      screen.getByText(/1 unacknowledged cross-day backfill alert\b/),
    ).toBeTruthy();
    expect(
      screen.getByText(/3 unacknowledged undelivered support emails\b/),
    ).toBeTruthy();
  });

  it('omits categories whose count is zero or missing', async () => {
    fetchHandler = async () =>
      jsonResponse({
        counts: {
          error_rate_spike: 2,
          escalation_spike: 0,
        },
      });

    renderBanner();

    await waitFor(() =>
      expect(screen.getByText('Call failure rate spike')).toBeTruthy(),
    );
    expect(screen.queryByText('Escalation spike detected')).toBeNull();
    expect(screen.queryByText('Billing needs verification')).toBeNull();
  });

  it('renders rows in curated order regardless of response key order', async () => {
    fetchHandler = async () =>
      jsonResponse({
        counts: {
          billing_backfill_cross_day: 1,
          error_rate_spike: 1,
        },
      });

    const { container } = renderBanner();

    await waitFor(() =>
      expect(container.querySelectorAll('a').length).toBe(2),
    );

    const orderedTypes = Array.from(container.querySelectorAll('a')).map(
      (a) => a.getAttribute('data-alert-type'),
    );
    expect(orderedTypes).toEqual(['error_rate_spike', 'billing_backfill_cross_day']);
  });
});
