/**
 * RT-09 hook through the real createRealtimeSession: a composer agent's
 * contract tool calls go CallInvariants (RUN) → openaiSession's tool handler
 * → contractToolBridge → runAction, with the agent's ActionContext. Same
 * fakes as openaiSession.invariants.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  transports: [] as Array<{
    opts: { onFunctionCall: (name: string, args: Record<string, unknown>) => Promise<string> };
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
  registryTools: new Map<string, ReturnType<typeof vi.fn>>(),
  runAction: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, data: {} })),
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
vi.mock('../../../platform/actions/sms/deps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/actions/sms/deps')>();
  return { ...actual, envSmsSendConfig: { ...actual.envSmsSendConfig, smsEnabled: () => false } };
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
    // The real transport's one response.create path, without its queue.
    requestResponse = vi.fn((request: { response?: Record<string, unknown> }) => {
      this.sendEvent(request.response ? { type: 'response.create', response: request.response } : { type: 'response.create' });
      return true;
    });
    noteHoldLineRequested = vi.fn();
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
vi.mock('./callPersistence', () => {
  const writeCallEvent = vi.fn(async (..._args: unknown[]) => {});
  const updateCallState = vi.fn(async (..._args: unknown[]) => {});
  return {
    createCallSession: vi.fn(async () => 'cs-composer'),
    writeCallEvent,
    updateCallState,
    // The state + event pair in one transaction, recorded as its two writes.
    updateCallStateWithEvent: vi.fn(async (t: string, c: string, state: string, e: { type: string; from: unknown; to: unknown; payload?: unknown }) => {
      await updateCallState(t, c, state);
      await writeCallEvent(t, c, e.type, e.from, e.to, e.payload);
    }),
    createPlatformPersistenceAdapter: vi.fn(() => ({})),
    persistCallOutcome: vi.fn(async () => {}),
  };
});
vi.mock('../../../platform/knowledge/knowledgeContext', () => ({ hasKnowledgeArticles: vi.fn(async () => false) }));
vi.mock('../../../platform/billing/cost', () => ({
  checkConversationBudget: vi.fn(async () => ({ shouldEndCall: false, shouldDowngrade: false, shouldAlert: false, budgetCents: 1000, percentUsed: 0 })),
  getConversationCostRunningTotal: vi.fn(async () => 0),
  recordConversationCost: vi.fn(async () => {}),
  getSessionCacheCounters: vi.fn(() => ({ hits: 0, misses: 0 })),
  clearSessionCacheCounters: vi.fn(),
}));
vi.mock('../../../platform/core/observability/traceLogger', () => ({ recordTrace: vi.fn(async () => {}) }));

import { BARBERSHOP_TEMPLATE_V1 } from '../../../platform/agent-templates/barbershop';
import { recordToolExecution } from '../../../platform/billing/usage/UsageRecorder';
import { ReasoningEngine } from '../../../platform/reasoning';
import { ReasoningCallGate } from '../../../platform/reasoning/reasoningShadow';
import type { SafetyCheckResult } from '../../../platform/reasoning/types';
import { completeToolExecution, createToolExecution } from '../../../platform/tools/ToolExecutionService';
import { loadAgentConfig } from './agentLoader';
import { writeCallEvent } from './callPersistence';
import { createRealtimeSession, type SessionContext } from './openaiSession';
import { sessionManager } from './sessionManager';

const CALLER = '+15555550100';
const TOKEN = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

function composerAgent(language = 'en') {
  return loadAgentConfig({
    tenantId: 't-shop' as never,
    agentId: 'ag-shop',
    agentType: 'barbershop',
    callerPhone: CALLER,
    dbAgent: {
      name: 'Front desk',
      language,
      tenant_timezone: 'America/New_York',
      metadata: { businessName: 'Sharp Line Barbers', runtime: 'composer' },
    },
  });
}

async function startCall(language = 'en', over: Partial<SessionContext> = {}) {
  const agentConfig = composerAgent(language);
  const ctx = {
    ...over,
    tenantId: 't-shop' as never,
    agentConfig,
    callerNumber: CALLER,
    calledNumber: '+15555550199',
    callSid: 'CA-composer',
    direction: 'inbound',
    // stream.ts passes the loaded role package id.
    templateKey: agentConfig.rolePackageId,
    lifecycleCoordinator: {
      registerCall: vi.fn(),
      appendTranscript: vi.fn(),
      handleOpenAiSessionEnd: vi.fn(),
      getCallRecord: vi.fn(() => undefined),
    } as never,
  } as SessionContext;
  const result = await createRealtimeSession(ctx);
  const transport = h.transports[h.transports.length - 1];
  transport.emit('session.created', { type: 'session.created' });
  // The output comes back before the bookkeeping is written; these checks read the rows, so wait for them.
  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const out = JSON.parse(await transport.opts.onFunctionCall(name, args));
    expect(await result.flushBookkeeping()).toBe('drained');
    return out;
  };
  const callerSays = (text: string) =>
    transport.emit('history_added', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const agentSays = (text: string) =>
    transport.emit('history_added', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  return { ctx, result, callTool, callerSays, agentSays };
}

/** A fake scheduling backend: commit readbacks speak the prepare's locale. */
function fakeActions() {
  const locales = new Map<string, string | undefined>();
  h.runAction.mockImplementation(async (...args: unknown[]) => {
    const [name, ctx, input] = args as [string, { locale?: string }, Record<string, unknown>];
    if (name === 'scheduling.book.prepare') {
      if (!input.serviceIds) {
        return { ok: false, error: { code: 'SLOT_MISSING', askId: 'ask.service', field: 'service', message: 'Missing service', callerSafeMessage: 'What service would you like?', retryable: true } };
      }
      locales.set(TOKEN, ctx.locale);
      return { ok: true, data: { confirmationToken: TOKEN, readback: 'Friday at 3:30 PM with Marco, for Luis. Shall I book it?' } };
    }
    if (name === 'scheduling.book.commit') {
      const es = locales.get(String(input.confirmationToken))?.startsWith('es');
      const readback = es ? 'Confirmado: corte con Marco, viernes, 3:30 p. m.' : 'Confirmed: cut with Marco, Friday at 3:30 PM.';
      return { ok: true, data: { bookingId: 'b-1', status: 'confirmed', readback }, readback };
    }
    return { ok: true, data: { filed: false, reason: 'nothing_substantive' } };
  });
}

