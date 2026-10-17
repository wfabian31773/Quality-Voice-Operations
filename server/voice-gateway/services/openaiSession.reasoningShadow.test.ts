/**
 * Reasoning shadow mode on the live voice path (VA-01): salon / barbershop
 * agents default to shadow (no injection, no blocking, one reasoning_shadow
 * log line per decision); every other agent type keeps enforce. Also the
 * repeated-tool stop through the real tool handler + RetryOrchestrator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  transports: [] as Array<{ opts: { onFunctionCall: (name: string, args: Record<string, unknown>) => Promise<string> }; sendEvent: ReturnType<typeof vi.fn> }>,
  toolHandlers: new Map<string, ReturnType<typeof vi.fn>>(),
  failEngine: false,
  bookingInserts: [] as unknown[][],
}));

vi.mock('../../../platform/reasoning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/reasoning')>();
  class MaybeFailingEngine extends actual.ReasoningEngine {
    constructor(config: ConstructorParameters<typeof actual.ReasoningEngine>[0]) {
      if (h.failEngine) throw new Error('engine construction failed');
      super(config);
    }
  }
  return { ...actual, ReasoningEngine: MaybeFailingEngine };
});
vi.mock('../../../platform/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/db')>();
  const query = async (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes('INSERT INTO bookings')) {
      h.bookingInserts.push(params ?? []);
      return { rows: [{ id: 'bk-voice' }] };
    }
    return { rows: [] };
  };
  return {
    ...actual,
    getPlatformPool: () => ({ connect: async () => ({ query, release: () => {} }) }),
    withTenantContext: async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('../../admin-api/routes/scheduling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../admin-api/routes/scheduling')>();
  return { ...actual, getTenantTimezone: vi.fn(async () => 'America/New_York') };
});

vi.mock('./xaiRealtimeTransport', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('events');
  class FakeTransport extends NodeEventEmitter {
    sendAudio = vi.fn();
    sendEvent = vi.fn();
    connect = vi.fn(async () => {});
    close = vi.fn(() => { this.emit('close'); });
    updateSession = vi.fn();
    setFunctionHandler = vi.fn();
    constructor(readonly opts: unknown) {
      super();
      h.transports.push(this as never);
    }
  }
  class FakeSession extends NodeEventEmitter {
    connect = vi.fn(async () => {});
    close = vi.fn(() => { this.emit('close'); });
    updateSession = vi.fn();
    setFunctionHandler = vi.fn();
  }
  return { XaiRealtimeTransport: FakeTransport, XaiVoiceSession: FakeSession };
});

vi.mock('./callPersistence', () => ({
  createCallSession: vi.fn(async () => 'cs-shadow-voice'),
  writeCallEvent: vi.fn(async () => {}),
  updateCallState: vi.fn(async () => {}),
  createPlatformPersistenceAdapter: vi.fn(() => ({})),
}));
vi.mock('../../../platform/knowledge/knowledgeContext', () => ({ hasKnowledgeArticles: vi.fn(async () => false) }));
vi.mock('../../../platform/integrations/azul-vision/ticketingClient', () => ({ wakeUp: vi.fn(async () => {}) }));
vi.mock('../../../platform/billing/cost', () => ({
  checkConversationBudget: vi.fn(async () => ({ shouldEndCall: false, shouldDowngrade: false, shouldAlert: false, budgetCents: 1000, percentUsed: 0 })),
  getConversationCostRunningTotal: vi.fn(async () => 0),
  recordConversationCost: vi.fn(async () => {}),
  getSessionCacheCounters: vi.fn(() => ({ hits: 0, misses: 0 })),
  clearSessionCacheCounters: vi.fn(),
}));
vi.mock('../../../platform/core/observability/traceLogger', () => ({ recordTrace: vi.fn(async () => {}) }));
vi.mock('../../../platform/tools/ToolExecutionService', () => ({
  createToolExecution: vi.fn(async () => 'exec-1'),
  completeToolExecution: vi.fn(async () => {}),
}));
vi.mock('../../../platform/tools/HumanEscalationService', () => ({ createEscalationTask: vi.fn(async () => ({ id: 'esc-1' })) }));
vi.mock('../../../platform/billing/usage/UsageRecorder', () => ({ recordToolExecution: vi.fn(async () => {}) }));
vi.mock('./demoToolHandler', () => ({ handleDemoToolCall: vi.fn(() => null) }));
vi.mock('../../../platform/tools/registry', () => ({
  globalToolRegistry: { get: (name: string) => (h.toolHandlers.has(name) ? { handler: h.toolHandlers.get(name) } : undefined) },
}));

import { createRealtimeSession, type SessionContext } from './openaiSession';
import { sessionManager } from './sessionManager';
import { clearToolRetryConfig, setToolRetryConfig } from '../../../platform/tools/RetryOrchestrator';
import { toolStopGuard } from '../../../platform/tools/ToolStopGuard';
import { executeCreateBooking } from '../../../platform/tools/library/handlers/createBooking';
import { resetBookingConfirmations } from '../../../platform/tools/library/handlers/bookingConfirmation';
import type { ToolContext } from '../../../platform/tools/registry/types';
import { createEscalationTask } from '../../../platform/tools/HumanEscalationService';

const CALLER = '+15555550100';
const tool = (name: string) => ({ name, description: name, parameters: { type: 'object', properties: {} } });

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    tenantId: 't-shadow' as never,
    agentConfig: {
      agentId: 'a-front-desk',
      tenantId: 't-shadow',
      systemPrompt: 'You are the front desk.',
      rolePrompt: 'Answer the phone.',
      greeting: 'Hello',
      voice: 'ara',
      model: 'grok-voice-think-fast-2.0',
      language: 'en',
      preferredLanguage: 'en',
      timeZone: 'America/New_York',
      tools: ['lookup_customer', 'create_booking', 'create_ticket', 'escalate_to_human', 'send_sms'].map(tool),
      guardrails: [],
      metadata: { businessName: 'Sharp Line Barbers' },
      coreVersion: '2.0.0',
      rolePackageId: 'salon',
      rolePackageVersion: '1.0.0',
    } as never,
    callerNumber: CALLER,
    calledNumber: '+15555550199',
    callSid: 'CA-shadow',
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

async function start(overrides: Partial<SessionContext> = {}) {
  const ctx = makeCtx(overrides);
  const result = await createRealtimeSession(ctx);
  const transport = h.transports[h.transports.length - 1];
  const session = result.session as unknown as { emit: (event: string, payload: unknown) => boolean };
  const say = (text: string) => session.emit('history_added', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const callTool = (name: string, args: Record<string, unknown> = {}) => transport.opts.onFunctionCall(name, args);
  const instructions = () => transport.sendEvent.mock.calls
    .map(([event]) => event as { type: string; response?: { instructions?: string } })
    .filter((event) => event.type === 'response.create');
  return { ctx, result, transport, say, callTool, instructions };
}

let info: ReturnType<typeof vi.spyOn>;
const shadowLines = (): string[] => info.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.includes('reasoning_shadow'));

beforeEach(() => {
  process.env.XAI_API_KEY = 'test-xai-key';
  h.transports.length = 0;
  h.toolHandlers.clear();
  h.failEngine = false;
  h.bookingInserts.length = 0;
  resetBookingConfirmations();
  vi.mocked(createEscalationTask).mockClear();
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.XAI_API_KEY;
  clearToolRetryConfig('lookup_customer');
  sessionManager.unregister('cs-shadow-voice');
});

describe('salon agent (shadow by default)', () => {
  it('injects nothing into the model on the Oct 17 turns and logs PII-free reasoning_shadow lines', async () => {
    const { ctx, result, say, instructions } = await start();
    expect(ctx.reasoningGate?.mode).toBe('shadow');

    for (const text of ['Hi, this is Wayne.', "I'm looking for a fade.", 'hmm', "Yeah, if nine is available, I'll take it."]) say(text);

    expect(instructions()).toEqual([]);
    const lines = shadowLines();
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).toContain('"event":"reasoning_shadow"');
      expect(line).toContain('"callId":"cs-shadow-voice"');
      expect(line).not.toMatch(/wayne|fade|nine is available|5555/i);
    }
    // The engine would have asked "Which service…?" on the fade turn.
    expect(lines[1]).toContain('"would_inject":true');
    await result.session.close();
  });

  it('lets a tool the engine would block run, and logs would_block_tool', async () => {
    const createBooking = vi.fn(async () => ({ success: true, bookingId: 'b1' }));
    h.toolHandlers.set('create_booking', createBooking);
    const { result, say, callTool } = await start();

    say('I need to cancel my appointment.');
    const out = JSON.parse(await callTool('create_booking', { title: 'Fade', startTime: '2026-10-24T09:00:00-04:00', contactName: 'Wayne' }));
    expect(out).toMatchObject({ success: true, bookingId: 'b1' });
    expect(createBooking).toHaveBeenCalledTimes(1);
    const toolLine = shadowLines().find((line) => line.includes('"kind":"tool"'));
    expect(toolLine).toContain('"would_block_tool":{"tool":"create_booking","reason":"reschedule_requires_update"}');
    expect(toolLine).not.toMatch(/wayne|fade|5555/i);
    await result.session.close();
  });

  it('still blocks a tool outside the agent allowlist', async () => {
    const rogue = vi.fn(async () => ({ success: true }));
    h.toolHandlers.set('delete_all_bookings', rogue);
    const { result, callTool } = await start();
    const out = JSON.parse(await callTool('delete_all_bookings', {}));
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/not available for this agent/);
    expect(rogue).not.toHaveBeenCalled();
    await result.session.close();
  });

  it('agent config can opt a salon agent back into enforce', async () => {
    h.toolHandlers.set('create_booking', vi.fn(async () => ({ success: true })));
    const { ctx, result, say, callTool, instructions } = await start({ reasoningMode: 'enforce' });
    expect(ctx.reasoningGate?.mode).toBe('enforce');
    say("I'm looking for a fade.");
    expect(instructions().length).toBeGreaterThan(0);
    say('I need to cancel my appointment.');
    const out = JSON.parse(await callTool('create_booking', { title: 'Fade', startTime: '2026-10-24T09:00:00-04:00', contactName: 'Wayne' }));
    expect(out.message).toMatch(/blocked by policy/);
    expect(shadowLines()).toEqual([]);
    await result.session.close();
  });
});

describe('non-salon agent (enforce by default, unchanged)', () => {
  it('a core-receptionist agent still gets reasoning injections and tool blocking', async () => {
    const { ctx, result, say, callTool, instructions } = await start({
      templateKey: 'core-receptionist',
      agentConfig: { ...makeCtx().agentConfig, rolePackageId: 'core-receptionist', metadata: { businessName: 'Acme Plumbing' } },
    });
    expect(ctx.reasoningGate?.mode).toBe('enforce');

    say('hmm');
    expect(instructions().some((event) => /unclear|clarify|still needed|Continue the conversation/i.test(event.response?.instructions ?? ''))).toBe(true);

    // The engine's safety gate still blocks: booking fields the caller never said.
    const createBooking = vi.fn(async () => ({ success: true }));
    h.toolHandlers.set('create_booking', createBooking);
    const out = JSON.parse(await callTool('create_booking', { title: 'Cleaning', startTime: '2026-10-24T09:00:00-04:00', contactName: 'Ana' }));
    expect(out.message).toMatch(/blocked by policy/);
    expect(createBooking).not.toHaveBeenCalled();
    expect(shadowLines()).toEqual([]);
    await result.session.close();
  });
});

describe('create_booking readback gate on the voice tool path', () => {
  const fade = { title: 'Fade', startTime: '2026-10-24T09:00:00-04:00', durationMinutes: 45, contactName: 'Wayne', contactPhone: CALLER };

  it('shadow: needs a readback challenge, rejects the token on the same turn, commits after the caller says yes', async () => {
    const handler = vi.fn((input: Record<string, unknown>, context: ToolContext) => executeCreateBooking(input, context));
    h.toolHandlers.set('create_booking', handler);
    const { ctx, result, say, callTool } = await start();
    expect(ctx.reasoningMode).toBe('shadow');

    say("Hi, this is Wayne. I'd like a fade Saturday at nine.");
    const challenge = JSON.parse(await callTool('create_booking', fade));
    expect(challenge).toMatchObject({ success: true, pending: true, status: 'needs_confirmation' });
    expect(typeof challenge.confirmationToken).toBe('string');
    expect((handler.mock.calls[0][1] as ToolContext).requireBookingConfirmation).toBe(true);
    expect(h.bookingInserts).toHaveLength(0);

    // Same caller turn: the model can't confirm on the caller's behalf.
    const sameTurn = JSON.parse(await callTool('create_booking', { ...fade, confirmationToken: challenge.confirmationToken }));
    expect(sameTurn).toMatchObject({ pending: true, status: 'needs_confirmation' });
    expect(h.bookingInserts).toHaveLength(0);

    // A challenge is not a failure: no stop count, no escalation task.
    expect(toolStopGuard.failureCount('cs-shadow-voice', 'create_booking')).toBe(0);
    expect(createEscalationTask).not.toHaveBeenCalled();

    say('Yes, that is right.');
    const committed = JSON.parse(await callTool('create_booking', { ...fade, confirmationToken: sameTurn.confirmationToken }));
    expect(committed).toMatchObject({ success: true, bookingId: 'bk-voice' });
    expect(h.bookingInserts).toHaveLength(1);
    await result.session.close();
  });

  it('enforce: create_booking stores directly as before (no confirmation required)', async () => {
    const handler = vi.fn((input: Record<string, unknown>, context: ToolContext) => executeCreateBooking(input, context));
    h.toolHandlers.set('create_booking', handler);
    h.failEngine = true; // no engine, so nothing in enforce blocks the call
    const { ctx, result, callTool } = await start({ reasoningMode: 'enforce' });
    expect(ctx.reasoningMode).toBe('enforce');

    const out = JSON.parse(await callTool('create_booking', fade));
    expect(out).toMatchObject({ success: true, bookingId: 'bk-voice' });
    expect(out.pending).toBeUndefined();
    expect((handler.mock.calls[0][1] as ToolContext).requireBookingConfirmation).toBe(false);
    expect(h.bookingInserts).toHaveLength(1);
    await result.session.close();
  });
});

describe('enforce-mode call whose engine failed to start (unchanged)', () => {
  it('does not apply the shadow allowlist check: a registered tool outside agentConfig.tools still runs', async () => {
    h.failEngine = true;
    const extra = vi.fn(async () => ({ success: true }));
    h.toolHandlers.set('partner_crm_sync', extra);
    // No template key, so template permissions don't apply either (as before this PR).
    const { ctx, result, callTool } = await start({
      templateKey: undefined,
      agentConfig: { ...makeCtx().agentConfig, rolePackageId: 'core-receptionist', metadata: { businessName: 'Acme Plumbing' } },
    });
    expect(ctx.reasoningMode).toBe('enforce');
    expect(ctx.reasoningGate).toBeUndefined();

    const out = JSON.parse(await callTool('partner_crm_sync', {}));
    expect(out.success).toBe(true);
    expect(extra).toHaveBeenCalledTimes(1);
    await result.session.close();
  });

  it('shadow mode without an engine still blocks a tool outside the agent allowlist', async () => {
    h.failEngine = true;
    const extra = vi.fn(async () => ({ success: true }));
    h.toolHandlers.set('partner_crm_sync', extra);
    // No template key (template permissions don't apply); shadow via metadata.vertical.
    const { ctx, result, callTool } = await start({
      templateKey: undefined,
      agentConfig: { ...makeCtx().agentConfig, metadata: { businessName: 'Sharp Line Barbers', vertical: 'barbershop' } },
    });
    expect(ctx.reasoningMode).toBe('shadow');
    expect(ctx.reasoningGate).toBeUndefined();

    const out = JSON.parse(await callTool('partner_crm_sync', {}));
    expect(out.message).toMatch(/not available for this agent/);
    expect(extra).not.toHaveBeenCalled();
    await result.session.close();
  });
});

describe('repeated-tool stop on the voice tool path (every mode)', () => {
  for (const reasoningMode of ['shadow', 'enforce'] as const) {
    it(`${reasoningMode}: retries inside one call count once; 3 failed calls stop the tool and the 4th does not execute`, async () => {
      setToolRetryConfig('lookup_customer', { baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 1000, maxRetries: 2 });
      const lookup = vi.fn(async () => ({ success: false, message: 'Customer lookup failed.' }));
      h.toolHandlers.set('lookup_customer', lookup);
      const { result, callTool } = await start({ reasoningMode });

      // One correctable failure (3 attempts) does not stop the tool.
      const first = JSON.parse(await callTool('lookup_customer', { phoneNumber: '' }));
      expect(lookup).toHaveBeenCalledTimes(3);
      expect(first.success).toBe(false);
      expect(first.code).toBeUndefined();
      expect(toolStopGuard.failureCount('cs-shadow-voice', 'lookup_customer')).toBe(1);

      const second = JSON.parse(await callTool('lookup_customer', { phoneNumber: '' }));
      expect(second.code).toBeUndefined();

      const third = JSON.parse(await callTool('lookup_customer', { phoneNumber: '' }));
      expect(lookup).toHaveBeenCalledTimes(9);
      expect(third).toMatchObject({ success: false, code: 'TOOL_STOPPED', retryable: false, tool: 'lookup_customer', failedAttempts: 3 });
      expect(third.message_for_caller_hint).toMatch(/shop follow up/);

      const fourth = JSON.parse(await callTool('lookup_customer', { phoneNumber: '' }));
      expect(lookup).toHaveBeenCalledTimes(9);
      expect(fourth).toMatchObject({ code: 'TOOL_STOPPED', failedAttempts: 3 });
      expect(toolStopGuard.isStopped('cs-shadow-voice', 'lookup_customer')).toBe(true);

      await result.session.close();
      expect(toolStopGuard.failureCount('cs-shadow-voice', 'lookup_customer')).toBe(0);
    });
  }
});
