// @vitest-environment happy-dom
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
  act,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

void React;

// ---------------------------------------------------------------------------
// Analytics mock — capture the conversion + CTA telemetry the marketing/sales
// teams rely on. Mirrors tests/marketing/leadCaptureFunnel.test.tsx so the
// Demo page is held to the same contract.
// ---------------------------------------------------------------------------
const analyticsCalls: {
  pageViews: string[];
  ctaClicks: Array<{ ctaText: string; page: string; position?: string }>;
  conversionEvents: Array<{
    event: string;
    page: string;
    metadata?: Record<string, unknown>;
  }>;
  demoInteractions: Array<{
    action: string;
    agentType?: string;
    durationSeconds?: number;
  }>;
  utmCaptured: number;
} = {
  pageViews: [],
  ctaClicks: [],
  conversionEvents: [],
  demoInteractions: [],
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
  trackDemoInteraction: (
    action: string,
    agentType?: string,
    durationSeconds?: number,
  ) => {
    analyticsCalls.demoInteractions.push({ action, agentType, durationSeconds });
  },
  captureUtmOnLoad: () => {
    analyticsCalls.utmCaptured += 1;
  },
}));

// ---------------------------------------------------------------------------
// useDemoSSE stub — back the hook with an external store so a test can
// transition `callStatus` ('idle' -> 'ringing' -> 'connected' -> 'ended')
// and see Demo.tsx re-render exactly as if a real SSE event had arrived.
// ---------------------------------------------------------------------------
type SSEState = {
  callStatus: 'idle' | 'ringing' | 'connected' | 'ended';
  activeCallId: string | null;
  agentName: string | null;
  duration: number | null;
  transcript: unknown[];
  tools: unknown[];
  activityEvents: unknown[];
  connected: boolean;
};

const initialSSEState: SSEState = {
  callStatus: 'idle',
  activeCallId: null,
  agentName: null,
  duration: null,
  transcript: [],
  tools: [],
  activityEvents: [],
  connected: false,
};

let sseState: SSEState = { ...initialSSEState };
const sseListeners = new Set<() => void>();

function setSSEState(partial: Partial<SSEState>) {
  sseState = { ...sseState, ...partial };
  for (const listener of sseListeners) listener();
}

function resetSSEState() {
  sseState = { ...initialSSEState };
  for (const listener of sseListeners) listener();
}

vi.mock('../../client-app/src/hooks/useDemoSSE', () => {
  const { useEffect, useState } = require('react') as typeof import('react');
  return {
    useDemoSSE: () => {
      const [, force] = useState(0);
      useEffect(() => {
        const listener = () => force((n) => n + 1);
        sseListeners.add(listener);
        return () => {
          sseListeners.delete(listener);
        };
      }, []);
      return sseState;
    },
  };
});

// SystemActivityFeed renders a complex tree we don't care about here — keep
// the DOM lean so failing assertions are easy to diagnose.
vi.mock('../../client-app/src/components/demo/SystemActivityFeed', () => ({
  default: () => <div data-testid="system-activity-feed-stub" />,
}));

// CalendarToolVisual / ToolExecutionPanel / ConversationTranscript are not
// the subject of this suite and would otherwise require their own mocks for
// timestamp parsing. Stub them to reduce noise.
vi.mock('../../client-app/src/components/demo/ConversationTranscript', () => ({
  default: () => <div data-testid="conversation-transcript-stub" />,
}));
vi.mock('../../client-app/src/components/demo/ToolExecutionPanel', () => ({
  default: () => <div data-testid="tool-execution-panel-stub" />,
}));
vi.mock('../../client-app/src/components/demo/CalendarToolVisual', () => ({
  default: () => <div data-testid="calendar-tool-visual-stub" />,
}));

// SEO writes to document.head; happy-dom handles it but the noise hurts.
vi.mock('../../client-app/src/components/SEO', () => ({
  default: () => null,
}));

import Demo from '../../client-app/src/pages/Demo';
// Canonical CTA names — assertions reference these so the test stays in sync
// with the single source of truth used by the marketing pages.
import { CTA } from '../../client-app/src/lib/analyticsCtas';

