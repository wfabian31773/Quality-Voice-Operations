import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Companion to streamHangupDuringConnect.test.ts. That test proves the
// stream handler tears down the session (calls session.close()) when the
// caller hangs up during connect. This test proves the *consequence* of
// that close() on the real realtime session: the per-call silence timer is
// cleared, so it can never fire on an orphaned session (one of the two
// original bugs — a silence timer firing forever after hangup).

const h = vi.hoisted(() => {
  const handleSilenceMock = vi.fn(() => ({ recoveryPrompt: 'Are you still there?' }));
  return { handleSilenceMock };
});

// Fake OpenAI Agents SDK — just enough surface for createRealtimeSession.
// Defined inside the factory because vi.mock is hoisted above the imports.
vi.mock('@openai/agents/realtime', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('events');
  class FakeTransport extends NodeEventEmitter {
    sendAudio = vi.fn();
    sendEvent = vi.fn();
  }
  class FakeRealtimeSession extends NodeEventEmitter {
    connect = vi.fn(async () => {});
    close = vi.fn(async () => {
      this.emit('close');
    });
  }
  class FakeRealtimeAgent {
    constructor(_opts: unknown) {}
  }
  return {
    RealtimeAgent: FakeRealtimeAgent,
    RealtimeSession: FakeRealtimeSession,
    OpenAIRealtimeWebSocket: FakeTransport,
    tool: vi.fn((def: unknown) => def),
  };
});

vi.mock('./callPersistence', () => ({
  createCallSession: vi.fn(async () => 'cs-silence-timer'),
  writeCallEvent: vi.fn(async () => {}),
  updateCallState: vi.fn(async () => {}),
  createPlatformPersistenceAdapter: vi.fn(() => ({})),
}));

vi.mock('../../../platform/knowledge/knowledgeContext', () => ({
  hasKnowledgeArticles: vi.fn(async () => false),
}));

vi.mock('../../../platform/billing/cost', () => ({
  routeQuery: vi.fn(() => ({ tier: 'economy', model: 'gpt-4o-mini-realtime-preview', reason: 'test', complexityScore: 0 })),
  checkConversationBudget: vi.fn(async () => ({ shouldEndCall: false, shouldDowngrade: false, shouldAlert: false, budgetCents: 1000, percentUsed: 0 })),
  getConversationCostRunningTotal: vi.fn(async () => 0),
  recordConversationCost: vi.fn(async () => {}),
  logRoutingDecision: vi.fn(async () => {}),
  getSessionCacheCounters: vi.fn(() => ({ hits: 0, misses: 0 })),
  clearSessionCacheCounters: vi.fn(),
}));

vi.mock('../../../platform/reasoning', () => ({
  ReasoningEngine: class {
    constructor(_cfg: unknown) {}
    initialize = vi.fn(async () => ({ isReturningCaller: false }));
    getCallerContextPrompt = vi.fn(() => null);
    setCallSessionId = vi.fn();
    getSafetyPolicyPrompt = vi.fn(() => '');
    handleSilence = h.handleSilenceMock;
    classifyIntent = vi.fn(() => ({ intent: 'unknown', confidence: 'low' }));
    getCallSummary = vi.fn(() => ({ totalTurns: 0, escalationCount: 0 }));
    getTraceEntries = vi.fn(() => []);
  },
}));

import { createRealtimeSession } from './openaiSession';
import { sessionManager } from './sessionManager';

function makeCoordinator() {
  return {
    registerCall: vi.fn(),
    appendTranscript: vi.fn(),
    handleOpenAiSessionEnd: vi.fn(),
    getCallRecord: vi.fn(() => undefined),
  };
}

function makeAgentConfig() {
  return {
    agentId: 'a-silence',
    tenantId: 't-silence',
    systemPrompt: 'You are a test agent.',
    greeting: 'Hello',
    voice: 'alloy',
    model: 'gpt-4o-realtime-preview',
    language: 'en',
    tools: [],
    guardrails: [],
    metadata: {},
  };
}

function makeCtx(coordinator: ReturnType<typeof makeCoordinator>) {
  return {
    tenantId: 't-silence' as never,
    agentConfig: makeAgentConfig() as never,
    callerNumber: '+15551112222',
    calledNumber: '+15553334444',
    callSid: 'CA-silence',
    direction: 'inbound' as const,
    lifecycleCoordinator: coordinator as never,
  };
}

describe('openaiSession silence timer', () => {
  const prevApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.OPENAI_API_KEY = 'test-key';
    h.handleSilenceMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (prevApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevApiKey;
    sessionManager.unregister('cs-silence-timer');
  });

  it('arms a silence watchdog that fires when the session stays open', async () => {
    // Control: without a close, the silence timer must actually fire after
    // the threshold — proving the timer is real and armed.
    const coordinator = makeCoordinator();
    const result = await createRealtimeSession(makeCtx(coordinator));

    expect(h.handleSilenceMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16000);
    expect(h.handleSilenceMock).toHaveBeenCalledTimes(1);

    await result.session.close();
  });

  it('clears the silence watchdog when the realtime session closes (hangup teardown)', async () => {
    const coordinator = makeCoordinator();
    const result = await createRealtimeSession(makeCtx(coordinator));

    // Simulate the teardown finalizeStream() performs on hangup: close the
    // realtime session. The close handler must clear the silence timer.
    await result.session.close();

    // Advance well past the 15s threshold — the silence watchdog must NOT
    // fire, because close() cleared it. A regression that leaks the timer
    // would call handleSilence here.
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.handleSilenceMock).not.toHaveBeenCalled();
  });
});
