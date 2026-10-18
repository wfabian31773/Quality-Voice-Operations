/**
 * VA-15: the silence watchdog runs through the real createRealtimeSession
 * wiring with the real ReasoningEngine + ReasoningCallGate, for a salon /
 * barbershop agent in shadow mode (where the gate's handleSilence() is
 * always null) and in enforce mode (one prompt per silence, not two).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  transports: [] as Array<{
    opts: { onFunctionCall: (name: string, args: Record<string, unknown>) => Promise<string> };
    sendEvent: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn<() => void>>;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
  slowTool: vi.fn(),
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
  createCallSession: vi.fn(async () => 'cs-watchdog'),
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
import { persistCallOutcome, writeCallEvent } from './callPersistence';
import { clearToolRetryConfig, setToolRetryConfig } from '../../../platform/tools/RetryOrchestrator';
import {
  HANGUP_GRACE_MS,
  HANGUP_PLAYBACK_PAD_MS,
  HEARD_SILENCE_CHECK_MS,
  PLAYBACK_ECHO_FALLBACK_MS,
  MAX_CALL_DURATION_MS,
  MAX_DURATION_WRAP_UP_INSTRUCTION,
  NEVER_HEARD_GOODBYE_INSTRUCTION,
  NEVER_HEARD_PROMPT_INTERVAL_MS,
  NEVER_HEARD_PROMPTS,
  SILENCE_PROMPT_INSTRUCTION,
} from './silenceWatchdog';

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    tenantId: 't-watchdog' as never,
    agentConfig: {
      agentId: 'a-barber',
      tenantId: 't-watchdog',
      systemPrompt: 'You are the front desk.',
      rolePrompt: 'Answer the phone.',
      greeting: 'Thanks for calling Sharp Line Barbers.',
      voice: 'ara',
      model: 'grok-voice-think-fast-2.0',
      language: 'en',
      preferredLanguage: 'en',
      timeZone: 'America/New_York',
      tools: [],
      guardrails: [],
      metadata: { businessName: 'Sharp Line Barbers' },
      coreVersion: '2.0.0',
      rolePackageId: 'salon',
      rolePackageVersion: '1.0.0',
    } as never,
    callerNumber: '+15555550100',
    calledNumber: '+15555550199',
    callSid: 'CA-watchdog',
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

/** Starts a call: socket open, greeting spoken and finished. */
async function startCall(overrides: Partial<SessionContext> = {}) {
  const ctx = makeCtx(overrides);
  const result = await createRealtimeSession(ctx);
  const transport = h.transports[h.transports.length - 1];
  const sessionClosed = vi.fn();
  result.onSessionClosed(sessionClosed);
  // 'twilio_mark' mode: the mark names the phone path would send to Twilio.
  const marks: string[] = [];
  result.onAgentAudioDone((name) => marks.push(name));
  /** Twilio echoes the latest mark: that turn's audio has played. */
  const echo = () => result.agentPlaybackDone(marks.at(-1) ?? '');
  const agentTurn = () => {
    transport.emit('response.created', { type: 'response.created' });
    transport.emit('response.done', { type: 'response.done' });
  };
  const callerSays = (text: string) =>
    transport.emit('history_added', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const instructions = () => transport.sendEvent.mock.calls
    .map(([event]) => event as { type: string; response?: { instructions?: string } })
    .filter((event) => event.type === 'response.create')
    .map((event) => event.response?.instructions ?? '');
  const silencePrompts = () => instructions().filter((text) => text === SILENCE_PROMPT_INSTRUCTION).length;

  transport.emit('session.created', { type: 'session.created' });
  agentTurn(); // greeting
  return { ctx, result, transport, agentTurn, callerSays, instructions, silencePrompts, sessionClosed, marks, echo };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.transports.length = 0;
  vi.mocked(persistCallOutcome).mockClear();
  vi.mocked(writeCallEvent).mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionManager.unregister('cs-watchdog');
});

const outcomeEvents = () => vi.mocked(writeCallEvent).mock.calls.filter((call) => call[2] === 'call_end_outcome');

