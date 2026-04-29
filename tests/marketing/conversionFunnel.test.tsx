// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

void React;

// ---------------------------------------------------------------------------
// Suppress iframe page loads. The Book a Demo success state mounts an iframe
// pointed at cal.com; happy-dom otherwise emits a DOMException that muddies
// CI output (and would mask real failures). We replace the iframe's
// connectedToDocument lifecycle hook with a no-op so the element still
// renders into the DOM (the success-state test asserts the surrounding UI)
// but never attempts to load a remote page.
// ---------------------------------------------------------------------------
beforeAll(() => {
  const proto = window.HTMLIFrameElement.prototype as unknown as Record<symbol, unknown>;
  const symbols = Object.getOwnPropertySymbols(proto);
  const connectedSym = symbols.find(
    (s) => s.description === 'connectedToDocument',
  );
  const disconnectedSym = symbols.find(
    (s) => s.description === 'disconnectedFromDocument',
  );
  if (connectedSym) {
    proto[connectedSym] = function () {
      /* skip happy-dom's iframe page loader */
    };
  }
  if (disconnectedSym) {
    proto[disconnectedSym] = function () {
      /* skip happy-dom's iframe page unloader */
    };
  }
});

// ---------------------------------------------------------------------------
// Track every analytics call so we can assert conversion events fire on the
// marketing pages and CTAs without coupling to a real analytics SDK.
// ---------------------------------------------------------------------------
const analyticsCalls: {
  pageViews: string[];
  ctaClicks: Array<{ ctaText: string; page: string; position?: string }>;
  conversionEvents: Array<{
    event: string;
    page: string;
    metadata?: Record<string, unknown>;
  }>;
  utmCaptured: number;
} = {
  pageViews: [],
  ctaClicks: [],
  conversionEvents: [],
  utmCaptured: 0,
};

vi.mock('../../client-app/src/lib/analytics', () => ({
  trackPageView: (page: string) => {
    analyticsCalls.pageViews.push(page);
  },
  trackCTAClick: (ctaText: string, page: string, position?: string) => {
    analyticsCalls.ctaClicks.push({ ctaText, page, position });
  },
  trackConversionEvent: (
    event: string,
    page: string,
    metadata?: Record<string, unknown>,
  ) => {
    analyticsCalls.conversionEvents.push({ event, page, metadata });
  },
  captureUtmOnLoad: () => {
    analyticsCalls.utmCaptured += 1;
  },
}));

// Auth needs to be initialized + signed-out so the Landing page does NOT
// redirect to /dashboard in tests.
vi.mock('../../client-app/src/lib/auth', () => ({
  useAuth: () => ({ user: null, initialized: true }),
}));