beforeEach(() => {
  h.transports.length = 0;
  h.registryTools.clear();
  h.runAction.mockReset();
  for (const method of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionManager.unregister('cs-composer');
});

describe('composer agent in a live session', () => {
  it('a book.prepare with a missing slot reaches runAction as the agent and comes back as the template\'s ask', async () => {
    fakeActions();
    const { result, callTool } = await startCall();
    const out = await callTool('scheduling_book_prepare', { customer: { name: 'Luis' } });
    expect(out.error).toMatchObject({ code: 'SLOT_MISSING', askId: 'ask.service' });
    expect(out.error.callerSafeMessage).toBe(BARBERSHOP_TEMPLATE_V1.asks['ask.service'].en);

    expect(h.runAction).toHaveBeenCalledTimes(1);
    const [name, ctx, input] = h.runAction.mock.calls[0] as [string, Record<string, unknown>, unknown];
    expect(name).toBe('scheduling.book.prepare');
    expect(ctx).toMatchObject({
      tenantId: 't-shop',
      actor: { type: 'agent', id: 'ag-shop' },
      callId: 'cs-composer',
      callerPhone: CALLER,
      locale: 'en',
      tenantTimezone: 'America/New_York',
    });
    expect(typeof ctx.idempotencyKey).toBe('string');
    expect(input).toEqual({ customer: { name: 'Luis' } });
    result.session.close();
  });

  it('a commit without a prepare, or before the caller\'s yes, is refused by RUN and never reaches runAction', async () => {
    fakeActions();
    const { result, callTool, callerSays, agentSays } = await startCall();
    expect(await callTool('scheduling_book_commit', { confirmationToken: TOKEN })).toMatchObject({
      code: 'INVARIANT_BLOCKED',
      rule: 'run.commit_token_not_prepared',
    });
    expect(h.runAction).not.toHaveBeenCalled();

    await callTool('scheduling_book_prepare', { serviceIds: ['svc-cut'], staffId: 'any', start: '2026-10-23T15:30:00-04:00', customer: { name: 'Luis' } });
    expect(await callTool('scheduling_book_commit', { confirmationToken: TOKEN })).toMatchObject({ rule: 'run.commit_without_yes' });
    expect(h.runAction).toHaveBeenCalledTimes(1);

    agentSays('Friday at 3:30 PM with Marco, for Luis. Shall I book it?');
    callerSays('Yes, please.');
    const done = await callTool('scheduling_book_commit', { confirmationToken: TOKEN });
    expect(done.ok).toBe(true);
    expect(done.say).toBe(
      `You're booked. Confirmed: cut with Marco, Friday at 3:30 PM. ${BARBERSHOP_TEMPLATE_V1.afterWrite.textWillFollow.en}`,
    );
    expect(h.runAction.mock.calls.map((c) => c[0])).toEqual(['scheduling.book.prepare', 'scheduling.book.commit']);
    result.session.close();
  });

  it('a Spanish booking in an English-started call is confirmed with the Spanish line', async () => {
    fakeActions();
    const { result, callTool, callerSays, agentSays } = await startCall('en');
    await callTool('record_language_change', { language: 'es', confidence: 'high' });
    await callTool('scheduling_book_prepare', { serviceIds: ['svc-cut'], staffId: 'any', start: '2026-10-23T15:30:00-04:00', customer: { name: 'Luis' } });
    expect((h.runAction.mock.calls[0] as [string, { locale?: string }])[1].locale).toBe('es');
    agentSays('Viernes a las 3:30 p. m. con Marco, para Luis. ¿Se la agendo?');
    callerSays('Sí, claro.');
    const done = await callTool('scheduling_book_commit', { confirmationToken: TOKEN });
    expect(done.say).toBe(
      `Su cita quedó lista. Confirmado: corte con Marco, viernes, 3:30 p. m. ${BARBERSHOP_TEMPLATE_V1.afterWrite.textWillFollow.es}`,
    );
    result.session.close();
  });

  it('a contract tool call gets one tool_invocations row, tool_start/tool_end and one meter increment', async () => {
    fakeActions();
    const { result, callTool } = await startCall();
    vi.mocked(createToolExecution).mockClear();
    vi.mocked(completeToolExecution).mockClear();
    vi.mocked(writeCallEvent).mockClear();
    vi.mocked(recordToolExecution).mockClear();

    await callTool('scheduling_book_prepare', { customer: { name: 'Luis' } });
    expect(vi.mocked(createToolExecution).mock.calls).toEqual([[expect.objectContaining({ toolName: 'scheduling_book_prepare', callSessionId: 'cs-composer' })]]);
    expect(vi.mocked(completeToolExecution).mock.calls).toEqual([[expect.objectContaining({ executionId: 'exec-1', status: 'success' })]]);
    const toolEvents = vi.mocked(writeCallEvent).mock.calls.map((c) => c[2]).filter((e) => e === 'tool_start' || e === 'tool_end');
    expect(toolEvents).toEqual(['tool_start', 'tool_end']);
    expect(recordToolExecution).toHaveBeenCalledTimes(1);
    result.session.close();
  });

  it('Codex 4307380008: a failed contract call is a failed row on this call (what tool_failures_only / has_tool_executions read)', async () => {
    h.runAction.mockImplementation(async () => ({
      ok: false,
      error: { code: 'CONFLICT', message: 'Slot taken', callerSafeMessage: 'That time was just taken.', retryable: false },
    }));
    const { result, callTool } = await startCall();
    vi.mocked(createToolExecution).mockClear();
    vi.mocked(completeToolExecution).mockClear();

    await callTool('scheduling_check_availability', { serviceIds: ['service-1'], staffId: 'any' });
    // CallViewDigestScheduler: EXISTS tool_invocations ti WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id [AND ti.status IN ('failed','timeout')]
    expect(vi.mocked(createToolExecution).mock.calls).toEqual([[expect.objectContaining({ tenantId: 't-shop', callSessionId: 'cs-composer', toolName: 'scheduling_check_availability' })]]);
    expect(vi.mocked(completeToolExecution).mock.calls).toEqual([[expect.objectContaining({ tenantId: 't-shop', callSessionId: 'cs-composer', status: 'failed' })]]);
    result.session.close();
  });

  it('RT-HOLD-LINE part 2: list_services twice in a call is one action run, two rows; the repeat\'s tool_timing says cache_hit', async () => {
    h.runAction.mockImplementation(async () => ({ ok: true, data: [{ id: 'svc-cut', name: 'Cut', durationMin: 30, priceText: '$30', staffIds: [] }] }));
    const { result, callTool } = await startCall();
    const transport = h.transports[h.transports.length - 1];
    vi.mocked(createToolExecution).mockClear();
    vi.mocked(completeToolExecution).mockClear();
    const first = await callTool('scheduling_list_services', { query: 'cut' });
    const second = await callTool('scheduling_list_services', { query: 'cut' });
    expect(second).toEqual(first);
    expect(h.runAction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createToolExecution)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(completeToolExecution).mock.calls.map((c) => c[0].status)).toEqual(['success', 'success']);
    const timing = { tool: 'scheduling_list_services', tool_call_received_ms: 1, action_ms: 1, result_sent_ms: 1, first_agent_audio_after_result_ms: null, hold_line_ms: null, voiced: 'now' };
    transport.emit('tool_timing', timing);
    transport.emit('tool_timing', timing);
    const lines = vi.mocked(console.info).mock.calls.map((c) => c.map(String).join(' ')).filter((line) => line.includes('tool_timing'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"cache_hit":false');
    expect(lines[1]).toContain('"cache_hit":true');
    result.session.close();
  });

  it('a legacy library tool is not reachable, even when registered', async () => {
    fakeActions();
    const legacy = vi.fn(async () => ({ success: true }));
    h.registryTools.set('create_booking', legacy);
    const { result, callTool } = await startCall();
    expect(await callTool('create_booking', { title: 'Fade' })).toMatchObject({ rule: 'run.action_not_allowed' });
    expect(legacy).not.toHaveBeenCalled();
    expect(h.runAction).not.toHaveBeenCalled();
    result.session.close();
  });
});

/**
 * Codex 4307380011: contract tools go through the same reasoning gate as every
 * other tool (enforce: the engine's verdict, fail closed on an error), and
 * their outcome feeds the engine's success/failure notifications.
 */
describe('composer agent: reasoning authorization and notifications', () => {
  const DENIED: SafetyCheckResult = {
    allowed: false,
    violations: [{ type: 'policy_violation', severity: 'critical', description: 'Not during this step' }],
  };

  it('enforce: an engine deny blocks a contract action; runAction is never called', async () => {
    fakeActions();
    vi.spyOn(ReasoningEngine.prototype, 'authorizeToolRequest').mockReturnValue(DENIED);
    const { ctx, result, callTool } = await startCall('en', { reasoningMode: 'enforce' });
    expect(ctx.reasoningMode).toBe('enforce');
    expect(ctx.reasoningGate?.enforcing).toBe(true);
    vi.mocked(completeToolExecution).mockClear();

    const out = await callTool('scheduling_book_prepare', { serviceIds: ['service-1'], staffId: 'any', start: '2026-10-23T15:30:00-04:00', customer: { name: 'Luis' } });
    expect(out).toEqual({ success: false, message: 'This action was blocked by policy: Not during this step' });
    expect(h.runAction).not.toHaveBeenCalled();
    expect(vi.mocked(completeToolExecution).mock.calls).toEqual([[expect.objectContaining({ status: 'failed', result: expect.objectContaining({ reason: 'safety_blocked' }) })]]);
    expect(vi.mocked(writeCallEvent).mock.calls.some((c) => c[2] === 'safety_gate_blocked')).toBe(true);
    result.session.close();
  });

  it('enforce: an authorization error fails closed; runAction is never called', async () => {
    fakeActions();
    vi.spyOn(ReasoningEngine.prototype, 'authorizeToolRequest').mockImplementation(() => {
      throw new Error('engine broke');
    });
    const { result, callTool } = await startCall('en', { reasoningMode: 'enforce' });
    vi.mocked(completeToolExecution).mockClear();

    const out = await callTool('scheduling_list_services');
    expect(out).toEqual({ success: false, message: 'Unable to verify this action safely. Please try again.' });
    expect(h.runAction).not.toHaveBeenCalled();
    expect(vi.mocked(completeToolExecution).mock.calls).toEqual([[expect.objectContaining({ status: 'failed', result: { success: false, reason: 'safety_gate_error' } })]]);
    result.session.close();
  });

  it('enforce: an allowed contract action is authorized once with the agent\'s tools, then runs', async () => {
    fakeActions();
    const authorize = vi.spyOn(ReasoningCallGate.prototype, 'authorizeTool');
    vi.spyOn(ReasoningEngine.prototype, 'authorizeToolRequest').mockReturnValue({ allowed: true, violations: [] });
    const { ctx, result, callTool } = await startCall('en', { reasoningMode: 'enforce' });
    await callTool('scheduling_list_services');
    expect(authorize).toHaveBeenCalledTimes(1);
    // Under its engine name (Codex 4307582062), with the engine names of the agent's contract tools added.
    const toolNames = ctx.agentConfig.tools.map((t) => t.name);
    expect(authorize).toHaveBeenCalledWith('list_services', {}, expect.arrayContaining([...toolNames, 'create_booking', 'update_booking', 'create_ticket', 'lookup_customer']));
    expect(h.runAction).toHaveBeenCalledTimes(1);
    result.session.close();
  });

  it('a successful contract call notifies the engine of success; a failure of failure; an ask of neither', async () => {
    const success = vi.spyOn(ReasoningEngine.prototype, 'handleToolSuccess');
    const failure = vi.spyOn(ReasoningEngine.prototype, 'handleToolFailure');
    h.runAction.mockImplementation(async (...args: unknown[]) => {
      const [name, , input] = args as [string, unknown, Record<string, unknown>];
      if (name === 'scheduling.list_services') return { ok: true, data: [] };
      if (name === 'scheduling.book.prepare' && !input.serviceIds) {
        return { ok: false, error: { code: 'SLOT_MISSING', askId: 'ask.service', field: 'service', message: 'Missing service', callerSafeMessage: 'What service?', retryable: true } };
      }
      return { ok: false, error: { code: 'CONFLICT', message: 'Slot taken', callerSafeMessage: 'That time was just taken.', retryable: false } };
    });
    const { result, callTool } = await startCall();

    await callTool('scheduling_list_services');
    expect(success.mock.calls).toEqual([['list_services']]);
    expect(failure).not.toHaveBeenCalled();

    await callTool('scheduling_book_prepare', { customer: { name: 'Luis' } });
    expect(success).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();

    await callTool('scheduling_check_availability', { serviceIds: ['service-1'], staffId: 'any' });
    expect(success).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledTimes(1);
    result.session.close();
  });

  it('shadow (the barbershop default): an engine deny or error is logged only and the contract action runs', async () => {
    fakeActions();
    const engine = vi.spyOn(ReasoningEngine.prototype, 'authorizeToolRequest').mockReturnValue(DENIED);
    const { ctx, result, callTool } = await startCall();
    expect(ctx.reasoningMode).toBe('shadow');
    expect((await callTool('scheduling_list_services')).ok).toBe(true);
    expect(engine).toHaveBeenCalledTimes(1);
    engine.mockImplementation(() => {
      throw new Error('engine broke');
    });
    expect((await callTool('scheduling_list_staff')).ok).toBe(true);
    expect(h.runAction).toHaveBeenCalledTimes(2);
    result.session.close();
  });

  it('no engine (it failed to start): no gate, the contract action runs as before', async () => {
    fakeActions();
    vi.spyOn(ReasoningEngine.prototype, 'initialize').mockRejectedValue(new Error('no engine'));
    const { ctx, result, callTool } = await startCall('en', { reasoningMode: 'enforce' });
    expect(ctx.reasoningGate).toBeUndefined();
    expect((await callTool('scheduling_list_services')).ok).toBe(true);
    expect(h.runAction).toHaveBeenCalledTimes(1);
    result.session.close();
  });
});

/**
 * Codex 4307582062: a real ReasoningEngine in enforce mode. Contract tools are
 * authorized and reported under the engine's names (reasoningToolNames.ts), on
 * the salon pack, so the engine's booking step lets a booking through.
 */
describe('Codex 4307582062: enforce mode with a real ReasoningEngine', () => {
  const PREPARE = { serviceIds: ['service-1'], staffId: 'any', start: '2026-10-23T15:30:00-04:00', customer: { name: 'Luis' } };

  /** An enforce call whose engine has collected the booking and sits on its create_booking step. */
  async function onBookingStep() {
    fakeActions();
    const call = await startCall('en', { reasoningMode: 'enforce' });
    expect(call.ctx.reasoningGate?.enforcing).toBe(true);
    call.callerSays("Hi, I'd like a fade on Friday at 3:30 pm.");
    call.callerSays('My name is Luis.');
    call.callerSays('My number is 555-555-0100.');
    expect(call.ctx.reasoningEngine?.getWorkflowPlan()?.vertical).toBe('salon');
    expect(call.ctx.reasoningEngine?.getCurrentWorkflowStepTool()).toBe('create_booking');
    vi.mocked(createToolExecution).mockClear();
    return call;
  }

  it('scheduling_book_prepare then scheduling_book_commit are allowed on the create_booking step (runAction called)', async () => {
    const authorize = vi.spyOn(ReasoningEngine.prototype, 'authorizeToolRequest');
    const { ctx, result, callTool, callerSays, agentSays } = await onBookingStep();

    expect((await callTool('scheduling_book_prepare', PREPARE)).ok).toBe(true);
    agentSays('Friday at 3:30 PM with Marco, for Luis. Shall I book it?');
    callerSays('Yes, please.');
    expect((await callTool('scheduling_book_commit', { confirmationToken: TOKEN })).ok).toBe(true);

    expect(h.runAction.mock.calls.map((c) => c[0])).toEqual(['scheduling.book.prepare', 'scheduling.book.commit']);
    expect(authorize.mock.calls.map((c) => c[0])).toEqual(['create_booking', 'create_booking']);
    expect(authorize.mock.results.map((r) => (r.value as SafetyCheckResult).allowed)).toEqual([true, true]);
    // The real contract name everywhere else.
    expect(vi.mocked(createToolExecution).mock.calls.map((c) => c[0].toolName)).toEqual(['scheduling_book_prepare', 'scheduling_book_commit']);
    expect(ctx.reasoningEngine?.getCurrentWorkflowStepTool()).toBeNull();
    result.session.close();
  });

  it('notifications use the engine name: the prepare (a hold) keeps the step, the commit advances it', async () => {
    const success = vi.spyOn(ReasoningEngine.prototype, 'handleToolSuccess');
    const { ctx, result, callTool, callerSays, agentSays } = await onBookingStep();

    await callTool('scheduling_book_prepare', PREPARE);
    expect(success.mock.calls).toEqual([['scheduling_book_prepare']]);
    expect(ctx.reasoningEngine?.getCurrentWorkflowStepTool()).toBe('create_booking');

    agentSays('Friday at 3:30 PM with Marco, for Luis. Shall I book it?');
    callerSays('Yes, please.');
    await callTool('scheduling_book_commit', { confirmationToken: TOKEN });
    expect(success.mock.calls).toEqual([['scheduling_book_prepare'], ['create_booking']]);
    expect(ctx.reasoningEngine?.getWorkflowPlan()?.status).toBe('completed');
    result.session.close();
  });

  it('off-step: a reschedule (update_booking) while the step is create_booking is blocked; runAction not called', async () => {
    const authorize = vi.spyOn(ReasoningEngine.prototype, 'authorizeToolRequest');
    const { result, callTool } = await onBookingStep();
    vi.mocked(completeToolExecution).mockClear();

    const out = await callTool('scheduling_reschedule_prepare', { bookingId: 'booking-1', newStart: '2026-10-24T10:00:00-04:00' });
    // The SafetyGate refuses it first (the caller never asked to reschedule), as it would a legacy update_booking.
    expect(out).toEqual({ success: false, message: 'This action was blocked by policy: Tool "update_booking" required fields were supplied only in model tool arguments, not by the caller: action' });
    expect(authorize.mock.calls.map((c) => c[0])).toEqual(['update_booking']);
    expect(h.runAction).not.toHaveBeenCalled();
    expect(vi.mocked(createToolExecution).mock.calls.map((c) => c[0].toolName)).toEqual(['scheduling_reschedule_prepare']);
    expect(vi.mocked(completeToolExecution).mock.calls).toEqual([[expect.objectContaining({ status: 'failed', result: expect.objectContaining({ reason: 'safety_blocked' }) })]]);
    result.session.close();
  });

  it('off-step: a message ticket (create_ticket) while the step is create_booking conflicts with the step; runAction not called', async () => {
    const { result, callTool } = await onBookingStep();
    const out = await callTool('tickets_open_prepare', { kind: 'message', subject: 'Fade', details: 'A fade on Friday', customer: { name: 'Luis' } });
    expect(out).toEqual({ success: false, message: 'This action was blocked by policy: Requested tool "create_ticket" conflicts with the active reasoning decision' });
    expect(h.runAction).not.toHaveBeenCalled();
    expect(vi.mocked(createToolExecution).mock.calls.map((c) => c[0].toolName)).toEqual(['tickets_open_prepare']);
    result.session.close();
  });

  it('a reschedule on the engine\'s update_booking step is allowed (runAction called)', async () => {
    fakeActions();
    const authorize = vi.spyOn(ReasoningEngine.prototype, 'authorizeToolRequest');
    const { ctx, result, callTool, callerSays } = await startCall('en', { reasoningMode: 'enforce' });
    callerSays('I need to reschedule my appointment.');
    callerSays('My name is Luis.');
    callerSays('Can we do Saturday at 10 am?');
    expect(ctx.reasoningEngine?.getCurrentWorkflowStepTool()).toBe('update_booking');

    await callTool('scheduling_reschedule_prepare', { bookingId: 'booking-1', newStart: '2026-10-24T10:00:00-04:00' });
    expect(authorize.mock.results.map((r) => (r.value as SafetyCheckResult).allowed)).toEqual([true]);
    expect(h.runAction.mock.calls.map((c) => c[0])).toEqual(['scheduling.reschedule.prepare']);
    result.session.close();
  });

  it('off-step: a new booking while the caller is cancelling is blocked (the engine\'s reschedule_cancel rule); runAction not called', async () => {
    fakeActions();
    const { result, callTool, callerSays } = await startCall('en', { reasoningMode: 'enforce' });
    callerSays('I need to cancel my appointment.');

    const out = await callTool('scheduling_book_prepare', PREPARE);
    expect(out).toEqual({ success: false, message: 'This action was blocked by policy: Cancel and reschedule must update the existing booking. Do not create a new booking.' });
    expect(h.runAction).not.toHaveBeenCalled();
    result.session.close();
  });
});