describe('silence watchdog on a salon/barber agent in shadow mode', () => {
  it('sends "Are you still there?" to a silent caller even though the reasoning gate returns null', async () => {
    const { ctx, result, silencePrompts } = await startCall();
    expect(ctx.reasoningMode).toBe('shadow');
    expect(ctx.reasoningGate?.mode).toBe('shadow');
    expect(ctx.reasoningGate?.handleSilence()).toBeNull();

    await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(silencePrompts()).toBe(1);
    result.session.close();
  });

  it('never-heard caller: 3 prompts, goodbye, the session is closed and the outcome is never_heard', async () => {
    const { transport, agentTurn, instructions, silencePrompts, sessionClosed } = await startCall();
    for (let i = 1; i <= NEVER_HEARD_PROMPTS; i += 1) {
      await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS);
      expect(silencePrompts()).toBe(i);
      agentTurn(); // the prompt is spoken
    }
    await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(instructions().at(-1)).toBe(NEVER_HEARD_GOODBYE_INSTRUCTION);
    expect(transport.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HANGUP_GRACE_MS);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(sessionClosed).toHaveBeenCalled();
    expect(persistCallOutcome).toHaveBeenCalledTimes(1);
    expect(persistCallOutcome).toHaveBeenCalledWith('t-watchdog', 'cs-watchdog', 'never_heard');
    expect(outcomeEvents()).toHaveLength(1);
    expect(outcomeEvents()[0][5]).toEqual({ outcome: 'never_heard' });

    const actions = vi.mocked(writeCallEvent).mock.calls.map((call) => call[2]);
    expect(actions.filter((a) => a === 'silence_prompt')).toHaveLength(NEVER_HEARD_PROMPTS);
    expect(actions.filter((a) => a === 'never_heard_hangup')).toHaveLength(1);
    // Counts only, no caller data.
    for (const call of vi.mocked(writeCallEvent).mock.calls.filter((c) => c[2] === 'silence_prompt')) {
      expect(Object.keys(call[5] ?? {}).sort()).toEqual(['heard', 'heardChecks', 'neverHeardPrompts']);
    }

    // No sends after close.
    const sent = transport.sendEvent.mock.calls.length;
    await vi.advanceTimersByTimeAsync(MAX_CALL_DURATION_MS);
    expect(transport.sendEvent.mock.calls.length).toBe(sent);
  });

  it('heard caller is never cut: one check after 15 s, then 5+ minutes of silence gives no hang-up and no more prompts', async () => {
    const { transport, callerSays, agentTurn, silencePrompts } = await startCall();
    callerSays("I'm looking for a fade Friday.");
    agentTurn();

    await vi.advanceTimersByTimeAsync(HEARD_SILENCE_CHECK_MS);
    expect(silencePrompts()).toBe(1);
    agentTurn(); // the check is spoken

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(silencePrompts()).toBe(1);
    expect(transport.close).not.toHaveBeenCalled();
    expect(persistCallOutcome).not.toHaveBeenCalled();
    transport.close();
  });

  it('timer re-arms when the greeting turn completes, not from session open', async () => {
    const ctx = makeCtx();
    const result = await createRealtimeSession(ctx);
    const transport = h.transports[h.transports.length - 1];
    const prompts = () => transport.sendEvent.mock.calls
      .filter(([e]) => (e as { response?: { instructions?: string } }).response?.instructions === SILENCE_PROMPT_INSTRUCTION).length;

    // Not armed before the socket opens.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(prompts()).toBe(0);

    transport.emit('session.created', {});
    transport.emit('response.created', {}); // greeting playing
    await vi.advanceTimersByTimeAsync(12_000);
    expect(prompts()).toBe(0);
    transport.emit('response.done', {}); // greeting done
    await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS - 1);
    expect(prompts()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(prompts()).toBe(1);
    result.session.close();
  });

  it('max cap: wrap-up and hang-up at 10 min with outcome max_duration, even for a heard caller', async () => {
    const { transport, callerSays, agentTurn, instructions } = await startCall();
    for (let elapsed = 0; elapsed < MAX_CALL_DURATION_MS - 10_000; elapsed += 10_000) {
      callerSays('Still deciding.');
      agentTurn();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(transport.close).not.toHaveBeenCalled();
    callerSays('Still deciding.');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(instructions().filter((text) => text === SILENCE_PROMPT_INSTRUCTION)).toEqual([]);
    expect(instructions().at(-1)).toBe(MAX_DURATION_WRAP_UP_INSTRUCTION);
    await vi.advanceTimersByTimeAsync(HANGUP_GRACE_MS);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(persistCallOutcome).toHaveBeenCalledWith('t-watchdog', 'cs-watchdog', 'max_duration');
    expect(outcomeEvents()).toHaveLength(1);
  });

  it('a later finalize outcome does not replace the watchdog outcome (first writer wins)', async () => {
    const { result } = await startCall();
    await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS * (NEVER_HEARD_PROMPTS + 1) + HANGUP_GRACE_MS);
    expect(result.recordCallOutcome('caller_hangup')).toBe(false);
    expect(persistCallOutcome).toHaveBeenCalledTimes(1);
    expect(outcomeEvents()).toHaveLength(1);
  });

  it('does not count silence while a tool runs', async () => {
    setToolRetryConfig('lookup_customer', { baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 120_000, maxRetries: 0 });
    let finishTool!: () => void;
    h.slowTool.mockImplementation(() => new Promise((resolve) => {
      finishTool = () => resolve({ success: true });
    }));
    const { transport, callerSays, silencePrompts } = await startCall({
      agentConfig: { ...makeCtx().agentConfig, tools: [{ name: 'lookup_customer', description: 'lookup', parameters: { type: 'object', properties: {} } }] } as never,
    });
    callerSays('Do you have anything at nine?');

    const run = transport.opts.onFunctionCall('lookup_customer', {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.slowTool).toHaveBeenCalledTimes(1);
    expect(silencePrompts()).toBe(0);

    finishTool();
    await run;
    await vi.advanceTimersByTimeAsync(HEARD_SILENCE_CHECK_MS);
    expect(silencePrompts()).toBe(1);
    clearToolRetryConfig('lookup_customer');
    transport.close();
  });

  it('closing the session clears the watchdog: no prompt after hang-up', async () => {
    const { transport, silencePrompts } = await startCall();
    transport.close();
    await vi.advanceTimersByTimeAsync(MAX_CALL_DURATION_MS + HANGUP_GRACE_MS);
    expect(silencePrompts()).toBe(0);
  });
});

