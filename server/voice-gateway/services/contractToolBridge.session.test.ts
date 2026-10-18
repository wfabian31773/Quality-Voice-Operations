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
  createCallSession: vi.fn(async () => 'cs-composer'),
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

import { BARBERSHOP_TEMPLATE_V1 } from '../../../platform/agent-templates/barbershop';
import { recordToolExecution } from '../../../platform/billing/usage/UsageRecorder';
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

async function startCall(language = 'en') {
  const agentConfig = composerAgent(language);
  const ctx = {
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
  const callTool = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(await transport.opts.onFunctionCall(name, args));
  const callerSays = (text: string) =>
    transport.emit('history_added', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const agentSays = (text: string) =>
    transport.emit('history_added', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  return { result, callTool, callerSays, agentSays };
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
