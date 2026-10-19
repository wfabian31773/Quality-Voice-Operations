/**
 * The demo tenant's canned tool result queues the same bookkeeping as a real
 * run. If its tool_invocations insert throws, the writes that await its id
 * fail at once and the queue moves on (like toolBookkeeping's
 * queueInvocationRow), instead of holding the call's later writes until
 * release() (the queue waits for each write to settle).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  transports: [] as Array<{
    opts: { onFunctionCall: (name: string, args: Record<string, unknown>) => Promise<string> };
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
  logs: [] as Array<{ message: string; extra?: Record<string, unknown> }>,
}));

vi.mock('../../../platform/tools/registry', () => ({ globalToolRegistry: { get: () => undefined } }));
vi.mock('../../../platform/tools/ToolExecutionService', () => ({
  createToolExecution: vi.fn(async () => 'exec-1'),
  completeToolExecution: vi.fn(async () => {}),
}));
vi.mock('../../../platform/billing/usage/UsageRecorder', () => ({ recordToolExecution: vi.fn(async () => {}) }));
vi.mock('./demoToolHandler', () => ({ handleDemoToolCall: vi.fn(() => JSON.stringify({ success: true, demo: true })) }));
vi.mock('../../../platform/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/db')>();
  const query = async (): Promise<{ rows: Array<Record<string, unknown>> }> => ({ rows: [] });
  return {
    ...actual,
    getPlatformPool: () => ({ connect: async () => ({ query, release: () => {} }) }),
    withTenantContext: async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('./sessionLogger', () => ({
  createSessionLogger: () => {
    const keep = (message: string, extra?: Record<string, unknown>) => { h.logs.push({ message, extra }); };
    return { info: keep, warn: keep, error: keep, debug: keep };
  },
}));
vi.mock('./xaiRealtimeTransport', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('events');
  class FakeTransport extends NodeEventEmitter {
    sendAudio = vi.fn();
    sendEvent = vi.fn();
    requestResponse = vi.fn(() => true);
    noteHoldLineRequested = vi.fn();
    connect = vi.fn(async () => {});
    close = vi.fn(() => { this.emit('close'); });
    updateSession = vi.fn();
    setFunctionHandler = vi.fn();
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
    setFunctionHandler = (handler: unknown) => this.transport.setFunctionHandler(handler);
  }
  return { XaiRealtimeTransport: FakeTransport, XaiVoiceSession: FakeSession };
});
vi.mock('./callPersistence', () => ({
  createCallSession: vi.fn(async () => 'cs-demo'),
  writeCallEvent: vi.fn(async () => {}),
  updateCallState: vi.fn(async () => {}),
  updateCallStateWithEvent: vi.fn(async () => {}),
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
import { updateCallState, updateCallStateWithEvent, writeCallEvent } from './callPersistence';
import { completeToolExecution, createToolExecution } from '../../../platform/tools/ToolExecutionService';
import { BOOKKEEPING_FLUSH_TIMEOUT_MS } from './bookkeepingQueue';

const TOOLS = [{ name: 'lookup_customer', description: 'lookup', parameters: { type: 'object', properties: {} } }];

function makeCtx(): SessionContext {
  return {
    tenantId: 't-demo' as never,
    agentConfig: {
      agentId: 'a-front-desk',
      tenantId: 't-demo',
      systemPrompt: 'You are the front desk.',
      rolePrompt: 'Answer the phone.',
      greeting: 'Thanks for calling.',
      voice: 'ara',
      model: 'grok-voice-3.0',
      language: 'en',
      preferredLanguage: 'en',
      timeZone: 'America/New_York',
      tools: TOOLS,
      guardrails: [],
      metadata: { businessName: 'Acme' },
      coreVersion: '2.0.0',
      rolePackageId: 'core-receptionist',
      rolePackageVersion: '1.0.0',
    } as never,
    callerNumber: '+15555550100',
    calledNumber: '+15555550199',
    callSid: 'CA-demo',
    direction: 'inbound',
    templateKey: 'core-receptionist',
    playbackConfirm: 'twilio_mark',
    lifecycleCoordinator: {
      registerCall: vi.fn(),
      appendTranscript: vi.fn(),
      handleOpenAiSessionEnd: vi.fn(),
      getCallRecord: vi.fn(() => undefined),
    } as never,
  } as SessionContext;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.transports.length = 0;
  h.logs.length = 0;
  vi.mocked(writeCallEvent).mockClear();
  vi.mocked(updateCallState).mockClear();
  vi.mocked(updateCallStateWithEvent).mockClear();
  vi.mocked(completeToolExecution).mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionManager.unregister('cs-demo');
});

describe('demo tool bookkeeping', () => {
  it('a demo tool_invocations insert that throws fails the writes awaiting its id at once; the call\'s later writes still land', async () => {
    const result = await createRealtimeSession(makeCtx());
    const transport = h.transports[h.transports.length - 1];
    transport.emit('session.created', { type: 'session.created' });
    vi.mocked(createToolExecution).mockRejectedValueOnce(Object.assign(new Error('insert failed'), { code: '57014' }));

    await expect(transport.opts.onFunctionCall('lookup_customer', {})).resolves.toContain('"demo":true');
    // Teardown's session_closed queues behind the demo writes.
    await result.session.close();

    // Without the reject, call_event.tool_start would hold the queue: this flush would time out.
    const flushed = result.flushBookkeeping('test');
    await vi.advanceTimersByTimeAsync(BOOKKEEPING_FLUSH_TIMEOUT_MS);
    expect(await flushed).toBe('drained');

    const failed = h.logs.filter((l) => l.message === 'Bookkeeping write failed; the queue moves on').map((l) => l.extra?.write);
    expect(failed).toEqual(['tool_invocations.create', 'call_event.tool_start', 'tool_invocations.complete', 'call_event.tool_end']);
    expect(vi.mocked(completeToolExecution)).not.toHaveBeenCalled();
    expect(vi.mocked(updateCallState).mock.calls.map((c) => c[2])).toEqual(['AGENT_CONNECTED', 'TOOL_EXECUTION', 'ACTIVE_CONVERSATION']);
    expect(vi.mocked(updateCallStateWithEvent).mock.calls.map((c) => c[2])).toContain('CALL_COMPLETED');
    await result.releaseBookkeeping();
  });
});