describe('silence watchdog in enforce mode', () => {
  for (const [label, overrides] of [
    ['salon agent opted into enforce', { reasoningMode: 'enforce' }],
    ['core-receptionist (enforce by default)', {
      templateKey: 'core-receptionist',
      agentConfig: { ...makeCtx().agentConfig, rolePackageId: 'core-receptionist', metadata: { businessName: 'Acme Plumbing' } },
    }],
  ] as Array<[string, Partial<SessionContext>]>) {
    it(`${label}: exactly one prompt per silence, from the watchdog only`, async () => {
      const { ctx, transport, agentTurn, callerSays, instructions } = await startCall(overrides);
      expect(ctx.reasoningGate?.mode).toBe('enforce');
      callerSays('Hi there.');
      agentTurn(); // the agent's reply to the caller
      const before = instructions().length;

      await vi.advanceTimersByTimeAsync(HEARD_SILENCE_CHECK_MS);
      const added = instructions().slice(before);
      expect(added).toEqual([SILENCE_PROMPT_INSTRUCTION]);
      // The engine's own silence text is never sent.
      expect(instructions().some((text) => /silent for a while/.test(text))).toBe(false);

      agentTurn();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(instructions().slice(before)).toEqual([SILENCE_PROMPT_INSTRUCTION]);
      transport.close();
    });
  }
});

describe('caller heard during the never-heard goodbye (P1-2)', () => {
  it('never-heard → goodbye → caller speaks within the grace: no hang-up, no outcome, then a single heard check', async () => {
    const { transport, agentTurn, callerSays, instructions, silencePrompts, sessionClosed } = await startCall();
    for (let i = 1; i <= NEVER_HEARD_PROMPTS; i += 1) {
      await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS);
      agentTurn();
    }
    await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(instructions().at(-1)).toBe(NEVER_HEARD_GOODBYE_INSTRUCTION);
    agentTurn(); // the goodbye plays
    await vi.advanceTimersByTimeAsync(HANGUP_GRACE_MS - 2_000);

    callerSays("Hello? Yes, I'm here.");
    agentTurn(); // the agent answers
    await vi.advanceTimersByTimeAsync(HANGUP_GRACE_MS);
    expect(transport.close).not.toHaveBeenCalled();
    expect(sessionClosed).not.toHaveBeenCalled();
    expect(persistCallOutcome).not.toHaveBeenCalled();
    expect(outcomeEvents()).toHaveLength(0);
    expect(vi.mocked(writeCallEvent).mock.calls.filter((c) => c[2] === 'never_heard_hangup_cancelled')).toHaveLength(1);

    const before = silencePrompts();
    await vi.advanceTimersByTimeAsync(HEARD_SILENCE_CHECK_MS - HANGUP_GRACE_MS);
    expect(silencePrompts()).toBe(before + 1);
    agentTurn();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(silencePrompts()).toBe(before + 1);
    expect(transport.close).not.toHaveBeenCalled();
    transport.close();
  });
});