// IntersectionObserver-driven reveal animations are not relevant to the
// behavior we want to test — render content immediately so queries find it.
vi.mock('../../client-app/src/components/RevealSection', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// LiveTranscriptMock animates over time and creates noise; stub it out.
vi.mock('../../client-app/src/components/LiveTranscriptMock', () => ({
  default: () => <div data-testid="live-transcript-mock" />,
}));

import Landing from '../../client-app/src/pages/public/Landing';
import Pricing from '../../client-app/src/pages/public/Pricing';
import BookDemo from '../../client-app/src/pages/public/BookDemo';
import CaseStudies from '../../client-app/src/pages/public/CaseStudies';
// Canonical CTA names — assertions reference these so the test stays in sync
// with the single source of truth used by the marketing pages.
import { CTA } from '../../client-app/src/lib/analyticsCtas';

// ---------------------------------------------------------------------------
// fetch capture
// ---------------------------------------------------------------------------
interface CapturedFetch {
  url: string;
  method: string;
  body: unknown;
}

let fetchCalls: CapturedFetch[] = [];
let fetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  analyticsCalls.pageViews = [];
  analyticsCalls.ctaClicks = [];
  analyticsCalls.conversionEvents = [];
  analyticsCalls.utmCaptured = 0;

  fetchCalls = [];
  // Default: respond 200 with an empty array — covers /api/public/case-studies.
  fetchHandler = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    fetchCalls.push({ url, method, body });
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Routing harness: renders the requested marketing page on its real route and
// gives every other destination route in the funnel a tiny stub component
// whose presence proves the navigation actually happened. Without this we'd
// only be asserting <a href> values, which would silently pass even if the
// router were misconfigured.
const STUB_MARKERS = {
  signup: 'STUB:signup-page',
  bookDemo: 'STUB:book-demo-page',
  pricing: 'STUB:pricing-page',
  demo: 'STUB:demo-page',
  contact: 'STUB:contact-page',
} as const;

function FunnelHarness({
  initialPath,
  pageElement,
  pageRoutePath,
}: {
  initialPath: string;
  pageRoutePath: string;
  pageElement: React.ReactElement;
}) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path={pageRoutePath} element={pageElement} />
        <Route path="/signup" element={<div>{STUB_MARKERS.signup}</div>} />
        <Route path="/book-demo" element={<div>{STUB_MARKERS.bookDemo}</div>} />
        <Route path="/pricing" element={<div>{STUB_MARKERS.pricing}</div>} />
        <Route path="/demo" element={<div>{STUB_MARKERS.demo}</div>} />
        <Route path="/contact" element={<div>{STUB_MARKERS.contact}</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function findLinksByText(label: RegExp | string): HTMLAnchorElement[] {
  return screen.getAllByRole('link', { name: label }) as HTMLAnchorElement[];
}

function findFirstLinkWithHref(
  label: RegExp | string,
  expectedHref: string,
): HTMLAnchorElement {
  const matches = findLinksByText(label).filter(
    (a) => a.getAttribute('href') === expectedHref,
  );
  expect(
    matches.length,
    `expected at least one link matching ${label} with href=${expectedHref}`,
  ).toBeGreaterThan(0);
  return matches[0];
}

interface BookDemoFields {
  name: HTMLInputElement;
  email: HTMLInputElement;
  company: HTMLInputElement;
  phone: HTMLInputElement;
  useCase: HTMLTextAreaElement;
}

// The BookDemo form associates each <label> with its <input> via htmlFor / id,
// so we can look up fields by their accessible label rather than position.
function fillBookDemoForm(
  _form: HTMLFormElement,
  values: Partial<{
    name: string;
    email: string;
    company: string;
    phone: string;
    useCase: string;
  }>,
): BookDemoFields {
  const fields: BookDemoFields = {
    name: screen.getByLabelText(/full name/i) as HTMLInputElement,
    email: screen.getByLabelText(/work email/i) as HTMLInputElement,
    company: screen.getByLabelText(/company/i) as HTMLInputElement,
    phone: screen.getByLabelText(/phone/i) as HTMLInputElement,
    useCase: screen.getByLabelText(
      /what are you trying to solve/i,
    ) as HTMLTextAreaElement,
  };

  // Sanity check the structure so a future markup change fails loudly.
  expect(fields.email.getAttribute('type')).toBe('email');
  expect(fields.phone.getAttribute('type')).toBe('tel');

  const set = (el: HTMLInputElement | HTMLTextAreaElement, value?: string) => {
    if (value === undefined) return;
    fireEvent.change(el, { target: { value } });
  };
  set(fields.name, values.name);
  set(fields.email, values.email);
  set(fields.company, values.company);
  set(fields.phone, values.phone);
  set(fields.useCase, values.useCase);

  return fields;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Marketing conversion funnel: Landing CTAs', () => {
  it('fires page-view + UTM analytics when the landing page mounts', () => {
    render(
      <FunnelHarness
        initialPath="/"
        pageRoutePath="/"
        pageElement={<Landing />}
      />,
    );

    expect(analyticsCalls.pageViews).toContain('/');
    expect(analyticsCalls.utmCaptured).toBe(1);
    expect(
      analyticsCalls.conversionEvents.some(
        (e) => e.event === 'page_view' && e.page === '/',
      ),
    ).toBe(true);
  });

  it('navigates from landing to /book-demo when the Book a Demo CTA is clicked', async () => {
    render(
      <FunnelHarness
        initialPath="/"
        pageRoutePath="/"
        pageElement={<Landing />}
      />,
    );

    const link = findFirstLinkWithHref(/book a demo/i, '/book-demo');
    fireEvent.click(link);

    // The router should have replaced the rendered page with the
    // /book-demo stub — proving real navigation happened, not just the
    // presence of a correct href.
    await waitFor(() => {
      expect(screen.getByText(STUB_MARKERS.bookDemo)).toBeTruthy();
    });

    expect(
      analyticsCalls.ctaClicks.some(
        (c) => c.ctaText === CTA.BOOK_DEMO && c.page === '/',
      ),
    ).toBe(true);
  });

  it('navigates from landing to /signup when the Start Free Trial CTA is clicked', async () => {
    render(
      <FunnelHarness
        initialPath="/"
        pageRoutePath="/"
        pageElement={<Landing />}
      />,
    );

    const link = findFirstLinkWithHref(/start free trial/i, '/signup');
    fireEvent.click(link);

    await waitFor(() => {
      expect(screen.getByText(STUB_MARKERS.signup)).toBeTruthy();
    });

    expect(
      analyticsCalls.ctaClicks.some(
        (c) => c.ctaText === CTA.START_FREE_TRIAL && c.page === '/',
      ),
    ).toBe(true);
  });
});

describe('Marketing conversion funnel: Pricing CTAs', () => {
  it('navigates from pricing to /book-demo when the Book a Demo CTA is clicked', async () => {
    render(
      <FunnelHarness
        initialPath="/pricing"
        pageRoutePath="/pricing"
        pageElement={<Pricing />}
      />,
    );

    expect(analyticsCalls.pageViews).toContain('/pricing');

    const link = findFirstLinkWithHref(/book a demo/i, '/book-demo');
    fireEvent.click(link);

    await waitFor(() => {
      expect(screen.getByText(STUB_MARKERS.bookDemo)).toBeTruthy();
    });

    expect(
      analyticsCalls.ctaClicks.some(
        (c) => c.ctaText === CTA.BOOK_DEMO && c.page === 'pricing_bottom',
      ),
    ).toBe(true);
  });

  it('navigates from each pricing tier to /signup with the right ?plan query', async () => {
    render(
      <FunnelHarness
        initialPath="/pricing"
        pageRoutePath="/pricing"
        pageElement={<Pricing />}
      />,
    );

    const trialLinks = findLinksByText(/start free trial/i);
    // 3 tiers in the pricing cards + 1 in the bottom CTA strip.
    expect(trialLinks.length).toBeGreaterThanOrEqual(3);

    // Every Start Free Trial link should target /signup (with or without
    // ?plan=…). Confirm by inspecting hrefs.
    for (const link of trialLinks) {
      const href = link.getAttribute('href') ?? '';
      expect(
        href === '/signup' || href.startsWith('/signup?plan='),
        `Start Free Trial link href should target /signup, got ${href}`,
      ).toBe(true);
    }

    // Then click the first tier card and confirm a real navigation happens.
    const tierLink = trialLinks.find((a) =>
      (a.getAttribute('href') ?? '').startsWith('/signup?plan='),
    )!;
    fireEvent.click(tierLink);
    await waitFor(() => {
      expect(screen.getByText(STUB_MARKERS.signup)).toBeTruthy();
    });
  });
});

describe('Marketing conversion funnel: Case Studies CTAs', () => {
  it('navigates from /case-studies to /book-demo when the empty-state CTA is clicked', async () => {
    render(
      <MemoryRouter initialEntries={['/case-studies']}>
        <Routes>
          <Route path="/case-studies" element={<CaseStudies />} />
          <Route path="/case-studies/:slug" element={<CaseStudies />} />
          <Route path="/book-demo" element={<div>{STUB_MARKERS.bookDemo}</div>} />
          <Route path="/signup" element={<div>{STUB_MARKERS.signup}</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for the case-studies fetch (returns []) to resolve so the page
    // shows its empty-state CTA group.
    await waitFor(() => {
      expect(
        screen.getByText(/detailed case studies coming soon/i),
      ).toBeTruthy();
    });
    expect(
      fetchCalls.some((c) => c.url === '/api/public/case-studies'),
    ).toBe(true);

    const bookDemoLink = findFirstLinkWithHref(/book a demo/i, '/book-demo');
    fireEvent.click(bookDemoLink);

    await waitFor(() => {
      expect(screen.getByText(STUB_MARKERS.bookDemo)).toBeTruthy();
    });
  });
});

describe('Marketing conversion funnel: Book a Demo form', () => {
  it('submits successfully and shows the success state', async () => {
    fetchHandler = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        body = JSON.parse(init.body);
      }
      fetchCalls.push({ url, method, body });
      if (url === '/api/book-demo' && method === 'POST') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const { container } = render(
      <MemoryRouter initialEntries={['/book-demo']}>
        <BookDemo />
      </MemoryRouter>,
    );

    const form = container.querySelector('form');
    expect(form, 'BookDemo should render a form').toBeTruthy();

    const fields = fillBookDemoForm(form!, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company: 'Analytical Engines Inc.',
      phone: '+15555550123',
    });
    expect(fields.name.value).toBe('Ada Lovelace');

    fireEvent.submit(form!);

    await waitFor(() => {
      expect(
        fetchCalls.some((c) => c.url === '/api/book-demo' && c.method === 'POST'),
      ).toBe(true);
    });

    const submitted = fetchCalls.find(
      (c) => c.url === '/api/book-demo' && c.method === 'POST',
    )!;
    const submittedBody = submitted.body as Record<string, unknown>;
    expect(submittedBody.name).toBe('Ada Lovelace');
    expect(submittedBody.email).toBe('ada@example.com');
    expect(submittedBody.company).toBe('Analytical Engines Inc.');

    // Success state shows a personalized "Thanks, Ada." heading and the
    // calendar embed.
    await waitFor(() => {
      expect(screen.getByText(/thanks, ada\./i)).toBeTruthy();
    });
    expect(screen.getByText(/choose a time/i)).toBeTruthy();

    // Conversion analytics should fire on success.
    expect(
      analyticsCalls.ctaClicks.some(
        (c) => c.ctaText === CTA.BOOK_DEMO_SUBMIT && c.page === '/book-demo',
      ),
    ).toBe(true);
    expect(
      analyticsCalls.conversionEvents.some(
        (e) => e.event === 'demo_requested' && e.page === '/book-demo',
      ),
    ).toBe(true);
  });

  it('surfaces an inline error message when the API returns a failure', async () => {
    fetchHandler = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        body = JSON.parse(init.body);
      }
      fetchCalls.push({ url, method, body });
      if (url === '/api/book-demo' && method === 'POST') {
        return new Response(
          JSON.stringify({ error: 'Email is already on the waitlist.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    const { container } = render(
      <MemoryRouter initialEntries={['/book-demo']}>
        <BookDemo />
      </MemoryRouter>,
    );

    const form = container.querySelector('form')!;
    fillBookDemoForm(form, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      company: 'COBOL Systems',
    });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/already on the waitlist/i)).toBeTruthy();
    });

    // The form should remain visible (no success state) so the user can retry.
    expect(screen.queryByText(/thanks, grace\./i)).toBeNull();
    expect(container.querySelector('form')).toBeTruthy();
  });
});
