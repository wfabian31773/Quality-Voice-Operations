import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./xaiRealtimeTransport', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('events');
  class FakeTransport extends NodeEventEmitter {
    sendAudio = vi.fn();
    sendEvent = vi.fn();
    connect = vi.fn(async () => {});
    close = vi.fn(() => {
      this.emit('close');
    });
    updateSession = vi.fn();
    setFunctionHandler = vi.fn();
  }
  class FakeSession extends NodeEventEmitter {
    connect = vi.fn(async () => {});
    close = vi.fn(() => {
      this.emit('close');
    });
    updateSession = vi.fn();
    setFunctionHandler = vi.fn();
  }
  return {
    XaiRealtimeTransport: FakeTransport,
    XaiVoiceSession: FakeSession,
  };
});

vi.mock('./callPersistence', () => ({
  createCallSession: vi.fn(async () => 'cs-create'),
  writeCallEvent: vi.fn(async () => {}),
  updateCallState: vi.fn(async () => {}),
  createPlatformPersistenceAdapter: vi.fn(() => ({})),
}));

const hasKnowledgeArticles = vi.fn(async () => true);
vi.mock('../../../platform/knowledge/knowledgeContext', () => ({
  hasKnowledgeArticles: (...args: unknown[]) => hasKnowledgeArticles(...args),
}));

const wakeUp = vi.fn(async () => {});
vi.mock('../../../platform/integrations/azul-vision/ticketingClient', () => ({
  wakeUp: (...args: unknown[]) => wakeUp(...args),
}));

vi.mock('../../../platform/billing/cost', () => ({
  routeQuery: vi.fn(() => ({ tier: 'standard', model: 'grok-voice-think-fast-2.0', reason: 'test', complexityScore: 0 })),
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
    initialize = vi.fn(async () => ({ isReturningCaller: true }));
    getCallerContextPrompt = vi.fn(() => 'Known caller returning for a lockout.');
    setCallSessionId = vi.fn();
    getSafetyPolicyPrompt = vi.fn(() => '');
    handleSilence = vi.fn(() => ({ recoveryPrompt: null }));
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

describe('createRealtimeSession xAI constructor path', () => {
  beforeEach(() => {
    process.env.XAI_API_KEY = 'test-xai-key';
    hasKnowledgeArticles.mockResolvedValue(true);
    wakeUp.mockClear();
  });

  afterEach(() => {
    delete process.env.XAI_API_KEY;
    sessionManager.unregister('cs-create');
  });

  it('opens one xAI session with memory, knowledge, budget warning, and Azul wake-up', async () => {
    const coordinator = makeCoordinator();
    const result = await createRealtimeSession({
      tenantId: 't-create' as never,
      agentConfig: {
        agentId: 'a-create',
        tenantId: 't-create',
        systemPrompt: 'You are the receptionist.',
        rolePrompt: 'Answer the phone.',
        greeting: 'Hello',
        voice: 'eve',
        model: 'grok-voice-think-fast-2.0',
        language: 'en',
        preferredLanguage: 'en',
        timeZone: 'America/New_York',
        tools: [{ name: 'create_ticket', description: 'Create a ticket', parameters: { type: 'object', properties: {} } }],
        guardrails: [],
        metadata: { practiceName: 'Azul Vision' },
        coreVersion: '2.0.0',
        rolePackageId: 'core-receptionist',
        rolePackageVersion: '1.0.0',
      } as never,
      callerNumber: '+15551112222',
      calledNumber: '+15553334444',
      callSid: 'CA-create',
      direction: 'inbound',
      templateKey: 'core-receptionist',
      lifecycleCoordinator: coordinator as never,
      budgetGuard: {
        getStatus: vi.fn(async () => ({ isWarning: true, percentUsed: 0.86 })),
      } as never,
      callerMemory: {
        getCallerMemory: vi.fn(async () => ({
          totalCalls: 4,
          lastCallDate: '2026-08-01',
          openTickets: ['T-9'],
        })),
      } as never,
      workflowEngine: {
        classifyIntent: vi.fn(() => ({ intent: 'unknown', confidence: 'low' })),
        recordTransition: vi.fn(),
      } as never,
    });

    expect(result.callSessionId).toBe('cs-create');
    expect(coordinator.registerCall).toHaveBeenCalledWith(expect.objectContaining({
      twilioCallSid: 'CA-create',
      agentSlug: 'a-create',
    }));
    expect(hasKnowledgeArticles).toHaveBeenCalled();
    expect(wakeUp).toHaveBeenCalled();

    result.session.emit('history_added', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'I am locked out of my shop.' }],
    });
    result.session.emit('history_added', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'I can help with that.' }],
    });

    await result.session.close();
  });
});
