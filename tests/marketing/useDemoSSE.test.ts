// @vitest-environment happy-dom
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

import {
  useDemoSSE,
  lifecycleToCallStatus,
} from '../../client-app/src/hooks/useDemoSSE';

// ---------------------------------------------------------------------------
// EventSource mock — happy-dom does not ship one, and we need to be able to
// drive lifecycle / transcript / tool / activity events from the test body.
// Mirrors the DOM EventSource surface the hook actually touches: the
// constructor, addEventListener, close, onopen, and onerror.
// ---------------------------------------------------------------------------
class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  // Test helpers -------------------------------------------------------------
  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach((l) => l(event));
  }

  triggerOpen() {
    this.onopen?.();
  }

  triggerError() {
    this.onerror?.();
  }

  static reset() {
    MockEventSource.instances = [];
  }

  static get last(): MockEventSource | undefined {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Fetch mock — by default, /api/demo/active-call returns no active calls so
// individual tests can opt-in to surfacing one. Keeping a per-test handler
// override lets us model rejections, empty responses, and successful payloads
// from the same harness.
// ---------------------------------------------------------------------------
let activeCallPayload: {
  activeCalls: Array<{
    callId: string;
    state: string;
    agentName: string | null;
    startTime: string;
  }>;
} = { activeCalls: [] };

let fetchCalls: string[] = [];

beforeEach(() => {
  MockEventSource.reset();
  activeCallPayload = { activeCalls: [] };
  fetchCalls = [];

  vi.stubGlobal(
    'EventSource',
    MockEventSource as unknown as typeof EventSource,
  );
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(url);
    if (url === '/api/demo/active-call') {
      return new Response(JSON.stringify(activeCallPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ===========================================================================
// 1. lifecycleToCallStatus — pure-function coverage
// ---------------------------------------------------------------------------
// This is the most regression-prone surface of the hook: the server enum is
// authored in a different package and a typo / new state silently degrades to
// 'idle'. We pin every state the streaming API is documented to emit, plus
// guard the unknown-state fallback.
// ===========================================================================
describe('lifecycleToCallStatus', () => {
  const ringingStates = ['CALL_RECEIVED', 'SESSION_INITIALIZED'];
  const connectedStates = [
    'AGENT_CONNECTED',
    'ACTIVE_CONVERSATION',
    'WORKFLOW_EXECUTION',
    'TOOL_EXECUTION',
    'ESCALATION_CHECK',
    'ESCALATED',
  ];
  const endedStates = [
    'CALL_COMPLETED',
    'CALL_FAILED',
    'WORKFLOW_FAILED',
    'ESCALATION_FAILED',
  ];

  it.each(ringingStates)('maps %s -> ringing', (state) => {
    expect(lifecycleToCallStatus(state)).toBe('ringing');
  });

  it.each(connectedStates)('maps %s -> connected', (state) => {
    expect(lifecycleToCallStatus(state)).toBe('connected');
  });

  it.each(endedStates)('maps %s -> ended', (state) => {
    expect(lifecycleToCallStatus(state)).toBe('ended');
  });

  it('falls back to idle for unknown / future lifecycle states', () => {
    // Defending against a server-side enum addition: rather than crashing or
    // silently clamping to a wrong status, the hook should surface 'idle' so
    // the demo page renders its safe placeholder UI.
    expect(lifecycleToCallStatus('SOMETHING_BRAND_NEW')).toBe('idle');
    expect(lifecycleToCallStatus('')).toBe('idle');
  });
});

// ===========================================================================
// 2. End-to-end SSE wiring — poll, connect, apply events, tear down
// ---------------------------------------------------------------------------
// We assert the contract the Demo page consumes: polling /api/demo/active-call,
// opening an EventSource for any returned call, mapping inbound events into
// state, and cleaning up on unmount.
// ===========================================================================
describe('useDemoSSE — polling + EventSource lifecycle', () => {
  it('polls /api/demo/active-call, opens an EventSource for the returned call, and applies transcript / tool / activity events', async () => {
    activeCallPayload = {
      activeCalls: [
        {
          callId: 'call-abc',
          state: 'CALL_RECEIVED',
          agentName: 'Medical Front Desk',
          startTime: '2026-04-29T12:00:00Z',
        },
      ],
    };

    const { result } = renderHook(() => useDemoSSE());

    // Initial poll fires synchronously inside the mount effect; wait for the
    // EventSource to be created so we know connectToCall ran.
    await waitFor(() => {
      expect(fetchCalls).toContain('/api/demo/active-call');
      expect(MockEventSource.instances.length).toBe(1);
    });

    const es = MockEventSource.last!;
    expect(es.url).toBe('/api/demo/live/call-abc');

    // Simulate the stream coming online + delivering a CALL_RECEIVED frame.
    act(() => {
      es.triggerOpen();
      es.emit('call_state', {
        state: 'CALL_RECEIVED',
        agentName: 'Medical Front Desk',
        durationSeconds: 0,
      });
    });

    await waitFor(() => {
      expect(result.current.connected).toBe(true);
      expect(result.current.activeCallId).toBe('call-abc');
      expect(result.current.callStatus).toBe('ringing');
      expect(result.current.agentName).toBe('Medical Front Desk');
      expect(result.current.duration).toBe(0);
    });

    // Promote to connected and verify lifecycle mapping flows through the
    // EventSource path (not just the poll path).
    act(() => {
      es.emit('call_state', {
        state: 'ACTIVE_CONVERSATION',
        agentName: 'Medical Front Desk',
        durationSeconds: 12,
      });
    });
    await waitFor(() => {
      expect(result.current.callStatus).toBe('connected');
      expect(result.current.duration).toBe(12);
    });

    // Transcript events accumulate in arrival order so the UI renders the
    // conversation as it unfolds.
    act(() => {
      es.emit('transcript', {
        speaker: 'caller',
        text: 'Hi, I need to book an appointment.',
        timestamp: '2026-04-29T12:00:05Z',
      });
      es.emit('transcript', {
        speaker: 'agent',
        text: 'Of course — what day works for you?',
        timestamp: '2026-04-29T12:00:08Z',
      });
    });
    await waitFor(() => {
      expect(result.current.transcript).toHaveLength(2);
    });
    expect(result.current.transcript[0].speaker).toBe('caller');
    expect(result.current.transcript[0].text).toBe(
      'Hi, I need to book an appointment.',
    );
    expect(result.current.transcript[1].speaker).toBe('agent');
    // Each transcript message should get a unique id so React can keyed-render
    // without warnings.
    expect(result.current.transcript[0].id).not.toBe(
      result.current.transcript[1].id,
    );

    // tool_start should add a running tool, tool_end should resolve the
    // matching invocation by pairedStartId.
    act(() => {
      es.emit('tool_start', {
        invocationId: 'inv-1',
        tool: 'check_calendar',
        timestamp: '2026-04-29T12:00:09Z',
      });
    });
    await waitFor(() => {
      expect(result.current.tools).toHaveLength(1);
    });
    expect(result.current.tools[0]).toMatchObject({
      id: 'inv-1',
      tool: 'check_calendar',
      status: 'running',
    });

    act(() => {
      es.emit('tool_end', {
        pairedStartId: 'inv-1',
        tool: 'check_calendar',
        timestamp: '2026-04-29T12:00:10Z',
      });
    });
    await waitFor(() => {
      expect(result.current.tools[0].status).toBe('completed');
    });
    expect(result.current.tools[0].completedAt).toBe(
      '2026-04-29T12:00:10Z',
    );

    // Activity events flow into the system feed.
    act(() => {
      es.emit('activity', {
        id: 'act-1',
        eventType: 'state_transition',
        fromState: 'CALL_RECEIVED',
        toState: 'AGENT_CONNECTED',
        payload: { agent: 'Medical Front Desk' },
        timestamp: '2026-04-29T12:00:11Z',
      });
    });
    await waitFor(() => {
      expect(result.current.activityEvents).toHaveLength(1);
    });
    expect(result.current.activityEvents[0]).toMatchObject({
      id: 'act-1',
      eventType: 'state_transition',
      fromState: 'CALL_RECEIVED',
      toState: 'AGENT_CONNECTED',
    });
  });

  it('closes the EventSource and resets state when the call ends (after the 30s drain window)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    activeCallPayload = {
      activeCalls: [
        {
          callId: 'call-xyz',
          state: 'AGENT_CONNECTED',
          agentName: 'HVAC Dispatcher',
          startTime: '2026-04-29T12:00:00Z',
        },
      ],
    };

    const { result } = renderHook(() => useDemoSSE());

    // The polling effect kicks off an async fetch on mount. With fake timers
    // the microtask still runs, so wait for the EventSource to materialise.
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(1);
    });
    const es = MockEventSource.last!;
    expect(result.current.activeCallId).toBe('call-xyz');

    // Simulate the call ending. The hook keeps the stream open for 30s so the
    // UI can show the post-call summary, then resets to idle.
    act(() => {
      es.emit('call_state', {
        state: 'CALL_COMPLETED',
        agentName: 'HVAC Dispatcher',
        durationSeconds: 60,
      });
    });
    await waitFor(() => {
      expect(result.current.callStatus).toBe('ended');
    });
    // EventSource must remain open during the drain window so any final
    // transcript / tool events can still arrive.
    expect(es.closed).toBe(false);

    // Advance past the 30-second post-call drain.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    await waitFor(() => {
      expect(result.current.callStatus).toBe('idle');
      expect(result.current.activeCallId).toBeNull();
      expect(result.current.connected).toBe(false);
    });
    expect(es.closed).toBe(true);
  });

  it('closes the EventSource and clears the polling interval on unmount', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    activeCallPayload = {
      activeCalls: [
        {
          callId: 'call-unmount',
          state: 'AGENT_CONNECTED',
          agentName: 'Medical Front Desk',
          startTime: '2026-04-29T12:00:00Z',
        },
      ],
    };

    const { unmount } = renderHook(() => useDemoSSE());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(1);
    });
    const es = MockEventSource.last!;
    expect(es.closed).toBe(false);

    unmount();

    expect(es.closed).toBe(true);
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });
});