// ---------------------------------------------------------------------------
// Fetch capture — same shape as the lead-capture suite so future readers
// have a single mental model.
// ---------------------------------------------------------------------------
interface CapturedFetch {
  url: string;
  method: string;
  body: unknown;
}

let fetchCalls: CapturedFetch[] = [];
let fetchHandler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const FIXTURE_AGENTS = [
  {
    id: 'agent-medical',
    name: 'Medical Front Desk',
    description: 'Handles patient intake calls.',
    template: 'medical',
    voiceId: 'voice-1',
    phoneNumber: '+15551234567',
    isPlaceholder: false,
    icon: 'stethoscope',
    category: 'Healthcare',
    useCases: ['Appointment scheduling', 'Insurance verification'],
  },
  {
    id: 'agent-hvac',
    name: 'HVAC Dispatcher',
    description: 'Routes service requests to technicians.',
    template: 'hvac',
    voiceId: 'voice-2',
    phoneNumber: '+15559876543',
    isPlaceholder: false,
    icon: 'wrench',
    category: 'Field Services',
    useCases: ['Service tickets', 'Technician dispatch'],
  },
];

function buildDefaultFetchHandler(): typeof fetchHandler {
  return async (input, init) => {
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

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url === '/api/demo/agents') {
      return json({ agents: FIXTURE_AGENTS });
    }
    if (url === '/api/demo/phones') {
      return json({ configured: true });
    }
    if (url === '/api/demo/stats') {
      return json({ totalCalls: 1234 });
    }
    if (url === '/api/demo/track-cta' && method === 'POST') {
      return json({ ok: true });
    }
    // Default: empty success — surfaces the rare miss as an empty payload
    // rather than a network error, so failures point at the assertion not
    // the harness.
    return json({});
  };
}

beforeEach(() => {
  analyticsCalls.pageViews = [];
  analyticsCalls.ctaClicks = [];
  analyticsCalls.conversionEvents = [];
  analyticsCalls.demoInteractions = [];
  analyticsCalls.utmCaptured = 0;

  fetchCalls = [];
  fetchHandler = buildDefaultFetchHandler();
  vi.stubGlobal('fetch', ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(input, init)) as typeof fetch);

  resetSSEState();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetSSEState();
});

// ---------------------------------------------------------------------------
// Harness — mount Demo inside a router that owns stub /signup and /contact
// routes, so we can assert real navigation occurs when ConversionCTA links
// are clicked (rather than just inspecting hrefs).
// ---------------------------------------------------------------------------
const STUB_MARKERS = {
  signup: 'STUB:signup-page',
  contact: 'STUB:contact-page',
} as const;

function DemoHarness() {
  return (
    <MemoryRouter initialEntries={['/demo']}>
      <Routes>
        <Route path="/demo" element={<Demo />} />
        <Route path="/signup" element={<div>{STUB_MARKERS.signup}</div>} />
        <Route path="/contact" element={<div>{STUB_MARKERS.contact}</div>} />
      </Routes>
    </MemoryRouter>
  );
}

