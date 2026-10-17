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
  createCallSession: vi.fn(async () => 'cs-handoff'),
  writeCallEvent: vi.fn(async () => {}),
  updateCallState: vi.fn(async () => {}),
  createPlatformPersistenceAdapter: vi.fn(() => ({})),
}));

vi.mock('../../../platform/knowledge/knowledgeContext', () => ({
  hasKnowledgeArticles: vi.fn(async () => false),
}));

vi.mock('../../../platform/integrations/azul-vision/ticketingClient', () => ({
  wakeUp: vi.fn(async () => {}),
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

import { createRealtimeSession } from './openaiSession';
import { sessionManager } from './sessionManager';
import type { SessionContext } from './openaiSession';

function makeCoordinator() {
  return {
    registerCall: vi.fn(),
    appendTranscript: vi.fn(),
    handleOpenAiSessionEnd: vi.fn(),
    getCallRecord: vi.fn(() => undefined),
  };
}

describe('createRealtimeSession workforce handoff transfer', () => {
  beforeEach(() => {
    process.env.XAI_API_KEY = 'test-xai-key';
  });

  afterEach(() => {
    delete process.env.XAI_API_KEY;
    sessionManager.unregister('cs-handoff');
  });

  it('transfers when a workforce handoff is available even without an on-call number', async () => {
    const ctx = {
      tenantId: 't-handoff' as never,
      agentConfig: {
        agentId: 'a-salon',
        tenantId: 't-handoff',
        systemPrompt: 'You are the receptionist.',
        rolePrompt: 'Answer the phone.',
        greeting: 'Hello',
        voice: 'eve',
        model: 'grok-voice-think-fast-2.0',
        language: 'en',
        preferredLanguage: 'en',
        timeZone: 'America/New_York',
        tools: [
          { name: 'transfer_to_agent', description: 'Transfer to a teammate', parameters: { type: 'object', properties: {} } },
          { name: 'create_ticket', description: 'Create a ticket', parameters: { type: 'object', properties: {} } },
          { name: 'escalate_to_human', description: 'Escalate', parameters: { type: 'object', properties: {} } },
        ],
        guardrails: [],
        metadata: { practiceName: 'Demo Cuts' },
        coreVersion: '2.0.0',
        rolePackageId: 'salon',
        rolePackageVersion: '1.0.0',
      } as never,
      callerNumber: '+15551112222',
      calledNumber: '+15553334444',
      callSid: 'CA-handoff',
      direction: 'inbound',
      templateKey: 'salon',
      lifecycleCoordinator: makeCoordinator() as never,
      onHandoff: async () => ({ success: true, message: 'Transferring you now.' }),
    } satisfies Partial<SessionContext> as SessionContext;

    const result = await createRealtimeSession(ctx);
    const engine = ctx.reasoningEngine;
    expect(engine).toBeDefined();

    const utterance = 'I want to talk to a person';
    const classified = engine!.classifyIntent(utterance);
    const decision = engine!.processUtterance(utterance, classified.intent, classified.confidence);

    expect(decision.action).toBe('escalate_to_human');
    expect(decision.escalation?.output).toBe('warm_transfer');
    expect(decision.toolToExecute).not.toBe('create_ticket');
    expect(decision.fallbackStep).not.toBe('create_ticket');

    await result.session.close();
  });

  function salonCtx(overrides: Partial<SessionContext>): SessionContext {
    return {
      tenantId: 't-handoff' as never,
      agentConfig: {
        agentId: 'a-salon',
        tenantId: 't-handoff',
        systemPrompt: 'You are the receptionist.',
        rolePrompt: 'Answer the phone.',
        greeting: 'Hello',
        voice: 'eve',
        model: 'grok-voice-think-fast-2.0',
        language: 'en',
        preferredLanguage: 'en',
        timeZone: 'America/New_York',
        tools: [
          { name: 'transfer_to_agent', description: 'Transfer to a teammate', parameters: { type: 'object', properties: {} } },
          { name: 'create_ticket', description: 'Create a ticket', parameters: { type: 'object', properties: {} } },
          { name: 'escalate_to_human', description: 'Escalate', parameters: { type: 'object', properties: {} } },
        ],
        guardrails: [],
        metadata: { practiceName: 'Demo Cuts' },
        coreVersion: '2.0.0',
        rolePackageId: 'salon',
        rolePackageVersion: '1.0.0',
      } as never,
      callerNumber: '+15551112222',
      calledNumber: '+15553334444',
      callSid: 'CA-handoff-live',
      direction: 'inbound',
      templateKey: 'salon',
      lifecycleCoordinator: makeCoordinator() as never,
      ...overrides,
    } as SessionContext;
  }

  it('shadow (salon default): an ask-for-a-person is logged as would_escalate, with no reasoning-driven transfer', async () => {
    const onHandoff = vi.fn(async () => ({ success: true, message: 'Transferring you now.' }));
    const onEscalation = vi.fn(async () => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const ctx = salonCtx({ onHandoff, onEscalation });

    const result = await createRealtimeSession(ctx);
    expect(ctx.reasoningGate?.mode).toBe('shadow');
    const session = result.session as unknown as { emit: (event: string, payload: unknown) => boolean };
    session.emit('history_added', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'I want to talk to a person' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onHandoff).not.toHaveBeenCalled();
    expect(onEscalation).not.toHaveBeenCalled();
    const shadowLines = info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('reasoning_shadow'));
    expect(shadowLines).toHaveLength(1);
    expect(shadowLines[0]).toContain('"would_escalate":true');
    expect(shadowLines[0]).not.toContain('talk to a person');
    info.mockRestore();

    await result.session.close();
  });

  it('enforce: routes a workforce-only ask-for-a-person through onHandoff, not the dead-end onEscalation path', async () => {
    const onHandoff = vi.fn(async () => ({ success: true, message: 'Transferring you now.' }));
    const onEscalation = vi.fn(async () => {});
    const ctx = {
      tenantId: 't-handoff' as never,
      agentConfig: {
        agentId: 'a-salon',
        tenantId: 't-handoff',
        systemPrompt: 'You are the receptionist.',
        rolePrompt: 'Answer the phone.',
        greeting: 'Hello',
        voice: 'eve',
        model: 'grok-voice-think-fast-2.0',
        language: 'en',
        preferredLanguage: 'en',
        timeZone: 'America/New_York',
        tools: [
          { name: 'transfer_to_agent', description: 'Transfer to a teammate', parameters: { type: 'object', properties: {} } },
          { name: 'create_ticket', description: 'Create a ticket', parameters: { type: 'object', properties: {} } },
          { name: 'escalate_to_human', description: 'Escalate', parameters: { type: 'object', properties: {} } },
        ],
        guardrails: [],
        metadata: { practiceName: 'Demo Cuts' },
        coreVersion: '2.0.0',
        rolePackageId: 'salon',
        rolePackageVersion: '1.0.0',
      } as never,
      callerNumber: '+15551112222',
      calledNumber: '+15553334444',
      callSid: 'CA-handoff-live',
      direction: 'inbound',
      templateKey: 'salon',
      reasoningMode: 'enforce',
      lifecycleCoordinator: makeCoordinator() as never,
      onHandoff,
      onEscalation,
    } satisfies Partial<SessionContext> as SessionContext;

    const result = await createRealtimeSession(ctx);
    const session = result.session as unknown as { emit: (event: string, payload: unknown) => boolean };
    session.emit('history_added', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'I want to talk to a person' }],
    });

    await vi.waitFor(() => expect(onHandoff).toHaveBeenCalled());
    expect(onEscalation).not.toHaveBeenCalled();
    expect(onHandoff).toHaveBeenCalledWith(
      'cs-handoff',
      'human_request',
      expect.stringMatching(/human|person|transfer/i),
    );

    await result.session.close();
  });
});

