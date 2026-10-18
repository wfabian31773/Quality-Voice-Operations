/**
 * RT-12 wiring through the real createRealtimeSession: the tool bridge runs
 * RUN / TRANSFER before a tool, agent transcripts go through SAY in
 * observe-only mode, caller transcripts feed the floor, and evaluateFloor
 * runs tickets.file_floor through platform/actions as the system actor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  transports: [] as Array<{
    opts: { onFunctionCall: (name: string, args: Record<string, unknown>) => Promise<string> };
    sendEvent: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
  registryTools: new Map<string, ReturnType<typeof vi.fn>>(),
  runAction: vi.fn(async (..._args: unknown[]) => ({ ok: true, data: { filed: true, reason: 'filed' } })),
}));

vi.mock('../../../platform/tools/registry', () => ({
  globalToolRegistry: {
    get: (name: string) => {
      const handler = h.registryTools.get(name);
      return handler ? { handler } : undefined;
    },
  },
}));
vi.mock('../../../platform/tools/ToolExecutionService', () => ({
  createToolExecution: vi.fn(async () => 'exec-1'),
  completeToolExecution: vi.fn(async () => {}),
}));
vi.mock('../../../platform/billing/usage/UsageRecorder', () => ({ recordToolExecution: vi.fn(async () => {}) }));
vi.mock('./demoToolHandler', () => ({ handleDemoToolCall: vi.fn(() => null) }));
vi.mock('../../../platform/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/actions')>();
  return { ...actual, runAction: h.runAction };
});
vi.mock('../../../platform/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/db')>();
  const query = async (): Promise<{ rows: Array<Record<string, unknown>> }> => ({ rows: [] });
  return {
    ...actual,
    getPlatformPool: () => ({ connect: async () => ({ query, release: () => {} }) }),
    withTenantContext: async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('./xaiRealtimeTransport', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('events');
  class FakeTransport extends NodeEventEmitter {
    sendAudio = vi.fn();
    sendEvent = vi.fn();
    connect = vi.fn(async () => {});
    close = vi.fn(() => { this.emit('close'); });
    updateSession = vi.fn();
    setFunctionHandler = vi.fn((handler: (name: string, args: Record<string, unknown>) => Promise<string>) => {
      (this.opts as { onFunctionCall: typeof handler }).onFunctionCall = handler;
    });
    constructor(readonly opts: unknown) {
      super();
      h.transports.push(this as never);
    }
  }
  class FakeSession {
    constructor(private readonly transport: FakeTransport) {}
    connect = vi.fn(async () => {});
    close = vi.fn(() => this.transport.close());
    on = (event: string, listener: (...args: unknown[]) => void) => {
      this.transport.on(event, listener);
      return this;
    };
    updateSession = (session: unknown) => this.transport.updateSession(session);
    setFunctionHandler = (handler: (name: string, args: Record<string, unknown>) => Promise<string>) =>
      this.transport.setFunctionHandler(handler);
  }
  return { XaiRealtimeTransport: FakeTransport, XaiVoiceSession: FakeSession };
});
vi.mock('./callPersistence', () => ({
  createCallSession: vi.fn(async () => 'cs-invariants'),
  writeCallEvent: vi.fn(async () => {}),
  updateCallState: vi.fn(async () => {}),
  createPlatformPersistenceAdapter: vi.fn(() => ({})),
  persistCallOutcome: vi.fn(async () => {}),
}));
vi.mock('../../../platform/knowledge/knowledgeContext', () => ({ hasKnowledgeArticles: vi.fn(async () => false) }));
vi.mock('../../../platform/billing/cost', () => ({
  checkConversationBudget: vi.fn(async () => ({ shouldEndCall: false, shouldDowngrade: false, shouldAlert: false, budgetCents: 1000, percentUsed: 0 })),
  getConversationCostRunningTotal: vi.fn(async () => 0),
  recordConversationCost: vi.fn(async () => {}),
  getSessionCacheCounters: vi.fn(() => ({ hits: 0, misses: 0 })),
  clearSessionCacheCounters: vi.fn(),
}));
vi.mock('../../../platform/core/observability/traceLogger', () => ({ recordTrace: vi.fn(async () => {}) }));

import { createRealtimeSession, type SessionContext } from './openaiSession';
import { sessionManager } from './sessionManager';
import { createToolExecution } from '../../../platform/tools/ToolExecutionService';
import { INSTRUCTIONS } from '../../../platform/callcore/invariants';

const TOOL = (name: string) => ({ name, description: name, parameters: { type: 'object', properties: {}, required: [] } });

function makeCtx(overrides: Partial<SessionContext> = {}, agentOverrides: Record<string, unknown> = {}): SessionContext {
  return {
    tenantId: 't-inv' as never,
    agentConfig: {
      agentId: 'a-barber',
      tenantId: 't-inv',
      systemPrompt: 'You are the front desk.',
      rolePrompt: 'Answer the phone.',
      greeting: 'Thanks for calling Sharp Line Barbers.',
      voice: 'ara',
      model: 'grok-voice-3.0',
      language: 'en',
      preferredLanguage: 'en',
      timeZone: 'America/New_York',
      tools: [TOOL('lookup_customer'), TOOL('triageEscalate')],
      guardrails: [],
      metadata: { businessName: 'Sharp Line Barbers' },
      coreVersion: '2.0.0',
      rolePackageId: 'salon',
      rolePackageVersion: '1.0.0',
      ...agentOverrides,
    } as never,
    callerNumber: '+15555550100',
    calledNumber: '+15555550199',
    callSid: 'CA-invariants',
    direction: 'inbound',
    templateKey: 'salon',
    lifecycleCoordinator: {
      registerCall: vi.fn(),
      appendTranscript: vi.fn(),
      handleOpenAiSessionEnd: vi.fn(),
      getCallRecord: vi.fn(() => undefined),
    } as never,
    ...overrides,
  } as SessionContext;
}

async function startCall(overrides: Partial<SessionContext> = {}, agentOverrides: Record<string, unknown> = {}) {
  const result = await createRealtimeSession(makeCtx(overrides, agentOverrides));
  const transport = h.transports[h.transports.length - 1];
  transport.emit('session.created', { type: 'session.created' });
  const callTool = (name: string, args: Record<string, unknown> = {}) => transport.opts.onFunctionCall(name, args);
  const callerSays = (text: string) =>
    transport.emit('history_added', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const agentSays = (text: string) =>
    transport.emit('history_added', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  return { result, transport, callTool, callerSays, agentSays };
}

let consoleLines: string[];

beforeEach(() => {
  h.transports.length = 0;
  h.registryTools.clear();
  h.runAction.mockClear();
  vi.mocked(createToolExecution).mockClear();
  consoleLines = [];
  for (const method of ['info', 'warn', 'error', 'log'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')); });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionManager.unregister('cs-invariants');
});

describe('RUN in the voice tool bridge', () => {
  it('blocks a registered tool the agent was not shown: the handler never runs and no execution is recorded', async () => {
    const rogue = vi.fn(async () => ({ success: true }));
    h.registryTools.set('create_booking', rogue);
    const { result, callTool } = await startCall();
    const out = JSON.parse(await callTool('create_booking', { title: 'Fade' }));
    expect(out).toEqual({
      success: false,
      code: 'INVARIANT_BLOCKED',
      rule: 'run.action_not_allowed',
      message: INSTRUCTIONS['run.action_not_allowed'],
    });
    expect(rogue).not.toHaveBeenCalled();
    expect(createToolExecution).not.toHaveBeenCalled();
    result.session.close();
  });

  it('an exposed legacy tool runs exactly as before', async () => {
    const lookup = vi.fn(async () => ({ success: true, customer: null }));
    h.registryTools.set('lookup_customer', lookup);
    const { result, callTool } = await startCall();
    expect(JSON.parse(await callTool('lookup_customer', { phoneNumber: '+15555550100' }))).toEqual({ success: true, customer: null });
    expect(lookup).toHaveBeenCalledTimes(1);
    result.session.close();
  });

  it('transfer_to_agent counts as exposed when the stream enabled a workforce handoff', async () => {
    const onHandoff = vi.fn(async () => ({ success: true, message: 'Connecting you to billing.' }));
    const { result, callTool } = await startCall({ onHandoff });
    expect(JSON.parse(await callTool('transfer_to_agent', { intent: 'billing' }))).toEqual({ success: true, message: 'Connecting you to billing.' });
    expect(onHandoff).toHaveBeenCalledTimes(1);
    result.session.close();
  });
});

describe('TRANSFER in the voice tool bridge', () => {
  it('no on-call number: triageEscalate returns the fixed instruction and never starts a transfer', async () => {
    const onEscalation = vi.fn(async () => {});
    const { result, callTool } = await startCall({ onEscalation });
    const out = JSON.parse(await callTool('triageEscalate', { urgentConcern: 'eye pain' }));
    expect(out.rule).toBe('transfer.no_number');
    expect(out.message).toBe(INSTRUCTIONS['transfer.no_number']);
    expect(onEscalation).not.toHaveBeenCalled();
    result.session.close();
  });
});

describe('SAY (observe-only)', () => {
  it('a stage direction in a finished agent turn is logged by rule only: nothing is sent to the model or cancelled', async () => {
    const { result, transport, agentSays } = await startCall();
    const sentBefore = transport.sendEvent.mock.calls.length;
    agentSays('(quietly) Filing that for you now.');
    expect(transport.sendEvent.mock.calls.length).toBe(sentBefore);
    const observed = consoleLines.filter((line) => line.includes('invariant_say_observed'));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain('say.stage_direction');
    expect(observed[0]).not.toContain('Filing');
    result.session.close();
  });
});

describe('floor through the session', () => {
  it('evaluateFloor runs tickets.file_floor once, as the system actor, with only the caller lines', async () => {
    const { result, callerSays, agentSays } = await startCall();
    agentSays('Thanks for calling Sharp Line Barbers.');
    callerSays('Hi, this is Dana, I need a fade Friday at nine');
    agentSays('Let me check Friday.');
    result.session.close();
    await expect(result.evaluateFloor()).resolves.toBe('filed');
    await expect(result.evaluateFloor()).resolves.toBe('filed');
    expect(h.runAction).toHaveBeenCalledTimes(1);
    const [name, ctx, input] = h.runAction.mock.calls[0];
    expect(name).toBe('tickets.file_floor');
    expect(ctx).toMatchObject({
      tenantId: 't-inv',
      actor: { type: 'system', id: 'voice-runtime' },
      callId: 'cs-invariants',
      idempotencyKey: 'call-cs-invariants-floor',
    });
    expect(input).toEqual({ callId: 'cs-invariants', callerLines: ['Hi, this is Dana, I need a fade Friday at nine'], language: 'en' });
    expect(consoleLines.some((line) => line.includes('floor_evaluated') && line.includes('filed'))).toBe(true);
  });
});