async function waitForAgentsToLoad() {
  // Each agent's name appears in the AgentCard heading AND, once selected,
  // in the active-agent panel. Wait on the agent card *button*, which is
  // unique to the grid above and doesn't shift around on selection.
  await waitFor(() => {
    expect(
      screen.getByRole('button', { name: /Medical Front Desk/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /HVAC Dispatcher/ }),
    ).toBeTruthy();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Demo page: agent selection and live call status', () => {
  it('renders agents from /api/demo/agents and shows the selected agent\'s phone number formatted for humans', async () => {
    render(<DemoHarness />);

    await waitForAgentsToLoad();

    // The page should request all three demo data endpoints on mount so the
    // call experience is wired up to live data, not static fixtures.
    await waitFor(() => {
      const urls = fetchCalls.map((c) => c.url);
      expect(urls).toContain('/api/demo/agents');
      expect(urls).toContain('/api/demo/phones');
      expect(urls).toContain('/api/demo/stats');
    });

    // Agent cards render every fixture agent, plus the totals widget hydrates
    // from /api/demo/stats so prospects see real call volume.
    expect(screen.getByText('1,234')).toBeTruthy();
    // Healthcare appears in both the agent card and the active-agent panel
    // (because Medical is auto-selected), so allow >=1 match. Field Services
    // appears only in the HVAC card pre-click.
    expect(screen.getAllByText('Healthcare').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Field Services')).toBeTruthy();

    // First agent is auto-selected — its phone number must show in the
    // active-agent panel so a prospect can dial it without extra clicks.
    expect(screen.getByText('+1 (555) 123-4567')).toBeTruthy();
    expect(screen.queryByText('+1 (555) 987-6543')).toBeNull();

    // Selecting the second agent swaps the visible phone number and emits
    // an analytics ping so growth can attribute the agent_selected funnel.
    fireEvent.click(screen.getByRole('button', { name: /HVAC Dispatcher/ }));
    await waitFor(() => {
      expect(screen.getByText('+1 (555) 987-6543')).toBeTruthy();
    });
    expect(
      analyticsCalls.demoInteractions.some(
        (e) => e.action === 'agent_selected' && e.agentType === 'HVAC Dispatcher',
      ),
    ).toBe(true);
  });

  it('reflects useDemoSSE callStatus transitions in the call status bar', async () => {
    render(<DemoHarness />);
    await waitForAgentsToLoad();

    // Idle is the default. The pill reads "Idle" until the SSE stream says
    // otherwise.
    expect(screen.getByText('Idle')).toBeTruthy();
    expect(screen.queryByText('Call Active')).toBeNull();

    // Ringing flips the bar to "Call Active" because Demo treats both
    // ringing + connected as the active state visually.
    act(() => {
      setSSEState({ callStatus: 'ringing' });
    });
    await waitFor(() => {
      expect(screen.getByText('Call Active')).toBeTruthy();
    });
    expect(screen.queryByText('Idle')).toBeNull();

    // Promote to connected — bar should remain Active. Demo treats every
    // transition INTO ringing/connected as a fresh call_started ping (so we
    // see one for idle->ringing and another for ringing->connected). What
    // we actually care about is that the active agent is named in those
    // pings, which is the field sales reps actually segment on.
    act(() => {
      setSSEState({ callStatus: 'connected' });
    });
    await waitFor(() => {
      expect(screen.getByText('Call Active')).toBeTruthy();
    });
    const callStarted = analyticsCalls.demoInteractions.filter(
      (e) => e.action === 'call_started',
    );
    expect(callStarted.length).toBeGreaterThanOrEqual(1);
    expect(
      callStarted.every((e) => e.agentType === 'Medical Front Desk'),
    ).toBe(true);

    // Drop the call — Demo should restore the Idle pill so prospects know
    // the line is free again.
    act(() => {
      setSSEState({ callStatus: 'ended' });
    });
    await waitFor(() => {
      expect(screen.getByText('Idle')).toBeTruthy();
    });
    expect(screen.queryByText('Call Active')).toBeNull();
  });
});

describe('Demo page: post-call conversion CTA + analytics', () => {
  it('shows the conversion CTA after the celebration timer and fires demo_completed analytics', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<DemoHarness />);
    await waitForAgentsToLoad();

    // demo_started fires on mount so the marketing team can measure how many
    // visitors actually reach the demo page.
    expect(
      analyticsCalls.conversionEvents.some(
        (e) => e.event === 'demo_started' && e.page === '/demo',
      ),
    ).toBe(true);

    // CTA must be hidden until a call has actually completed.
    expect(screen.queryByText(/Deploy your own AI voice agents/i)).toBeNull();

    // Simulate a real call: ringing -> connected -> ended. Only the ringing
    // -> ended sequence (or connected -> ended) should fire the celebration.
    act(() => {
      setSSEState({ callStatus: 'ringing' });
    });
    act(() => {
      setSSEState({ callStatus: 'connected' });
    });
    act(() => {
      setSSEState({ callStatus: 'ended' });
    });

    // Celebration card appears immediately on transition to 'ended'.
    await waitFor(() => {
      expect(screen.getByText(/Demo Complete!/i)).toBeTruthy();
    });

    // demo_completed must fire BEFORE the CTA is rendered so attribution is
    // recorded for visitors who close the tab during the celebration.
    expect(
      analyticsCalls.conversionEvents.some(
        (e) =>
          e.event === 'demo_completed' &&
          e.page === '/demo' &&
          (e.metadata as Record<string, unknown> | undefined)?.agent ===
            'Medical Front Desk',
      ),
    ).toBe(true);

    // call_completed interaction is also recorded so we can measure how
    // many demos actually finish vs. drop off mid-call.
    expect(
      analyticsCalls.demoInteractions.some(
        (e) => e.action === 'call_completed' && e.agentType === 'Medical Front Desk',
      ),
    ).toBe(true);

    // Advance past the 2.5s celebration window — the CTA should now mount.
    await act(async () => {
      vi.advanceTimersByTime(2600);
    });

    await waitFor(() => {
      expect(screen.getByText(/Deploy your own AI voice agents/i)).toBeTruthy();
    });
    // Celebration card should disappear once the CTA takes over.
    expect(screen.queryByText(/Demo Complete!/i)).toBeNull();
  });

  it('clicking ConversionCTA buttons posts to /api/demo/track-cta and navigates to /signup or /contact', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<DemoHarness />);
    await waitForAgentsToLoad();

    // Drive the call to completion so the CTA renders.
    act(() => {
      setSSEState({ callStatus: 'connected' });
    });
    act(() => {
      setSSEState({ callStatus: 'ended' });
    });
    await act(async () => {
      vi.advanceTimersByTime(2600);
    });

    const startTrial = await screen.findByRole('link', {
      name: /start free trial/i,
    });
    const bookDemo = await screen.findByRole('link', { name: /book a demo/i });

    expect(startTrial.getAttribute('href')).toBe('/signup');
    expect(bookDemo.getAttribute('href')).toBe('/contact');

    // ----- Start Free Trial click -----
    fireEvent.click(startTrial);

    await waitFor(() => {
      expect(
        fetchCalls.some(
          (c) => c.url === '/api/demo/track-cta' && c.method === 'POST',
        ),
      ).toBe(true);
    });
    const trialCall = fetchCalls.find(
      (c) => c.url === '/api/demo/track-cta' && c.method === 'POST',
    )!;
    const trialBody = trialCall.body as Record<string, unknown>;
    expect(trialBody.ctaType).toBe('start_free_trial');
    // agentType should round-trip the active agent's template so sales can
    // segment which vertical the lead engaged with.
    expect(trialBody.agentType).toBe('medical');

    // Analytics CTA click should fire alongside the API ping.
    expect(
      analyticsCalls.ctaClicks.some(
        (c) => c.ctaText === CTA.START_FREE_TRIAL && c.page === 'demo',
      ),
    ).toBe(true);

    // Real navigation occurs — the /signup stub mounts in place of the
    // Demo page proving the <Link> isn't decorative.
    await waitFor(() => {
      expect(screen.getByText(STUB_MARKERS.signup)).toBeTruthy();
    });
  });

  it('the secondary Book a Demo CTA posts book_demo and navigates to /contact', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    render(<DemoHarness />);
    await waitForAgentsToLoad();

    act(() => {
      setSSEState({ callStatus: 'connected' });
    });
    act(() => {
      setSSEState({ callStatus: 'ended' });
    });
    await act(async () => {
      vi.advanceTimersByTime(2600);
    });

    const bookDemo = await screen.findByRole('link', { name: /book a demo/i });
    fireEvent.click(bookDemo);

    await waitFor(() => {
      const tracked = fetchCalls.find(
        (c) =>
          c.url === '/api/demo/track-cta' &&
          c.method === 'POST' &&
          (c.body as Record<string, unknown>)?.ctaType === 'book_demo',
      );
      expect(tracked, 'Book a Demo click should POST ctaType=book_demo').toBeTruthy();
      expect((tracked!.body as Record<string, unknown>).agentType).toBe('medical');
    });

    expect(
      analyticsCalls.ctaClicks.some(
        (c) => c.ctaText === CTA.BOOK_DEMO && c.page === 'demo',
      ),
    ).toBe(true);

    await waitFor(() => {
      expect(screen.getByText(STUB_MARKERS.contact)).toBeTruthy();
    });
  });
});
