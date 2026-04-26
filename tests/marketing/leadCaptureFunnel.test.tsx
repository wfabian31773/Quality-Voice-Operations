// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
// Track every analytics call so we can assert conversion events fire on the
// marketing pages and lead-capture forms without coupling to a real analytics
// SDK.
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
  trackDemoInteraction: () => {
    /* not asserted in this suite */
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

import Contact from '../../client-app/src/pages/public/Contact';
import ROICalculator from '../../client-app/src/components/ROICalculator';
import Landing from '../../client-app/src/pages/public/Landing';

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

interface ContactFields {
  name: HTMLInputElement;
  email: HTMLInputElement;
  company: HTMLInputElement;
  message: HTMLTextAreaElement;
}

// The Contact form does not associate <label>s with <input>s via htmlFor,
// so we look up fields by their input type / position. The 3 inputs are, in
// document order: name (text), email (email), company (text), and a message
// <textarea>.
function fillContactForm(
  form: HTMLFormElement,
  values: Partial<{
    name: string;
    email: string;
    company: string;
    message: string;
  }>,
): ContactFields {
  const inputs = Array.from(form.querySelectorAll('input')) as HTMLInputElement[];
  const textareas = Array.from(
    form.querySelectorAll('textarea'),
  ) as HTMLTextAreaElement[];

  expect(
    inputs.length,
    'Contact form should expose 3 text-style inputs',
  ).toBeGreaterThanOrEqual(3);
  expect(
    textareas.length,
    'Contact form should expose a "message" textarea',
  ).toBeGreaterThanOrEqual(1);

  const fields: ContactFields = {
    name: inputs[0],
    email: inputs[1],
    company: inputs[2],
    message: textareas[0],
  };

  // Sanity-check the structure so a future markup change fails loudly.
  expect(fields.email.getAttribute('type')).toBe('email');

  const set = (
    el: HTMLInputElement | HTMLTextAreaElement,
    value?: string,
  ) => {
    if (value === undefined) return;
    fireEvent.change(el, { target: { value } });
  };
  set(fields.name, values.name);
  set(fields.email, values.email);
  set(fields.company, values.company);
  set(fields.message, values.message);

  return fields;
}

// ROICalculator renders a 4-step questionnaire (call volume, handle time,
// hourly cost, AI handle %). The same primary button advances each step —
// labelled "Next" on steps 0–2 and "See My Results" on step 3. Click it 4
// times to land on the results screen which contains the email-capture form.
async function advanceROICalculatorToResults() {
  for (let i = 0; i < 3; i += 1) {
    const next = await screen.findByRole('button', { name: /next/i });
    fireEvent.click(next);
  }
  const seeResults = await screen.findByRole('button', {
    name: /see my results/i,
  });
  fireEvent.click(seeResults);
  await waitFor(() => {
    expect(screen.getByText(/your projected savings/i)).toBeTruthy();
  });
}

function getROIEmailForm(): HTMLFormElement {
  // The email-capture form sits inside the results card. It's the only
  // <form> on the results screen; identify it by the email input it owns.
  const emailInput = screen.getByPlaceholderText(/work email/i) as HTMLInputElement;
  const form = emailInput.closest('form');
  expect(form, 'ROI email-capture form should exist on results screen').toBeTruthy();
  return form as HTMLFormElement;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Marketing lead capture: Contact Sales form', () => {
  it('posts form data to /api/contact and shows the success state', async () => {
    fetchHandler = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        body = JSON.parse(init.body);
      }
      fetchCalls.push({ url, method, body });
      if (url === '/api/contact' && method === 'POST') {
        return new Response(
          JSON.stringify({ success: true, message: 'received' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    const { container } = render(
      <FunnelHarness
        initialPath="/contact"
        pageRoutePath="/contact"
        pageElement={<Contact />}
      />,
    );

    const form = container.querySelector('form');
    expect(form, 'Contact should render a form').toBeTruthy();

    fillContactForm(form!, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company: 'Analytical Engines Inc.',
      message: 'We have 800 calls/month and need night coverage.',
    });

    fireEvent.submit(form!);

    await waitFor(() => {
      expect(
        fetchCalls.some((c) => c.url === '/api/contact' && c.method === 'POST'),
      ).toBe(true);
    });

    // Verify the request body shape matches the contract /api/contact expects.
    const submitted = fetchCalls.find(
      (c) => c.url === '/api/contact' && c.method === 'POST',
    )!;
    const submittedBody = submitted.body as Record<string, unknown>;
    expect(submittedBody.name).toBe('Ada Lovelace');
    expect(submittedBody.email).toBe('ada@example.com');
    expect(submittedBody.company).toBe('Analytical Engines Inc.');
    expect(submittedBody.message).toBe(
      'We have 800 calls/month and need night coverage.',
    );

    // Success state replaces the form with a confirmation card.
    await waitFor(() => {
      expect(screen.getByText(/message received\./i)).toBeTruthy();
    });
    expect(container.querySelector('form')).toBeNull();
  });

  it('surfaces an inline error and keeps the form when the API rejects the request', async () => {
    fetchHandler = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        body = JSON.parse(init.body);
      }
      fetchCalls.push({ url, method, body });
      if (url === '/api/contact' && method === 'POST') {
        return new Response(
          JSON.stringify({ error: 'Invalid email address' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    const { container } = render(
      <FunnelHarness
        initialPath="/contact"
        pageRoutePath="/contact"
        pageElement={<Contact />}
      />,
    );

    const form = container.querySelector('form')!;
    fillContactForm(form, {
      name: 'Grace Hopper',
      email: 'not-an-email',
      company: 'COBOL Systems',
      message: 'Need help routing after-hours calls.',
    });
    fireEvent.submit(form);

    // The server-supplied error message should be rendered inline so the
    // user can correct it without losing their input.
    await waitFor(() => {
      expect(screen.getByText(/invalid email address/i)).toBeTruthy();
    });
    // Form remains visible (no success state) so the user can retry.
    expect(screen.queryByText(/message received\./i)).toBeNull();
    expect(container.querySelector('form')).toBeTruthy();
  });
});

describe('Marketing lead capture: ROI Calculator email report', () => {
  it('posts the calculator inputs/results to /api/roi-lead and confirms delivery', async () => {
    fetchHandler = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        body = JSON.parse(init.body);
      }
      fetchCalls.push({ url, method, body });
      if (url === '/api/roi-lead' && method === 'POST') {
        return new Response(
          JSON.stringify({ success: true, message: 'on its way' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    render(
      <MemoryRouter initialEntries={['/roi-calculator']}>
        <ROICalculator vertical="dental" />
      </MemoryRouter>,
    );

    await advanceROICalculatorToResults();

    const form = getROIEmailForm();
    const emailInput = screen.getByPlaceholderText(/work email/i) as HTMLInputElement;
    const nameInput = screen.getByPlaceholderText(/^name$/i) as HTMLInputElement;
    const companyInput = screen.getByPlaceholderText(/^company$/i) as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: 'Marie Curie' } });
    fireEvent.change(emailInput, { target: { value: 'marie@radium.io' } });
    fireEvent.change(companyInput, { target: { value: 'Radium Labs' } });

    fireEvent.submit(form);

    await waitFor(() => {
      expect(
        fetchCalls.some((c) => c.url === '/api/roi-lead' && c.method === 'POST'),
      ).toBe(true);
    });

    const submitted = fetchCalls.find(
      (c) => c.url === '/api/roi-lead' && c.method === 'POST',
    )!;
    const submittedBody = submitted.body as Record<string, unknown>;
    expect(submittedBody.email).toBe('marie@radium.io');
    expect(submittedBody.name).toBe('Marie Curie');
    expect(submittedBody.company).toBe('Radium Labs');
    // Vertical is round-tripped from the prop so the sales team can segment.
    expect(submittedBody.vertical).toBe('dental');

    // The "inputs" object should carry every slider value, and "results"
    // should carry the projected savings — both are what sales reps use to
    // qualify the lead before reaching out.
    const inputs = submittedBody.inputs as Record<string, unknown>;
    expect(typeof inputs.monthlyCallVolume).toBe('number');
    expect(typeof inputs.avgHandleTime).toBe('number');
    expect(typeof inputs.agentHourlyCost).toBe('number');
    expect(typeof inputs.aiHandleRate).toBe('number');

    const results = submittedBody.results as Record<string, unknown>;
    expect(typeof results.monthlySavings).toBe('number');
    expect(typeof results.annualSavings).toBe('number');
    expect(typeof results.qvoMonthlyCost).toBe('number');

    // Success state replaces the form with a confirmation panel and fires
    // the conversion analytic the marketing team relies on.
    await waitFor(() => {
      expect(screen.getByText(/report on the way\./i)).toBeTruthy();
    });
    expect(
      analyticsCalls.conversionEvents.some(
        (e) =>
          e.event === 'roi_report_requested' && e.page === '/roi-calculator',
      ),
    ).toBe(true);
  });

  it('surfaces an inline error when /api/roi-lead returns a failure', async () => {
    fetchHandler = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        body = JSON.parse(init.body);
      }
      fetchCalls.push({ url, method, body });
      if (url === '/api/roi-lead' && method === 'POST') {
        return new Response(
          JSON.stringify({ error: 'A valid email is required' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    render(
      <MemoryRouter initialEntries={['/roi-calculator']}>
        <ROICalculator />
      </MemoryRouter>,
    );

    await advanceROICalculatorToResults();

    const form = getROIEmailForm();
    const emailInput = screen.getByPlaceholderText(/work email/i) as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: 'incomplete@' } });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText(/a valid email is required/i)).toBeTruthy();
    });

    // Form remains so the user can retry; the success panel must not show.
    expect(screen.queryByText(/report on the way\./i)).toBeNull();
    expect(getROIEmailForm()).toBeTruthy();

    // Failure must NOT fire the conversion event — it would inflate funnel
    // metrics and mislead the sales team.
    expect(
      analyticsCalls.conversionEvents.some(
        (e) => e.event === 'roi_report_requested',
      ),
    ).toBe(false);
  });
});

describe('Marketing conversion funnel: Live Demo entry CTA', () => {
  it('navigates from the landing page hero to /demo when the Try Live Demo CTA is clicked', async () => {
    render(
      <FunnelHarness
        initialPath="/"
        pageRoutePath="/"
        pageElement={<Landing />}
      />,
    );

    // Use an exact-match regex so the bottom-CTA "Try the Live Demo" link
    // (same target, different position) doesn't shadow the hero CTA.
    const links = screen.getAllByRole('link', {
      name: /^try live demo$/i,
    }) as HTMLAnchorElement[];
    const heroLink = links.find((a) => a.getAttribute('href') === '/demo');
    expect(
      heroLink,
      'Landing hero should expose a Try Live Demo link pointing at /demo',
    ).toBeTruthy();

    fireEvent.click(heroLink!);

    // Real router navigation should swap the rendered page for the /demo
    // stub — proving the CTA actually navigates rather than just rendering
    // a correct href.
    await waitFor(() => {
      expect(screen.getByText(STUB_MARKERS.demo)).toBeTruthy();
    });

    // Analytics must record the click so the marketing team can attribute
    // demo traffic back to the hero CTA.
    expect(
      analyticsCalls.ctaClicks.some(
        (c) => c.ctaText === 'Try Live Demo' && c.page === '/' && c.position === 'hero',
      ),
    ).toBe(true);
  });

  it('navigates from the landing page bottom CTA strip to /demo when Try the Live Demo is clicked', async () => {
    render(
      <FunnelHarness
        initialPath="/"
        pageRoutePath="/"
        pageElement={<Landing />}
      />,
    );

    // Anchor text is "Try the Live Demo"; the analytics ctaText is "Try the Demo".
    const links = screen.getAllByRole('link', {
      name: /try the live demo/i,
    }) as HTMLAnchorElement[];
    const bottomLink = links.find((a) => a.getAttribute('href') === '/demo');
    expect(
      bottomLink,
      'Landing bottom CTA should expose a Try the Demo link pointing at /demo',
    ).toBeTruthy();

    fireEvent.click(bottomLink!);

    await waitFor(() => {
      expect(screen.getByText(STUB_MARKERS.demo)).toBeTruthy();
    });

    expect(
      analyticsCalls.ctaClicks.some(
        (c) =>
          c.ctaText === 'Try the Demo' &&
          c.page === '/' &&
          c.position === 'bottom-cta',
      ),
    ).toBe(true);
  });
});
