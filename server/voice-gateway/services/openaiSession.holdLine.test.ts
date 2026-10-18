/**
 * RT-HOLD-LINE through the real createRealtimeSession wiring: a slow tool
 * gets one hold line, in the call's language, on the same playback signal as
 * the silence watchdog (the Twilio mark echo on the phone); the hold line is
 * no "agent spoke" for the invariants; a barge-in on it clears Twilio; one
 * tool_timing line per tool call. The transport's queue/cancel rules are
 * covered in xaiRealtimeTransport.test.ts, the pure timing in holdLine.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  transports: [] as Array<{
    opts: { onFunctionCall: (name: string, args: Record<string, unknown>) => Promise<string> };
    sendEvent: ReturnType<typeof vi.fn>;
    requestResponse: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn<() => void>>;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
  slowTool: vi.fn(),
  logs: [] as Array<{ message: string; extra?: Record<string, unknown> }>,
}));

vi.mock('../../../platform/tools/registry', () => ({
  globalToolRegistry: { get: (name: string) => (name === 'lookup_customer' ? { handler: h.slowTool } : undefined) },
}));
vi.mock('../../../platform/tools/ToolExecutionService', () => ({
  createToolExecution: vi.fn(async () => 'exec-1'),
  completeToolExecution: vi.fn(async () => {}),
}));
vi.mock('../../../platform/billing/usage/UsageRecorder', () => ({ recordToolExecution: vi.fn(async () => {}) }));
vi.mock('./demoToolHandler', () => ({ handleDemoToolCall: vi.fn(() => null) }));
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
    // The real transport's one response.create path, without its queue.
    requestResponse = vi.fn((request: { response?: Record<string, unknown> }) => {
      this.sendEvent(request.response ? { type: 'response.create', response: request.response } : { type: 'response.create' });
      return true;
    });
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
  createCallSession: vi.fn(async () => 'cs-hold'),
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
import { writeCallEvent } from './callPersistence';
import { CallInvariants } from './callInvariants';
import { clearToolRetryConfig, setToolRetryConfig } from '../../../platform/tools/RetryOrchestrator';
import { HOLD_LINE_DELAY_MS, HOLD_LINE_PHRASES, holdLineInstruction } from './holdLine';

const TOOLS = [{ name: 'lookup_customer', description: 'lookup', parameters: { type: 'object', properties: {} } }];

function makeCtx(overrides: Partial<SessionContext> = {}, agent: Record<string, unknown> = {}): SessionContext {
  return {
    tenantId: 't-hold' as never,
    agentConfig: {
      agentId: 'a-front-desk',
      tenantId: 't-hold',
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
      ...agent,
    } as never,
    callerNumber: '+15555550100',
    calledNumber: '+15555550199',
    callSid: 'CA-hold',
    direction: 'inbound',
    templateKey: 'core-receptionist',
    playbackConfirm: 'twilio_mark',
    lifecycleCoordinator: {
      registerCall: vi.fn(),
      appendTranscript: vi.fn(),
      handleOpenAiSessionEnd: vi.fn(),
      getCallRecord: vi.fn(() => undefined),
    } as never,
    ...overrides,
  } as SessionContext;
}

async function startCall(overrides: Partial<SessionContext> = {}, agent: Record<string, unknown> = {}) {
  const ctx = makeCtx(overrides, agent);
  const result = await createRealtimeSession(ctx);
  const transport = h.transports[h.transports.length - 1];
  const marks: string[] = [];
  result.onAgentAudioDone((name) => marks.push(name));
  const echo = () => result.agentPlaybackDone(marks.at(-1) ?? '');
  const holdLines = () => transport.sendEvent.mock.calls
    .map(([event]) => event as { type: string; response?: { instructions?: string } })
    .filter((event) => event.type === 'response.create' && Object.values(HOLD_LINE_PHRASES).some((p) => event.response?.instructions === holdLineInstruction(p)));
  /** The model's function-call response: created, the call arrives, done; Twilio echoes its mark. */
  const toolCall = (name = 'lookup_customer', args: Record<string, unknown> = {}) => {
    transport.emit('response.created', { type: 'response.created' }, { kind: 'server' });
    const run = transport.opts.onFunctionCall(name, args);
    transport.emit('response.done', { type: 'response.done' }, { kind: 'server' });
    echo();
    return run;
  };
  transport.emit('session.created', { type: 'session.created' });
  transport.emit('response.created', { type: 'response.created' }, { kind: 'instruction' }); // greeting
  transport.emit('response.audio_started', { kind: 'instruction' });
  transport.emit('response.done', { type: 'response.done' }, { kind: 'instruction' });
  echo();
  return { ctx, result, transport, echo, holdLines, toolCall };
}

