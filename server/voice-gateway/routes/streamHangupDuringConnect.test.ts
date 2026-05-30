import { createServer, type Server as HTTPServer } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Regression test for the "caller hangs up while the AI voice session is
// still connecting" race. The two production bugs this guards against were:
//   1. No audio + the demo live-call UI never ending, because the stream
//      transitioned to ACTIVE_CONVERSATION *after* the caller had already
//      hung up (reverting the call out of its terminal state).
//   2. An orphaned realtime session whose silence timer fires forever,
//      because finalizeStream() ran before callSessionId was set / the
//      session was never torn down.
//
// The fix lives in the `streamEnded` guards around `session.connect()` in
// stream.ts. This test drives the real WebSocket handler end-to-end with a
// fake realtime session whose `connect()` we hold open, then delivers the
// Twilio "stop" event DURING that connect, and asserts the call lands in a
// terminal lifecycle state, NEVER transitions to ACTIVE_CONVERSATION, and
// that the session is torn down (the close() that clears the silence timer).

const h = vi.hoisted(() => {
  let resolveConnectStarted!: () => void;
  const connectStarted = new Promise<void>((r) => {
    resolveConnectStarted = r;
  });
  let resolveConnect!: () => void;
  const connectDeferred = new Promise<void>((r) => {
    resolveConnect = r;
  });

  const sessionCloseMock = vi.fn(async () => {});
  const sessionConnectMock = vi.fn(() => {
    resolveConnectStarted();
    return connectDeferred;
  });

  const updateCallStateMock = vi.fn(async (..._args: unknown[]) => {});
  const writeCallEventMock = vi.fn(async (..._args: unknown[]) => {});
  const finalizeCallSessionMock = vi.fn(async (..._args: unknown[]) => {});

  const handleTwilioStatusCallbackMock = vi.fn();

  return {
    connectStarted,
    resolveConnect,
    sessionCloseMock,
    sessionConnectMock,
    updateCallStateMock,
    writeCallEventMock,
    finalizeCallSessionMock,
    handleTwilioStatusCallbackMock,
    callSessionId: 'cs-hangup-during-connect',
  };
});

vi.mock('../services/openaiSession', () => ({
  createRealtimeSession: vi.fn(async () => ({
    session: {
      connect: h.sessionConnectMock,
      close: h.sessionCloseMock,
    },
    callSessionId: h.callSessionId,
    onOpenAIAudio: vi.fn(),
    triggerGreeting: vi.fn(),
    sendAudioToOpenAI: vi.fn(),
    sendSystemMessage: vi.fn(),
    rebuildForHandoff: vi.fn(),
    costTracker: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      captureSource: 'estimate' as const,
      ttsCharacters: 0,
      cacheHits: 0,
      cacheMisses: 0,
      promptTokensSaved: 0,
      routingDecisions: [],
    },
    routedModel: 'gpt-4o-realtime-preview',
    routedTier: 'standard',
  })),
}));

vi.mock('../services/callPersistence', () => ({
  writeCallEvent: h.writeCallEventMock,
  updateCallState: h.updateCallStateMock,
  finalizeCallSession: h.finalizeCallSessionMock,
}));

vi.mock('../services/numberLookup', () => ({
  getAgentConfig: vi.fn(async () => ({ type: 'general' })),
  getAgentToolOverrides: vi.fn(async () => []),
}));

vi.mock('../services/agentLoader', () => ({
  loadAgentConfig: vi.fn(() => ({
    agentId: 'a-1',
    tenantId: 't-1',
    systemPrompt: '',
    greeting: 'Hello',
    voice: 'alloy',
    model: 'gpt-4o-realtime-preview',
    language: 'en',
    tools: [],
    guardrails: [],
    metadata: {},
  })),
}));

vi.mock('../services/escalation', () => ({
  EscalationController: class {
    escalateCall = vi.fn(async () => ({ success: true, message: 'ok' }));
  },
}));

vi.mock('./twilio', () => ({
  getCoordinator: vi.fn(() => ({
    getCallRecord: vi.fn(() => undefined),
    handleTwilioStatusCallback: h.handleTwilioStatusCallbackMock,
    on: vi.fn(),
    removeListener: vi.fn(),
  })),
  getTwilioAdapter: vi.fn(() => undefined),
}));

vi.mock('../../../platform/workflow/engine/WorkflowEngine', () => ({
  WorkflowEngine: class {
    setTraceContext = vi.fn();
    classifyIntent = vi.fn(() => ({ intent: 'unknown', confidence: 'low' }));
    recordTransition = vi.fn();
  },
}));

vi.mock('../../../platform/billing/budget/BudgetGuardService', () => ({
  BudgetGuardService: class {
    getStatus = vi.fn(async () => ({ isWarning: false, percentUsed: 0 }));
  },
}));

vi.mock('../../../platform/billing/budget/checkBudget', () => ({
  checkBudget: vi.fn(async () => ({ allowed: true, isTrial: false })),
}));

vi.mock('../../../platform/infra/memory/CallerMemoryService', () => ({
  CallerMemoryService: class {
    getCallerMemory = vi.fn(async () => null);
  },
}));

vi.mock('../../../platform/integrations/outbox/OutboxService', () => ({
  OutboxService: class {},
}));

vi.mock('../services/platformAdapters', () => ({
  createCallerMemoryStorage: vi.fn(() => ({})),
  createOutboxAdapters: vi.fn(() => ({ persistence: {}, integration: {} })),
}));

vi.mock('../../../platform/analytics/CsatSurveyService', () => ({
  dispatchSmsCsatSurvey: vi.fn(async () => {}),
  getTenantCsatSettings: vi.fn(async () => ({ enabled: false, channel: 'sms', minDurationSeconds: 0, scale: 5, smsTemplate: '' })),
}));

