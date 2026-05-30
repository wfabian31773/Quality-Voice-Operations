import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Companion to openaiSessionSilenceTimer.test.ts. createRealtimeSession arms a
// second per-call timer besides the silence watchdog: a 30s budget-check
// setInterval. It used to be cleared ONLY via the sessionManager `cleanup`
// callback, which the hangup teardown path (finalizeStream -> session.close()
// -> sessionManager.unregister) never invokes. So the budget interval kept
// firing on an already-ended call — a slow resource leak under call churn.
// This test proves the realtime session `close` handler now clears it.

const h = vi.hoisted(() => {
  const checkConversationBudgetMock = vi.fn(async () => ({
    shouldEndCall: false,
    shouldDowngrade: false,
    shouldAlert: false,
    budgetCents: 1000,
    percentUsed: 0,
  }));
  return { checkConversationBudgetMock };
});

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
  createCallSession: vi.fn(async () => 'cs-budget-timer'),
  writeCallEvent: vi.fn(async () => {}),
  updateCallState: vi.fn(async () => {}),
  createPlatformPersistenceAdapter: vi.fn(() => ({})),
}));

vi.mock('../../../platform/knowledge/knowledgeContext', () => ({
  hasKnowledgeArticles: vi.fn(async () => false),
}));

vi.mock('../../../platform/billing/cost', () => ({
  routeQuery: vi.fn(() => ({ tier: 'economy', model: 'gpt-4o-mini-realtime-preview', reason: 'test', complexityScore: 0 })),
  checkConversationBudget: h.checkConversationBudgetMock,
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
    handleSilence = vi.fn(() => ({ recoveryPrompt: 'Are you still there?' }));
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
    agentId: 'a-budget',
    tenantId: 't-budget',
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
    tenantId: 't-budget' as never,
    agentConfig: makeAgentConfig() as never,
    callerNumber: '+15551112222',
    calledNumber: '+15553334444',
    callSid: 'CA-budget',
    direction: 'inbound' as const,
    lifecycleCoordinator: coordinator as never,
  };
}

describe('openaiSession budget-check timer', () => {
  const prevApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.OPENAI_API_KEY = 'test-key';
    h.checkConversationBudgetMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (prevApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevApiKey;
    sessionManager.unregister('cs-budget-timer');
  });

  it('arms a budget-check interval that fires while the session stays open', async () => {
    // Control: without a close, the budget interval must actually fire after
    // the 30s threshold — proving the timer is real and armed.
    const coordinator = makeCoordinator();
    const result = await createRealtimeSession(makeCtx(coordinator));

    expect(h.checkConversationBudgetMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31000);
    expect(h.checkConversationBudgetMock).toHaveBeenCalledTimes(1);

    await result.session.close();
  });

  it('clears the budget-check interval when the realtime session closes (hangup teardown)', async () => {
    const coordinator = makeCoordinator();
    const result = await createRealtimeSession(makeCtx(coordinator));

    // Simulate the teardown finalizeStream() performs on hangup: close the
    // realtime session directly (NOT via sessionManager.cleanup). The close
    // handler must clear the budget interval.
    await result.session.close();

    // Advance well past several 30s windows — the budget interval must NOT
    // fire, because close() cleared it. A regression that leaks the timer
    // would call checkConversationBudget here.
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.checkConversationBudgetMock).not.toHaveBeenCalled();
  });

  it('keeps the budget-check interval running across a budget-triggered model downgrade', async () => {
    // Regression: the 30s budget interval reaches the downgrade threshold and
    // calls rebuildForHandoff to swap to the economy model. That swap closes
    // the realtime session, but the close handler must short-circuit on the
    // `isHandoffSwap` flag and NOT clear the budget interval — otherwise cost
    // metering silently stops the moment a call gets downgraded. The interval
    // is a single setInterval the rebuild never touches, so it must keep firing
    // on the fresh session, and a real hangup afterward must still tear it down.
    const coordinator = makeCoordinator();

    // First budget check trips the downgrade; later checks are benign so the
    // hasDowngraded guard prevents a second swap.
    h.checkConversationBudgetMock.mockImplementationOnce(async () => ({
      shouldEndCall: false,
      shouldDowngrade: true,
      shouldAlert: false,
      budgetCents: 1000,
      percentUsed: 80,
    }));

    const result = await createRealtimeSession(makeCtx(coordinator));
    const originalSession = result.session;

    // First interval fire → budget threshold → handoff swap to economy model.
    await vi.advanceTimersByTimeAsync(31000);
    expect(h.checkConversationBudgetMock).toHaveBeenCalledTimes(1);

    // The swap closed the original session and built a fresh one. The
    // transient handoff close must NOT have torn the call down.
    expect(originalSession.close).toHaveBeenCalledTimes(1);
    const swappedSession = result.session;
    expect(swappedSession).not.toBe(originalSession);

    // The budget interval survived the swap: it keeps firing on the new
    // session across the next two 30s windows.
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.checkConversationBudgetMock).toHaveBeenCalledTimes(3);

    // A genuine hangup on the post-swap session (isHandoffSwap === false) runs
    // the terminal cleanup and clears the interval for good.
    await swappedSession.close();
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.checkConversationBudgetMock).toHaveBeenCalledTimes(3);
  });
});