let finishTool: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  h.transports.length = 0;
  h.logs.length = 0;
  vi.mocked(writeCallEvent).mockClear();
  setToolRetryConfig('lookup_customer', { baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 120_000, maxRetries: 0 });
  h.slowTool.mockImplementation(() => new Promise((resolve) => {
    finishTool = () => resolve({ success: true });
  }));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  clearToolRetryConfig('lookup_customer');
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionManager.unregister('cs-hold');
});

const holdLineEvents = () => vi.mocked(writeCallEvent).mock.calls.filter((call) => call[2] === 'hold_line');

describe('hold line on the phone path', () => {
  it('a tool in flight for 2 s: one hold line ~800 ms after the call\'s mark echo, no tool_choice, one hold_line event', async () => {
    const { transport, holdLines, toolCall } = await startCall();
    const run = toolCall();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS - 1);
    expect(holdLines()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(holdLines()).toEqual([{ type: 'response.create', response: { instructions: holdLineInstruction(HOLD_LINE_PHRASES.en) } }]);
    expect(transport.requestResponse).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'hold_line', onlyIfIdle: true }));
    // Its own response plays; the tool runs on to 2 s: still one.
    transport.emit('response.created', { type: 'response.created' }, { kind: 'hold_line' });
    transport.emit('response.audio_started', { kind: 'hold_line' });
    transport.emit('response.done', { type: 'response.done' }, { kind: 'hold_line' });
    await vi.advanceTimersByTimeAsync(1_200);
    finishTool();
    await run;
    expect(holdLines()).toHaveLength(1);
    // Tool name, language and timings only.
    expect(holdLineEvents()).toHaveLength(1);
    expect(holdLineEvents()[0][5]).toEqual({ tool: 'lookup_customer', language: 'en', delayMs: 800, waitedMs: 800 });
    expect(h.logs.find((l) => l.message === 'hold_line')?.extra).toEqual({ tool: 'lookup_customer', language: 'en', delayMs: 800, waitedMs: 800 });
    transport.close();
  });

  it('a tool done at 500 ms: no hold line', async () => {
    const { transport, holdLines, toolCall } = await startCall();
    const run = toolCall();
    await vi.advanceTimersByTimeAsync(500);
    finishTool();
    await run;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(holdLines()).toHaveLength(0);
    expect(holdLineEvents()).toHaveLength(0);
    transport.close();
  });

  it('in Spanish for a Spanish agent, and after record_language_change on an English one', async () => {
    const es = await startCall({}, { language: 'es', preferredLanguage: 'es' });
    const runEs = es.toolCall();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    expect(es.holdLines().map((e) => e.response?.instructions)).toEqual([holdLineInstruction('Un momento mientras lo reviso.')]);
    finishTool();
    await runEs;
    es.transport.close();
    sessionManager.unregister('cs-hold');

    const en = await startCall();
    await en.toolCall('record_language_change', { language: 'es', confidence: 0.9 });
    en.transport.emit('response.created', { type: 'response.created' }, { kind: 'tool_result' });
    en.transport.emit('response.audio_started', { kind: 'tool_result' });
    en.transport.emit('response.done', { type: 'response.done' }, { kind: 'tool_result' });
    en.echo();
    // "El viernes." — the caller's next turn asks for a lookup.
    en.transport.emit('input_audio_buffer.speech_started', { type: 'input_audio_buffer.speech_started' });
    en.transport.emit('input_audio_buffer.speech_stopped', { type: 'input_audio_buffer.speech_stopped' });
    const run = en.toolCall();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    expect(en.holdLines().map((e) => e.response?.instructions)).toEqual([holdLineInstruction(HOLD_LINE_PHRASES.es)]);
    finishTool();
    await run;
    en.transport.close();
  });

  it('the delay is configurable per agent (metadata) and per call (resolved agent/tenant config)', async () => {
    const agent = await startCall({}, { metadata: { businessName: 'Acme', holdLineDelayMs: 950 } });
    const run = agent.toolCall();
    await vi.advanceTimersByTimeAsync(949);
    expect(agent.holdLines()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(agent.holdLines()).toHaveLength(1);
    finishTool();
    await run;
    agent.transport.close();
    sessionManager.unregister('cs-hold');

    const call = await startCall({ holdLineDelayMs: 700 });
    const run2 = call.toolCall();
    await vi.advanceTimersByTimeAsync(700);
    expect(call.holdLines()).toHaveLength(1);
    finishTool();
    await run2;
    call.transport.close();
  });

  it('the agent\'s preamble still playing: the line comes 800 ms after its mark echo, not before', async () => {
    const { transport, holdLines, echo } = await startCall();
    transport.emit('response.created', { type: 'response.created' }, { kind: 'server' });
    transport.emit('response.audio_started', { kind: 'server' }); // "Sure, let me check that"
    const run = transport.opts.onFunctionCall('lookup_customer', {});
    transport.emit('response.done', { type: 'response.done' }, { kind: 'server' });
    await vi.advanceTimersByTimeAsync(2_500); // Twilio still playing it
    expect(holdLines()).toHaveLength(0);
    echo();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    expect(holdLines()).toHaveLength(1);
    finishTool();
    await run;
    transport.close();
  });

  it('the hold line is no "agent spoke": the invariants and the transcript-driven checks never see it', async () => {
    const spoke = vi.spyOn(CallInvariants.prototype, 'agentTurnCompleted');
    const { ctx, transport, toolCall } = await startCall();
    const run = toolCall();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    transport.emit('response.created', { type: 'response.created' }, { kind: 'hold_line' });
    transport.emit('history_added', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: HOLD_LINE_PHRASES.en }], holdLine: true });
    transport.emit('response.done', { type: 'response.done' }, { kind: 'hold_line' });
    expect(spoke).not.toHaveBeenCalled();
    // On the call transcript: it is what the caller heard.
    expect(vi.mocked(ctx.lifecycleCoordinator.appendTranscript)).toHaveBeenCalledWith('cs-hold', `AGENT: ${HOLD_LINE_PHRASES.en}`);
    transport.emit('history_added', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found it.' }] });
    expect(spoke).toHaveBeenCalledTimes(1);
    finishTool();
    await run;
    transport.close();
  });

  it('a barge-in on the hold line clears Twilio like any agent audio', async () => {
    const { result, transport, toolCall } = await startCall();
    const clears = vi.fn();
    result.onBargeIn(clears);
    const run = toolCall();
    await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
    transport.emit('response.created', { type: 'response.created' }, { kind: 'hold_line' });
    transport.emit('response.audio_started', { kind: 'hold_line' });
    transport.emit('input_audio_buffer.speech_started', { type: 'input_audio_buffer.speech_started' });
    expect(clears).toHaveBeenCalledTimes(1);
    finishTool();
    await run;
    transport.close();
  });

  it('logs the transport\'s tool_timing line (no PII)', async () => {
    const { transport } = await startCall();
    const timing = { tool: 'lookup_customer', tool_call_received_ms: 4_000, action_ms: 2_000, result_sent_ms: 2_000, first_agent_audio_after_result_ms: 350, hold_line_ms: 820, voiced: 'queued' };
    transport.emit('tool_timing', timing);
    expect(h.logs.find((l) => l.message === 'tool_timing')?.extra).toEqual(timing);
    transport.close();
  });

  it('widget typed text starts a new wait like caller speech: a hold line on every slow tool turn (review P3 #2)', async () => {
    const { result, transport, holdLines, toolCall } = await startCall({ playbackConfirm: 'response_done' });
    const answer = () => {
      transport.emit('response.created', { type: 'response.created' }, { kind: 'tool_result' });
      transport.emit('response.audio_started', { kind: 'tool_result' });
      transport.emit('response.done', { type: 'response.done' }, { kind: 'tool_result' });
    };
    for (const text of ['Is Wednesday open?', 'And Friday?']) {
      result.sendCallerText(text);
      const run = toolCall();
      await vi.advanceTimersByTimeAsync(HOLD_LINE_DELAY_MS);
      transport.emit('response.created', { type: 'response.created' }, { kind: 'hold_line' });
      transport.emit('response.audio_started', { kind: 'hold_line' });
      transport.emit('response.done', { type: 'response.done' }, { kind: 'hold_line' });
      finishTool();
      await run;
      answer(); // she spoke: no more hold lines until the next caller turn
    }
    expect(holdLines()).toHaveLength(2);
    expect(transport.requestResponse).toHaveBeenCalledWith({ kind: 'caller_text' });
    transport.close();
  });

  it('nothing after hangup: the hold-line timer is cleared with the session', async () => {
    const { transport, holdLines, toolCall } = await startCall();
    const run = toolCall();
    transport.close();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(holdLines()).toHaveLength(0);
    finishTool();
    await run;
  });
});