vi.mock('../../../platform/integrations/twilio/sender', () => ({
  sendTwilioSms: vi.fn(async () => {}),
}));

vi.mock('../../../platform/campaigns', () => ({
  classifyCallOutcome: vi.fn(() => 'completed'),
  updateContactStatus: vi.fn(async () => {}),
  addToDnc: vi.fn(async () => {}),
  getCampaign: vi.fn(async () => null),
  getContact: vi.fn(async () => null),
  buildCampaignTypePromptAugmentation: vi.fn(() => ''),
  classifyTypeDisposition: vi.fn(() => 'no_response'),
  updateContactTypeDisposition: vi.fn(async () => {}),
}));

vi.mock('../../../platform/core/observability', () => ({
  writeCallMetric: vi.fn(async () => {}),
}));

vi.mock('../../../platform/analytics/QualityScorerService', () => ({
  scoreCall: vi.fn(async () => {}),
}));

vi.mock('../../../platform/analytics/SentimentAnalysisService', () => ({
  analyzeCallSentiment: vi.fn(async () => {}),
}));

vi.mock('../../../platform/analytics/TopicClusteringService', () => ({
  classifyCallTopic: vi.fn(async () => {}),
}));

vi.mock('../../../platform/billing/usage/UsageRecorder', () => ({
  recordCallUsage: vi.fn(async () => {}),
  estimateCallCostWithLiveRate: vi.fn(async () => ({ totalCostCents: 0 })),
}));

vi.mock('../../../platform/billing/cost', () => ({
  recordConversationCost: vi.fn(async () => {}),
  logRoutingDecision: vi.fn(async () => {}),
}));

vi.mock('../../../platform/widget/WidgetTokenService', () => ({
  validateWidgetToken: vi.fn(async () => null),
  getWidgetConfig: vi.fn(async () => null),
  getPublicWidgetConfig: vi.fn(async () => null),
}));

vi.mock('../../../platform/workforce/HandoffEngine', () => ({
  HandoffEngine: class {},
}));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: vi.fn(() => ({
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })),
  })),
  withTenantContext: vi.fn(async (_client: unknown, _tenantId: string, fn: () => unknown) => fn()),
}));

import { attachWebSocket } from './stream';

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition not met within timeout');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Twilio stream — caller hangs up during session.connect()', () => {
  let server: HTTPServer;
  let port: number;
  const prevApiKey = process.env.OPENAI_API_KEY;
  const prevStreamToken = process.env.VOICE_GATEWAY_STREAM_TOKEN;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.VOICE_GATEWAY_STREAM_TOKEN;
    server = createServer();
    attachWebSocket(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevApiKey;
    if (prevStreamToken === undefined) delete process.env.VOICE_GATEWAY_STREAM_TOKEN;
    else process.env.VOICE_GATEWAY_STREAM_TOKEN = prevStreamToken;
  });

  beforeEach(() => {
    h.sessionCloseMock.mockClear();
    h.sessionConnectMock.mockClear();
    h.updateCallStateMock.mockClear();
    h.writeCallEventMock.mockClear();
    h.finalizeCallSessionMock.mockClear();
    h.handleTwilioStatusCallbackMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('ends in CALL_COMPLETED, never reaches ACTIVE_CONVERSATION, and tears down the session', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // 1. Twilio "start" — kicks off setup and createRealtimeSession().
    ws.send(
      JSON.stringify({
        event: 'start',
        start: {
          streamSid: 'MZ-test-stream',
          customParameters: {
            tenantId: 't-1',
            agentId: 'a-1',
            agentType: 'general',
            callSid: 'CA-test-call',
            callerNumber: '+15551234567',
            calledNumber: '+15557654321',
          },
        },
      }),
    );

    // 2. Wait until session.connect() has been entered (the connect promise
    //    is still pending — we are now "DURING connect").
    await h.connectStarted;
    expect(h.sessionConnectMock).toHaveBeenCalledTimes(1);

    // 3. Caller hangs up: Twilio "stop" arrives DURING connect.
    ws.send(JSON.stringify({ event: 'stop' }));

    // 4. finalizeStream() runs and finalizes the call as completed.
    await waitFor(() => h.finalizeCallSessionMock.mock.calls.length > 0);

    // 5. Now let the in-flight connect() resolve — the post-connect guard
    //    must see streamEnded and bail out before ACTIVE_CONVERSATION.
    h.resolveConnect();

    // Give the resumed start handler a few ticks to run its post-connect path.
    await new Promise((r) => setTimeout(r, 50));

    // Terminal state: finalized as completed + the CALL_COMPLETED event.
    expect(h.finalizeCallSessionMock).toHaveBeenCalledWith(
      't-1',
      h.callSessionId,
      'completed',
      expect.any(Number),
      expect.any(Number),
    );
    const completedEvents = h.writeCallEventMock.mock.calls.filter(
      (c) => c[2] === 'call_completed' && c[4] === 'CALL_COMPLETED',
    );
    expect(completedEvents.length).toBe(1);

    // It must NEVER transition (back) to ACTIVE_CONVERSATION.
    const activeTransitions = h.updateCallStateMock.mock.calls.filter(
      (c) => c[2] === 'ACTIVE_CONVERSATION',
    );
    expect(activeTransitions.length).toBe(0);

    // The session is torn down exactly once — this close() is what clears
    // the realtime session's silence timer in production, so it can never
    // fire on an orphaned session.
    expect(h.sessionCloseMock).toHaveBeenCalledTimes(1);

    // Twilio call is marked completed downstream.
    expect(h.handleTwilioStatusCallbackMock).toHaveBeenCalledWith('CA-test-call', 'completed');

    ws.close();
  });
});