// ===========================================================================
// 3. Activity dedup — protects the system feed from duplicate id replays
// ---------------------------------------------------------------------------
// The streaming layer occasionally re-delivers an event after a transient
// disconnect. The hook dedupes by id; if that protection regresses, the feed
// renders the same row twice.
// ===========================================================================
describe('useDemoSSE — activity dedup', () => {
  it('drops duplicate activity events with the same id', async () => {
    activeCallPayload = {
      activeCalls: [
        {
          callId: 'call-dedup',
          state: 'AGENT_CONNECTED',
          agentName: 'Medical Front Desk',
          startTime: '2026-04-29T12:00:00Z',
        },
      ],
    };

    const { result } = renderHook(() => useDemoSSE());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBe(1);
    });
    const es = MockEventSource.last!;

    const sample = {
      id: 'act-duplicate',
      eventType: 'state_transition',
      fromState: 'CALL_RECEIVED',
      toState: 'AGENT_CONNECTED',
      payload: { agent: 'Medical Front Desk' },
      timestamp: '2026-04-29T12:00:01Z',
    };

    act(() => {
      es.emit('activity', sample);
      // Same id, slightly different payload — the dedup is by id only.
      es.emit('activity', { ...sample, payload: { agent: 'Other' } });
      es.emit('activity', sample);
    });

    await waitFor(() => {
      expect(result.current.activityEvents).toHaveLength(1);
    });

    // The retained event should be the first one we delivered (dedup keeps
    // the original, not the latest).
    expect(result.current.activityEvents[0].payload).toEqual({
      agent: 'Medical Front Desk',
    });

    // A genuinely new id should still get through.
    act(() => {
      es.emit('activity', { ...sample, id: 'act-second' });
    });
    await waitFor(() => {
      expect(result.current.activityEvents).toHaveLength(2);
    });
    expect(result.current.activityEvents[1].id).toBe('act-second');
  });
});