describe("phone path ('twilio_mark'): silence counts from the end of playback", () => {
  const phone: Partial<SessionContext> = { playbackConfirm: 'twilio_mark' };

  it('does not fire while playback is unconfirmed, even 15 s after response.done; fires 8 s after the echo', async () => {
    const { transport, marks, echo, silencePrompts } = await startCall(phone);
    expect(marks).toEqual(['agent-turn-1']); // the greeting's mark
    await vi.advanceTimersByTimeAsync(HEARD_SILENCE_CHECK_MS);
    expect(silencePrompts()).toBe(0);

    expect(echo()).toBe(true);
    await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS - 1);
    expect(silencePrompts()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(silencePrompts()).toBe(1);
    transport.close();
  });

  it('heard caller: the check fires 15 s after the echo of the agent\'s reply, not after its response.done', async () => {
    const { transport, agentTurn, callerSays, echo, silencePrompts } = await startCall(phone);
    echo();
    callerSays('Do you have anything Friday?');
    agentTurn();
    await vi.advanceTimersByTimeAsync(HEARD_SILENCE_CHECK_MS + 1_000);
    expect(silencePrompts()).toBe(0);
    echo();
    await vi.advanceTimersByTimeAsync(HEARD_SILENCE_CHECK_MS - 1);
    expect(silencePrompts()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(silencePrompts()).toBe(1);
    transport.close();
  });

  it('stale and unknown mark names are ignored; the fallback re-arms when no echo arrives', async () => {
    const { result, transport, agentTurn, marks, silencePrompts } = await startCall(phone);
    agentTurn();
    expect(marks).toEqual(['agent-turn-1', 'agent-turn-2']);
    expect(result.agentPlaybackDone('agent-turn-1')).toBe(false);
    expect(result.agentPlaybackDone('not-ours')).toBe(false);
    // The latest mark echoed after a new response started is stale too.
    transport.emit('response.created', { type: 'response.created' });
    expect(result.agentPlaybackDone('agent-turn-2')).toBe(false);
    transport.emit('response.done', { type: 'response.done' });

    await vi.advanceTimersByTimeAsync(PLAYBACK_ECHO_FALLBACK_MS - 1);
    expect(silencePrompts()).toBe(0);
    await vi.advanceTimersByTimeAsync(1 + NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(silencePrompts()).toBe(1);
    transport.close();
  });

  it('goodbye grace starts at the goodbye\'s echo (+ pad); the call closes with outcome never_heard', async () => {
    const { transport, agentTurn, echo, instructions, sessionClosed } = await startCall(phone);
    echo();
    for (let i = 1; i <= NEVER_HEARD_PROMPTS; i += 1) {
      await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS);
      agentTurn();
      echo();
    }
    await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS);
    expect(instructions().at(-1)).toBe(NEVER_HEARD_GOODBYE_INSTRUCTION);
    agentTurn(); // goodbye streamed, still playing on the phone
    await vi.advanceTimersByTimeAsync(HANGUP_GRACE_MS - 1);
    expect(transport.close).not.toHaveBeenCalled();
    expect(persistCallOutcome).not.toHaveBeenCalled();

    echo(); // the goodbye has played
    await vi.advanceTimersByTimeAsync(HANGUP_PLAYBACK_PAD_MS - 1);
    expect(transport.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(sessionClosed).toHaveBeenCalled();
    expect(persistCallOutcome).toHaveBeenCalledWith('t-watchdog', 'cs-watchdog', 'never_heard');
    expect(outcomeEvents()).toHaveLength(1);
  });
});

const speechStarted = (transport: { emit: (event: string, ...args: unknown[]) => boolean }) =>
  transport.emit('input_audio_buffer.speech_started', { type: 'input_audio_buffer.speech_started' });
const speechStopped = (transport: { emit: (event: string, ...args: unknown[]) => boolean }) =>
  transport.emit('input_audio_buffer.speech_stopped', { type: 'input_audio_buffer.speech_stopped' });

describe('caller speech (server VAD) pauses the watchdog', () => {
  it('a caller speaking for 30 s gets no prompt and no hang-up; speech_stopped re-arms on the heard ladder', async () => {
    const { transport, echo, silencePrompts, sessionClosed } = await startCall({ playbackConfirm: 'twilio_mark' });
    echo();
    await vi.advanceTimersByTimeAsync(3_000);
    speechStarted(transport);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(silencePrompts()).toBe(0);
    expect(transport.close).not.toHaveBeenCalled();
    expect(sessionClosed).not.toHaveBeenCalled();

    speechStopped(transport);
    await vi.advanceTimersByTimeAsync(HEARD_SILENCE_CHECK_MS - 1);
    expect(silencePrompts()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(silencePrompts()).toBe(1);
    transport.close();
  });

  it('audible but never transcribed (S17): the heard ladder, never cut; a hang-up records caller_hangup, not never_heard', async () => {
    const { result, transport, agentTurn, echo, silencePrompts } = await startCall({ playbackConfirm: 'twilio_mark' });
    echo();
    for (const pauseMs of [20_000, 30_000, 5 * 60_000]) {
      speechStarted(transport);
      await vi.advanceTimersByTimeAsync(2_000); // an utterance the transcriber returns nothing for
      speechStopped(transport);
      agentTurn(); // "Sorry, could you say that again?"
      echo();
      await vi.advanceTimersByTimeAsync(pauseMs);
    }
    // One check per quiet spell (the agent's own turn re-opens it), never a never-heard prompt or a cut.
    expect(silencePrompts()).toBe(3);
    const actions = vi.mocked(writeCallEvent).mock.calls.map((call) => call[2]);
    expect(actions.filter((a) => a === 'silence_check')).toHaveLength(3);
    expect(actions.filter((a) => a === 'silence_prompt' || a === 'never_heard_hangup')).toEqual([]);
    expect(transport.close).not.toHaveBeenCalled();
    expect(persistCallOutcome).not.toHaveBeenCalled();

    // The caller hangs up: the stream finalizer's default outcome stands.
    expect(result.recordCallOutcome('caller_hangup')).toBe(true);
    // Written through the call's bookkeeping queue, behind everything queued before it.
    expect(await result.flushBookkeeping()).toBe('drained');
    expect(persistCallOutcome).toHaveBeenCalledWith('t-watchdog', 'cs-watchdog', 'caller_hangup');
    transport.close();
  });

  it('a dialler blip under VAD_HEARD_MIN_SPEECH_MS stays never heard: the ladder runs to never_heard', async () => {
    const { transport, agentTurn, echo, silencePrompts } = await startCall({ playbackConfirm: 'twilio_mark' });
    echo();
    speechStarted(transport);
    await vi.advanceTimersByTimeAsync(100); // a click on the line (VAD trailing silence comes on top in real calls)
    speechStopped(transport);
    for (let i = 1; i <= NEVER_HEARD_PROMPTS; i += 1) {
      await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS);
      expect(silencePrompts()).toBe(i);
      agentTurn();
      echo();
    }
    await vi.advanceTimersByTimeAsync(NEVER_HEARD_PROMPT_INTERVAL_MS);
    agentTurn(); // the goodbye
    echo();
    await vi.advanceTimersByTimeAsync(HANGUP_PLAYBACK_PAD_MS);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(persistCallOutcome).toHaveBeenCalledWith('t-watchdog', 'cs-watchdog', 'never_heard');
  });
});

describe('barge-in on the phone path', () => {
  const phone: Partial<SessionContext> = { playbackConfirm: 'twilio_mark' };

  it('caller speech while a turn is still playing: onBargeIn once; that turn\'s mark echo no longer counts as played', async () => {
    const { result, transport, agentTurn, callerSays, marks, echo, silencePrompts } = await startCall(phone);
    const clears = vi.fn();
    result.onBargeIn(clears);
    echo(); // greeting played
    callerSays('Are you open right now?');
    agentTurn(); // "let me check..." streamed; Twilio still playing it
    speechStarted(transport); // the caller talks over it
    expect(clears).toHaveBeenCalledTimes(1);
    speechStarted(transport);
    expect(clears).toHaveBeenCalledTimes(1);
    // Twilio echoes the pending mark after the clear: nothing was pending any more.
    expect(result.agentPlaybackDone(marks.at(-1) ?? '')).toBe(false);
    await vi.advanceTimersByTimeAsync(PLAYBACK_ECHO_FALLBACK_MS + HEARD_SILENCE_CHECK_MS);
    expect(silencePrompts()).toBe(0); // not armed while the caller talks
    speechStopped(transport);
    await vi.advanceTimersByTimeAsync(HEARD_SILENCE_CHECK_MS);
    expect(silencePrompts()).toBe(1);
    transport.close();
  });

  it('caller speech with nothing playing (the turn\'s echo came back) is no barge-in', async () => {
    const { result, transport, echo } = await startCall(phone);
    const clears = vi.fn();
    result.onBargeIn(clears);
    echo();
    speechStarted(transport);
    speechStopped(transport);
    expect(clears).not.toHaveBeenCalled();
    transport.close();
  });

  it('caller speech while the model is still streaming: onBargeIn', async () => {
    const { result, transport, echo } = await startCall(phone);
    const clears = vi.fn();
    result.onBargeIn(clears);
    echo();
    transport.emit('response.created', { type: 'response.created' });
    speechStarted(transport);
    expect(clears).toHaveBeenCalledTimes(1);
    transport.close();
  });
});
