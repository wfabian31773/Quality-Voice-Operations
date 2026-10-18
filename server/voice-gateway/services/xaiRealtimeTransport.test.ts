import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sockets: FakeSocket[] = [];
const logged = vi.hoisted(() => [] as Array<{ message: string; context?: unknown }>);

vi.mock('../../../platform/core/logger', () => {
  const keep = (message: string, context?: unknown) => {
    logged.push({ message, context });
  };
  return { createLogger: () => ({ debug: keep, info: keep, warn: keep, error: keep }) };
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send = vi.fn((payload: string) => {
    this.sent.push(payload);
  });
  close = vi.fn(() => {
    this.emit('close');
  });
}

vi.mock('ws', () => ({
  default: class {
    static OPEN = 1;
    constructor() {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit('open'));
      return socket;
    }
  },
}));

import {
  CALLER_REPLY_WAIT_MS,
  RESPONSE_CANCEL_TIMEOUT_MS,
  RESPONSE_CREATED_TIMEOUT_MS,
  XaiRealtimeTransport,
} from './xaiRealtimeTransport';
import { HEARD_SILENCE_CHECK_MS } from './silenceWatchdog';
import { buildXaiSessionUpdate } from '../../../platform/agent-runtime/xaiSessionConfig';

describe('XaiRealtimeTransport', () => {
  beforeEach(() => {
    sockets.length = 0;
    logged.length = 0;
  });

  it('sends session.update on connect and plays function-call results back', async () => {
    const onFunctionCall = vi.fn(async () => JSON.stringify({ success: true }));
    const transport = new XaiRealtimeTransport({
      sessionUpdate: buildXaiSessionUpdate({
        instructions: 'You are the receptionist.',
        voice: 'eve',
        tools: [{ type: 'function', name: 'send_sms', description: 'Send SMS', parameters: { type: 'object' } }],
      }),
      onFunctionCall,
    });

    await transport.connect({ apiKey: 'xai-test' });
    expect(sockets).toHaveLength(1);
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ type: 'session.update' });

    sockets[0].emit('message', JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: 'send_sms',
      arguments: '{"toNumber":"+1555","body":"hi"}',
    }));

    await vi.waitFor(() => {
      expect(onFunctionCall).toHaveBeenCalledWith('send_sms', { toNumber: '+1555', body: 'hi' });
    });
    const types = sockets[0].sent.map((row) => JSON.parse(row).type);
    expect(types).toContain('conversation.item.create');
    expect(types).toContain('response.create');
  });

  function makeTransport(onFunctionCall: (name: string, args: Record<string, unknown>) => Promise<string>) {
    return new XaiRealtimeTransport({
      sessionUpdate: buildXaiSessionUpdate({ instructions: 'You are the receptionist.', voice: 'eve' }),
      onFunctionCall,
    });
  }

  it('drops a tool result that finishes after hangup without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let finish!: (value: string) => void;
      const onFunctionCall = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
      const transport = makeTransport(onFunctionCall);
      await transport.connect({ apiKey: 'xai-test' });
      sockets[0].emit('message', JSON.stringify({
        type: 'response.function_call_arguments.done', call_id: 'call-9', name: 'record_call_outcome', arguments: '{}',
      }));
      await vi.waitFor(() => expect(onFunctionCall).toHaveBeenCalled());
      const sentBeforeHangup = sockets[0].sent.length;

      transport.close(); // caller hangs up while the tool is still running
      finish(JSON.stringify({ success: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sockets[0].sent).toHaveLength(sentBeforeHangup);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('catches a rejected tool handler instead of leaking it', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const transport = makeTransport(async () => { throw new Error('handler blew up'); });
      await transport.connect({ apiKey: 'xai-test' });
      sockets[0].emit('message', JSON.stringify({
        type: 'response.function_call_arguments.done', call_id: 'call-10', name: 'lookup_customer', arguments: '{}',
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('surfaces server-VAD speech_started / speech_stopped', async () => {
    const transport = makeTransport(async () => '{}');
    await transport.connect({ apiKey: 'xai-test' });
    const seen: string[] = [];
    transport.on('input_audio_buffer.speech_started', () => seen.push('started'));
    transport.on('input_audio_buffer.speech_stopped', () => seen.push('stopped'));
    sockets[0].emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started', audio_start_ms: 10 }));
    sockets[0].emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 900 }));
    expect(seen).toEqual(['started', 'stopped']);
  });

  describe('barge-in (plan F10, S12)', () => {
    const server = (event: Record<string, unknown>) => sockets[0].emit('message', JSON.stringify(event));
    const delta = (n: number) => ({ type: 'response.output_audio.delta', delta: Buffer.from([n, n, n]).toString('base64') });
    const sentTypes = () => sockets[0].sent.map((row) => JSON.parse(row).type as string);

    async function connected(onFunctionCall: (name: string, args: Record<string, unknown>) => Promise<string> = async () => '{}') {
      const transport = makeTransport(onFunctionCall);
      await transport.connect({ apiKey: 'xai-test' });
      const audio: number[] = [];
      transport.on('audio', (a: { data: ArrayBuffer }) => audio.push(new Uint8Array(a.data)[0]));
      return { transport, audio };
    }

    it('drops the interrupted response\'s audio deltas after speech_started, until the next response', async () => {
      const { audio } = await connected();
      server({ type: 'response.created', response: { id: 'resp_1' } });
      server(delta(1));
      server({ type: 'input_audio_buffer.speech_started', audio_start_ms: 1_000 });
      server(delta(2)); // already on its way when the provider cancelled
      server({ type: 'response.done', response: { id: 'resp_1', status: 'cancelled' } });
      server({ type: 'response.created', response: { id: 'resp_2' } });
      server(delta(3));
      expect(audio).toEqual([1, 3]);
      // xAI's realtime API does not document conversation.item.truncate, so it is not sent.
      expect(sentTypes()).not.toContain('conversation.item.truncate');
    });

    it('logs one line with the count when it drops interrupted deltas (counts only, no audio)', async () => {
      await connected();
      server({ type: 'response.created', response: { id: 'resp_1' } });
      server({ type: 'input_audio_buffer.speech_started' });
      server(delta(2));
      server(delta(3));
      server({ type: 'response.done', response: { id: 'resp_1', status: 'cancelled' } });
      expect(logged.filter((l) => l.message.startsWith('Dropped interrupted'))).toEqual([]);
      server({ type: 'response.created', response: { id: 'resp_2' } });
      // A speech_started that dropped nothing logs nothing.
      server({ type: 'input_audio_buffer.speech_started' });
      server({ type: 'response.created', response: { id: 'resp_3' } });
      expect(logged.filter((l) => l.message.startsWith('Dropped interrupted'))).toEqual([
        { message: 'Dropped interrupted response audio after caller speech_started', context: { deltas: 2 } },
      ]);
    });

    it('speech with no response in flight drops nothing of the next response', async () => {
      const { audio } = await connected();
      server({ type: 'input_audio_buffer.speech_started' });
      server({ type: 'input_audio_buffer.speech_stopped' });
      server({ type: 'response.created', response: { id: 'resp_1' } });
      server(delta(7));
      expect(audio).toEqual([7]);
    });

    it('a tool result that lands after the caller spoke over the asking turn: output item, no response.create', async () => {
      let finish!: (value: string) => void;
      const onFunctionCall = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
      await connected(onFunctionCall);
      server({ type: 'response.created', response: { id: 'resp_1' } });
      server({ type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'get_current_tenant_time', arguments: '{}' });
      server({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
      await vi.waitFor(() => expect(onFunctionCall).toHaveBeenCalled());
      server({ type: 'input_audio_buffer.speech_started' }); // the caller talks over "let me check"
      finish(JSON.stringify({ success: true, time: '10:00' }));
      await vi.waitFor(() => expect(sentTypes()).toContain('conversation.item.create'));
      const output = sockets[0].sent.map((row) => JSON.parse(row)).find((e) => e.type === 'conversation.item.create');
      expect(output.item).toEqual({ type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ success: true, time: '10:00' }) });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sentTypes()).not.toContain('response.create');
    });

    it('a tool result with no caller speech since its turn started gets its response.create', async () => {
      let finish!: (value: string) => void;
      const onFunctionCall = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
      await connected(onFunctionCall);
      // The caller's turn (speech before the response) does not count against it.
      server({ type: 'input_audio_buffer.speech_started' });
      server({ type: 'input_audio_buffer.speech_stopped' });
      server({ type: 'response.created', response: { id: 'resp_1' } });
      server({ type: 'response.function_call_arguments.done', call_id: 'call-2', name: 'get_current_tenant_time', arguments: '{}' });
      await vi.waitFor(() => expect(onFunctionCall).toHaveBeenCalled());
      finish('{}');
      await vi.waitFor(() => expect(sentTypes()).toContain('conversation.item.create'));
      // The asking response is still in flight: its create waits for response.done (never two at once).
      expect(sentTypes()).not.toContain('response.create');
      server({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
      expect(sentTypes().filter((t) => t === 'response.create')).toHaveLength(1);
      expect(sentTypes().filter((t) => t === 'conversation.item.create')).toHaveLength(1);
    });

    describe('a withheld tool result is voiced once nobody else will (no silence after a write)', () => {
      const creates = () => sentTypes().filter((t) => t === 'response.create').length;
      const outputs = () => sentTypes().filter((t) => t === 'conversation.item.create').length;
      /** The tool handler's promise and the send after it: microtasks only, no timers. */
      const flush = async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      };

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      /** "Let me book that": the asking response makes a slow tool call and finishes; returns the tool's resolver. */
      async function slowToolAsked(n = 1) {
        const finishers: Array<(value: string) => void> = [];
        const onFunctionCall = vi.fn(() => new Promise<string>((resolve) => { finishers.push(resolve); }));
        const { transport } = await connected(onFunctionCall);
        server({ type: 'response.created', response: { id: 'resp_ask' } });
        for (let i = 1; i <= n; i += 1) {
          server({ type: 'response.function_call_arguments.done', call_id: `call-${i}`, name: 'create_booking', arguments: '{}' });
        }
        server({ type: 'response.done', response: { id: 'resp_ask', status: 'completed' } });
        await flush();
        expect(onFunctionCall).toHaveBeenCalledTimes(n);
        const finish = async (i = 0) => {
          finishers[i](JSON.stringify({ success: true }));
          await flush();
        };
        return { transport, finish };
      }

      it('CALLER_REPLY_WAIT_MS: room for the provider to create its reply, far inside the 15 s heard check', () => {
        expect(CALLER_REPLY_WAIT_MS).toBe(1_500);
        expect(CALLER_REPLY_WAIT_MS).toBeLessThan(HEARD_SILENCE_CHECK_MS / 5);
      });

      it('still speaking: withheld; the caller\'s reply created after it carries it, so nothing more is sent', async () => {
        const { finish } = await slowToolAsked();
        server({ type: 'input_audio_buffer.speech_started' });
        await finish();
        expect([outputs(), creates()]).toEqual([1, 0]);
        server({ type: 'input_audio_buffer.speech_stopped' });
        await vi.advanceTimersByTimeAsync(300);
        server({ type: 'response.created', response: { id: 'resp_reply' } }); // sees the output item
        server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        expect(creates()).toBe(0);
      });

      it('still speaking, then that speech gets no reply (noise): voiced once, CALLER_REPLY_WAIT_MS after speech_stopped', async () => {
        const { finish } = await slowToolAsked();
        server({ type: 'input_audio_buffer.speech_started' });
        await finish();
        server({ type: 'input_audio_buffer.speech_stopped' });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS - 1);
        expect(creates()).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(creates()).toBe(1);
        server({ type: 'response.created', response: { id: 'resp_voiced' } });
        server({ type: 'response.done', response: { id: 'resp_voiced', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        expect(creates()).toBe(1);
      });

      it('backchannel: the reply to "thanks" is in flight when the result lands → voiced once, after that reply is done', async () => {
        const { finish } = await slowToolAsked();
        server({ type: 'input_audio_buffer.speech_started' }); // "great, thanks"
        server({ type: 'input_audio_buffer.speech_stopped' });
        server({ type: 'response.created', response: { id: 'resp_thanks' } }); // created before the output item
        await finish();
        expect([outputs(), creates()]).toEqual([1, 0]); // never two responses at once
        server({ type: 'response.done', response: { id: 'resp_thanks', status: 'completed' } });
        expect(creates()).toBe(1);
        server({ type: 'response.created', response: { id: 'resp_voiced' } });
        server({ type: 'response.done', response: { id: 'resp_voiced', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        expect(creates()).toBe(1);
      });

      it('backchannel: the reply to "thanks" is already done when the result lands → voiced once, at once', async () => {
        const { finish } = await slowToolAsked();
        server({ type: 'input_audio_buffer.speech_started' });
        server({ type: 'input_audio_buffer.speech_stopped' });
        server({ type: 'response.created', response: { id: 'resp_thanks' } });
        server({ type: 'response.done', response: { id: 'resp_thanks', status: 'completed' } });
        await finish();
        expect([outputs(), creates()]).toEqual([1, 1]);
        server({ type: 'response.created', response: { id: 'resp_voiced' } });
        server({ type: 'response.done', response: { id: 'resp_voiced', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        expect(creates()).toBe(1);
      });

      it('noise: a speech_started/stopped with no caller response → voiced once after the wait', async () => {
        const { finish } = await slowToolAsked();
        server({ type: 'input_audio_buffer.speech_started' }); // a cough
        server({ type: 'input_audio_buffer.speech_stopped' });
        await vi.advanceTimersByTimeAsync(500);
        await finish(); // lands during the wait: the reply could still come
        expect(creates()).toBe(0);
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS - 500);
        expect(creates()).toBe(1);
      });

      it('noise long before the result: voiced at once when it lands', async () => {
        const { finish } = await slowToolAsked();
        server({ type: 'input_audio_buffer.speech_started' });
        server({ type: 'input_audio_buffer.speech_stopped' });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS);
        await finish();
        expect(creates()).toBe(1);
      });

      it('several results withheld together: one response.create for the batch', async () => {
        const { finish } = await slowToolAsked(2);
        server({ type: 'input_audio_buffer.speech_started' });
        await finish(0);
        await finish(1);
        server({ type: 'input_audio_buffer.speech_stopped' });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS);
        expect([outputs(), creates()]).toEqual([2, 1]);
        // Answered (an unanswered create would be given up and re-sent at RESPONSE_CREATED_TIMEOUT_MS).
        server({ type: 'response.created', response: { id: 'resp_voiced' } });
        server({ type: 'response.done', response: { id: 'resp_voiced', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        expect(creates()).toBe(1);
      });

      it('a normal result (no caller speech since its turn): one response.create at once, nothing deferred after it', async () => {
        const { finish } = await slowToolAsked();
        await finish();
        expect([outputs(), creates()]).toEqual([1, 1]);
        server({ type: 'response.created', response: { id: 'resp_after' } });
        server({ type: 'response.done', response: { id: 'resp_after', status: 'completed' } });
        server({ type: 'input_audio_buffer.speech_started' });
        server({ type: 'input_audio_buffer.speech_stopped' });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        expect(creates()).toBe(1);
      });

      it('hang-up while a result is deferred (caller speaking, or in the noise wait): nothing more is sent', async () => {
        const first = await slowToolAsked();
        server({ type: 'input_audio_buffer.speech_started' });
        await first.finish();
        const sentBefore = sockets[0].sent.length;
        first.transport.close();
        server({ type: 'input_audio_buffer.speech_stopped' });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        expect(sockets[0].sent).toHaveLength(sentBefore);
        expect(vi.getTimerCount()).toBe(0);

        sockets.length = 0;
        const second = await slowToolAsked();
        server({ type: 'input_audio_buffer.speech_started' });
        server({ type: 'input_audio_buffer.speech_stopped' });
        await second.finish();
        const sentBefore2 = sockets[0].sent.length;
        second.transport.close();
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        expect(sockets[0].sent).toHaveLength(sentBefore2);
        expect(sentTypes().filter((t) => t === 'response.create')).toHaveLength(0);
      });
    });
  });

  describe('one response.create path (RT-HOLD-LINE §4: the #133 review P3s)', () => {
    const server = (event: Record<string, unknown>) => sockets[0].emit('message', JSON.stringify(event));
    const sent = () => sockets[0].sent.map((row) => JSON.parse(row) as { type: string; response?: Record<string, unknown> });
    const sentTypes = () => sent().map((e) => e.type).filter((t) => t !== 'session.update');
    const creates = () => sent().filter((e) => e.type === 'response.create');
    const delta = (n: number) => ({ type: 'response.output_audio.delta', delta: Buffer.from([n, n, n]).toString('base64') });
    const flush = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };
    const holdLine = { kind: 'hold_line' as const, response: { instructions: 'Say exactly: "One moment while I check that.". Nothing else.' }, onlyIfIdle: true };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Connected, with a slow tool asked for by a response that has finished; returns its resolver. */
    async function toolRunning() {
      const finishers: Array<(value: string) => void> = [];
      const onFunctionCall = vi.fn(() => new Promise<string>((resolve) => { finishers.push(resolve); }));
      const transport = makeTransport(onFunctionCall);
      await transport.connect({ apiKey: 'xai-test' });
      const audio: number[] = [];
      transport.on('audio', (a: { data: ArrayBuffer }) => audio.push(new Uint8Array(a.data)[0]));
      const kinds: string[] = [];
      transport.on('response.created', (_e: unknown, meta: { kind: string }) => kinds.push(meta.kind));
      const timings: Array<Record<string, unknown>> = [];
      transport.on('tool_timing', (t: Record<string, unknown>) => timings.push(t));
      // Responses the transport counts in flight (created minus done/cancelled): never more than one.
      const live = { now: 0, max: 0 };
      transport.on('response.created', () => { live.now += 1; live.max = Math.max(live.max, live.now); });
      transport.on('response.done', () => { live.now -= 1; });
      transport.on('response.cancelled', () => { live.now -= 1; });
      server({ type: 'response.created', response: { id: 'resp_ask' } });
      server({ type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'check_availability', arguments: '{}' });
      server({ type: 'response.done', response: { id: 'resp_ask', status: 'completed' } });
      await flush();
      const finish = async () => {
        finishers.shift()?.(JSON.stringify({ success: true }));
        await flush();
      };
      return { transport, finish, audio, kinds, timings, live };
    }

    /** After close: no timer (create or cancel wait, reply wait) sends anything. */
    async function expectQuietAfterClose(transport: XaiRealtimeTransport) {
      transport.close();
      const before = sockets[0].sent.length;
      await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS + RESPONSE_CANCEL_TIMEOUT_MS + CALLER_REPLY_WAIT_MS);
      expect(sockets[0].sent).toHaveLength(before);
    }

    it('normal tool path: a result landing while a server reply is in flight waits for its response.done', async () => {
      const { finish } = await toolRunning();
      server({ type: 'response.created', response: { id: 'resp_other' } }); // e.g. a reply the provider started
      await finish();
      expect(sentTypes()).toEqual(['conversation.item.create']);
      server({ type: 'response.done', response: { id: 'resp_other', status: 'completed' } });
      // That reply was created before the output item, so it could not carry it: voiced now, once.
      expect(creates()).toHaveLength(1);
    });

    it('a queued tool result is skipped when a response created after its output already carries it', async () => {
      const { transport, finish } = await toolRunning();
      expect(transport.requestResponse({ kind: 'instruction', response: { instructions: 'Say exactly: "Hi". Do not say anything else.' } })).toBe(true);
      await finish(); // output sent while our instruction's create is pending: queued
      expect(creates()).toHaveLength(1);
      server({ type: 'response.created', response: { id: 'resp_instr' } }); // created after the output: sees it
      server({ type: 'response.done', response: { id: 'resp_instr', status: 'completed' } });
      expect(creates()).toHaveLength(1);
    });

    it('sendModelInstruction semantics: cancel the response in flight, then create (cancel first on the socket)', async () => {
      const transport = makeTransport(async () => '{}');
      await transport.connect({ apiKey: 'xai-test' });
      server({ type: 'response.created', response: { id: 'resp_vad' } });
      transport.requestResponse({ kind: 'instruction', response: { instructions: 'Ask: "Which day?"' }, cancelInFlight: true });
      expect(sentTypes()).toEqual(['response.cancel', 'response.create']);
      server(delta(1)); // late delta of the cancelled response: dropped
      server({ type: 'response.done', response: { id: 'resp_vad', status: 'cancelled' } });
      expect(creates()).toHaveLength(1);
      server({ type: 'response.created', response: { id: 'resp_instr' } });
      // A second instruction replaces the first the same way: cancel, then create.
      transport.requestResponse({ kind: 'instruction', response: { instructions: 'Say: "Two"' }, cancelInFlight: true });
      expect(sentTypes().slice(-2)).toEqual(['response.cancel', 'response.create']);
      server({ type: 'response.done', response: { id: 'resp_instr', status: 'cancelled' } });
      expect(creates()).toHaveLength(2);
    });

    it('an instruction while our create is still pending: that one is cancelled once created, then the instruction goes', async () => {
      const transport = makeTransport(async () => '{}');
      await transport.connect({ apiKey: 'xai-test' });
      transport.requestResponse({ kind: 'caller_text' });
      transport.requestResponse({ kind: 'instruction', response: { instructions: 'Say: "Sorry"' }, cancelInFlight: true });
      expect(sentTypes()).toEqual(['response.create']);
      server({ type: 'response.created', response: { id: 'resp_text' } });
      expect(sentTypes()).toEqual(['response.create', 'response.cancel']);
      server({ type: 'response.done', response: { id: 'resp_text', status: 'cancelled' } });
      expect(sentTypes()).toEqual(['response.create', 'response.cancel', 'response.create']);
      expect(creates()[1].response).toEqual({ instructions: 'Say: "Sorry"' });
    });

    it('widget caller text: queued behind a response in flight, not sent on top of it', async () => {
      const transport = makeTransport(async () => '{}');
      await transport.connect({ apiKey: 'xai-test' });
      server({ type: 'response.created', response: { id: 'resp_1' } });
      expect(transport.requestResponse({ kind: 'caller_text' })).toBe(true);
      expect(creates()).toHaveLength(0);
      server({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
      expect(creates()).toHaveLength(1);
    });

    describe('rapid widget messages coalesce into one reply (Codex 4308599619)', () => {
      async function widget() {
        const transport = makeTransport(async () => '{}');
        await transport.connect({ apiKey: 'xai-test' });
        const typed = (text: string) => {
          transport.sendEvent({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
          return transport.requestResponse({ kind: 'caller_text' });
        };
        return { transport, typed };
      }

      it.each([2, 3])('%i messages while a response is in flight: every item added, exactly one reply', async (n) => {
        const { transport, typed } = await widget();
        server({ type: 'response.created', response: { id: 'resp_1' } });
        for (let i = 0; i < n; i += 1) expect(typed(`message ${i}`)).toBe(true);
        expect(sentTypes().filter((t) => t === 'conversation.item.create')).toHaveLength(n);
        expect(creates()).toHaveLength(0);
        server({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
        expect(creates()).toHaveLength(1);
        server({ type: 'response.created', response: { id: 'resp_reply' } });
        server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(creates()).toHaveLength(1);
        await expectQuietAfterClose(transport);
      });

      it('a message after the coalesced reply was sent gets one more reply (that create could not see it)', async () => {
        const { transport, typed } = await widget();
        server({ type: 'response.created', response: { id: 'resp_1' } });
        typed('one');
        typed('two');
        server({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
        expect(creates()).toHaveLength(1); // the coalesced reply, sent
        typed('three'); // before it is even created
        typed('four'); // coalesces with "three"
        server({ type: 'response.created', response: { id: 'resp_reply' } });
        typed('five'); // still queued behind the reply: coalesces too
        server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
        expect(creates()).toHaveLength(2);
        server({ type: 'response.created', response: { id: 'resp_reply2' } });
        server({ type: 'response.done', response: { id: 'resp_reply2', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(creates()).toHaveLength(2);
        await expectQuietAfterClose(transport);
      });

      it('a rejected typed reply is not re-sent when a later one is queued: that one answers both', async () => {
        const { transport, typed } = await widget();
        typed('one'); // sent at once
        typed('two'); // queued behind the pending create
        server({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'response in progress' } });
        expect(creates()).toHaveLength(2);
        server({ type: 'response.created', response: { id: 'resp_reply' } });
        server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(creates()).toHaveLength(2);
        await expectQuietAfterClose(transport);
      });

      it('nothing after close: the queued reply is dropped, later messages queue nothing', async () => {
        const { transport, typed } = await widget();
        server({ type: 'response.created', response: { id: 'resp_1' } });
        typed('one');
        typed('two');
        transport.close();
        const before = sockets[0].sent.length;
        expect(transport.requestResponse({ kind: 'caller_text' })).toBe(false);
        server({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(sockets[0].sent).toHaveLength(before);
      });
    });

    it('nothing is sent after close; queued requests are dropped', async () => {
      const transport = makeTransport(async () => '{}');
      await transport.connect({ apiKey: 'xai-test' });
      server({ type: 'response.created', response: { id: 'resp_1' } });
      transport.requestResponse({ kind: 'caller_text' });
      transport.close();
      const before = sockets[0].sent.length;
      expect(transport.requestResponse({ kind: 'instruction', response: { instructions: 'x' }, cancelInFlight: true })).toBe(false);
      server({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });
      expect(sockets[0].sent).toHaveLength(before);
    });

    describe('provider error events (P3 #2)', () => {
      it('the provider\'s own reply wins the race with our voicing: it carries the result, the rejection is only logged', async () => {
        const { transport, finish } = await toolRunning();
        server({ type: 'input_audio_buffer.speech_started' });
        await finish(); // withheld: the caller spoke over the asking turn
        server({ type: 'input_audio_buffer.speech_stopped' });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS); // no reply yet: voiced
        expect(creates()).toHaveLength(1);
        // On the wire: the provider's own response.created, then the error for ours.
        server({ type: 'response.created', response: { id: 'resp_provider' } });
        server({ type: 'error', error: { code: 'conversation_already_has_active_response', message: 'Conversation already has an active response' } });
        server({ type: 'response.done', response: { id: 'resp_provider', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        // Created after the output, so it carried it: not voiced twice, and nothing left stuck in flight.
        expect(creates()).toHaveLength(1);
        expect(logged.find((l) => l.message === 'xAI realtime provider error')?.context).toEqual({
          code: 'conversation_already_has_active_response', type: undefined, pendingCreate: undefined, rejectsCreate: false,
        });
        expect(transport.requestResponse({ kind: 'caller_text' })).toBe(true);
        expect(creates()).toHaveLength(2);
      });

      it('a rejected voicing with no carrier is voiced again (later voicing is not blocked)', async () => {
        const { finish } = await toolRunning();
        server({ type: 'input_audio_buffer.speech_started' });
        await finish();
        server({ type: 'input_audio_buffer.speech_stopped' });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS);
        expect(creates()).toHaveLength(1);
        server({ type: 'error', error: { code: 'conversation_already_has_active_response' } });
        // Not stuck "in flight": voiced again at once.
        expect(creates()).toHaveLength(2);
        server({ type: 'response.created', response: { id: 'resp_voiced' } });
        server({ type: 'response.done', response: { id: 'resp_voiced', status: 'completed' } });
        expect(creates()).toHaveLength(2);
      });

      it('a voicing the provider keeps rejecting is re-sent once, never in a loop', async () => {
        const { finish } = await toolRunning();
        server({ type: 'input_audio_buffer.speech_started' });
        await finish();
        server({ type: 'input_audio_buffer.speech_stopped' });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS);
        server({ type: 'error', error: { code: 'conversation_already_has_active_response' } });
        server({ type: 'error', error: { code: 'conversation_already_has_active_response' } });
        server({ type: 'response.done', response: { id: 'resp_unknown', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        expect(creates()).toHaveLength(2);
      });

      it('a rejected tool-result create is re-queued once and sent at the next response.done', async () => {
        const { finish } = await toolRunning();
        await finish();
        expect(creates()).toHaveLength(1);
        server({ type: 'error', error: { code: 'conversation_already_has_active_response' } });
        expect(creates()).toHaveLength(2); // nothing in flight on our side: re-sent at once
        server({ type: 'error', error: { code: 'conversation_already_has_active_response' } });
        expect(creates()).toHaveLength(2); // only once
      });

      it('an error about a cancel (or with no pending create) is only logged', async () => {
        const transport = makeTransport(async () => '{}');
        await transport.connect({ apiKey: 'xai-test' });
        transport.requestResponse({ kind: 'caller_text' });
        server({ type: 'error', error: { code: 'response_cancel_not_active', message: 'no active response to cancel' } });
        server({ type: 'response.created', response: { id: 'resp_text' } });
        server({ type: 'response.done', response: { id: 'resp_text', status: 'completed' } });
        transport.requestResponse({ kind: 'caller_text' });
        expect(creates()).toHaveLength(2);
        server({ type: 'error', error: { code: 'invalid_value', message: 'secret caller words' } });
        // Logged with code/type only, never the message text.
        expect(JSON.stringify(logged)).not.toContain('secret caller words');
      });
    });

    describe('a create or cancel that never lands (review round 1, P2)', () => {
      const cancels = () => sent().filter((e) => e.type === 'response.cancel');

      it('no event_id on any response.create or response.cancel (xAI acceptance unconfirmed; review round 2)', async () => {
        const { transport, finish } = await toolRunning();
        transport.requestResponse(holdLine);
        server({ type: 'response.created', response: { id: 'resp_hold' } });
        await finish(); // silent hold line cancelled
        server({ type: 'response.done', response: { id: 'resp_hold', status: 'cancelled' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS); // the result's create is lost: fenced by a cancel
        const wire = sockets[0].sent.map((row) => JSON.parse(row) as Record<string, unknown>)
          .filter((e) => e.type === 'response.create' || e.type === 'response.cancel');
        expect(wire.map((e) => e.type)).toEqual(['response.create', 'response.cancel', 'response.create', 'response.cancel']);
        expect(wire.filter((e) => 'event_id' in e)).toEqual([]);
        await expectQuietAfterClose(transport);
      });

      it('an unrecognised error after the hold-line create: lost at the timeout, the result voiced once, the path free again', async () => {
        const { transport, finish, audio, kinds, live } = await toolRunning();
        transport.requestResponse(holdLine);
        // Not tied to anything we can recognise (no "response").
        server({ type: 'error', error: { code: 'invalid_value', message: 'Invalid value: none' } });
        await finish(); // the result lands behind the hold line's pending create
        expect(creates()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS - 1);
        expect(creates()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        // Lost: a cancel fences it (in case it is only late), then the result goes, once.
        expect(sentTypes().at(-1)).toBe('response.cancel');
        expect(logged.find((l) => l.message === 'xAI response.create got no response.created in time: treated as lost')?.context)
          .toEqual({ kind: 'hold_line', waitedMs: RESPONSE_CREATED_TIMEOUT_MS, queued: 1, retried: false });
        server({ type: 'error', error: { code: 'response_cancel_not_active', message: 'no active response to cancel' } });
        expect(creates()).toHaveLength(2);
        expect(creates()[1].response).toBeUndefined(); // the result's own response, not the hold line again
        server({ type: 'response.created', response: { id: 'resp_answer' } });
        server(delta(1));
        server({ type: 'response.done', response: { id: 'resp_answer', status: 'completed' } });
        // "hello?": the provider's reply is its own, not claimed as the hold line, not cancelled.
        server({ type: 'input_audio_buffer.speech_started' });
        server({ type: 'input_audio_buffer.speech_stopped' });
        server({ type: 'response.created', response: { id: 'resp_reply' } });
        server(delta(2));
        server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
        // The silence ladder's check-in is not swallowed: it goes at once.
        transport.requestResponse({ kind: 'instruction', response: { instructions: 'Ask: "Are you still there?"' }, cancelInFlight: true });
        expect(creates()).toHaveLength(3);
        expect(creates()[2].response).toEqual({ instructions: 'Ask: "Are you still there?"' });
        server({ type: 'response.created', response: { id: 'resp_check' } });
        server({ type: 'response.done', response: { id: 'resp_check', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(creates()).toHaveLength(3);
        expect(cancels()).toHaveLength(1);
        expect(kinds).toEqual(['server', 'tool_result', 'server', 'instruction']);
        expect(audio).toEqual([1, 2]);
        expect(live).toEqual({ now: 0, max: 1 });
        await expectQuietAfterClose(transport);
      });

      it('a create the provider never answers: lost at the timeout, re-sent once after its cancel wait, voiced once', async () => {
        const { transport, finish, audio, live } = await toolRunning();
        await finish();
        expect(creates()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS);
        expect(sentTypes().at(-1)).toBe('response.cancel');
        expect(creates()).toHaveLength(1); // not until the cancel lands or times out
        await vi.advanceTimersByTimeAsync(RESPONSE_CANCEL_TIMEOUT_MS); // this provider says nothing to it either
        expect(creates()).toHaveLength(2);
        server({ type: 'response.created', response: { id: 'resp_answer' } });
        server(delta(3));
        server({ type: 'response.done', response: { id: 'resp_answer', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(creates()).toHaveLength(2);
        expect(audio).toEqual([3]);
        expect(live).toEqual({ now: 0, max: 1 });
        await expectQuietAfterClose(transport);
      });

      it('an instruction asked for while a create hangs is not swallowed: it goes once the create is given up', async () => {
        const { transport } = await toolRunning();
        transport.requestResponse({ kind: 'caller_text' });
        transport.requestResponse({ kind: 'instruction', response: { instructions: 'Ask: "Are you still there?"' }, cancelInFlight: true });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS + RESPONSE_CANCEL_TIMEOUT_MS);
        // The superseded caller_text is not re-sent; the instruction is.
        expect(creates().map((c) => c.response)).toEqual([undefined, { instructions: 'Ask: "Are you still there?"' }]);
        await expectQuietAfterClose(transport);
      });

      it('a create lost twice is not sent a third time (no loop)', async () => {
        const { transport, finish } = await toolRunning();
        await finish();
        await vi.advanceTimersByTimeAsync((RESPONSE_CREATED_TIMEOUT_MS + RESPONSE_CANCEL_TIMEOUT_MS) * 4);
        expect(creates()).toHaveLength(2);
        await expectQuietAfterClose(transport);
      });

      it('a cancel never acknowledged: the response counts as ended at the timeout; its late done is ignored', async () => {
        const { transport, finish, audio, kinds, live } = await toolRunning();
        const ended: string[] = [];
        transport.on('response.cancelled', (_e: unknown, meta: { kind: string }) => ended.push(meta.kind));
        transport.requestResponse(holdLine);
        server({ type: 'response.created', response: { id: 'resp_hold' } });
        await finish(); // before any hold-line audio: cancelled
        expect(sentTypes().at(-1)).toBe('response.cancel');
        server(delta(5)); // dropped
        await vi.advanceTimersByTimeAsync(RESPONSE_CANCEL_TIMEOUT_MS - 1);
        expect(creates()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(ended).toEqual(['hold_line']);
        expect(creates()).toHaveLength(2); // the result's own response
        server({ type: 'response.created', response: { id: 'resp_answer' } });
        server(delta(6));
        // The hold line's done finally arrives: it must not end the answer in flight.
        server({ type: 'response.done', response: { id: 'resp_hold', status: 'cancelled' } });
        expect(ended).toEqual(['hold_line']);
        expect(transport.requestResponse(holdLine)).toBe(false); // the answer is still in flight
        server(delta(7));
        server({ type: 'response.done', response: { id: 'resp_answer', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(creates()).toHaveLength(2);
        expect(audio).toEqual([6, 7]);
        expect(kinds).toEqual(['server', 'hold_line', 'tool_result']);
        expect(live).toEqual({ now: 0, max: 1 });
        await expectQuietAfterClose(transport);
      });

      it('a late response.created after the timeout: retired silently by the cancel, then the result, once', async () => {
        const { transport, finish, audio, kinds, live } = await toolRunning();
        transport.requestResponse(holdLine);
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS);
        expect(cancels()).toHaveLength(1);
        await finish(); // the result lands while the lost hold line's cancel is out: queued
        expect(creates()).toHaveLength(1);
        // The provider was only slow: the hold line is created now, and our cancel lands right after it.
        server({ type: 'response.created', response: { id: 'resp_hold' } });
        server(delta(5)); // never heard
        expect(creates()).toHaveLength(1); // still one in flight: nothing on top of it
        server({ type: 'response.done', response: { id: 'resp_hold', status: 'cancelled' } });
        expect(creates()).toHaveLength(2);
        server({ type: 'response.created', response: { id: 'resp_answer' } });
        server(delta(6));
        server({ type: 'response.done', response: { id: 'resp_answer', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(creates()).toHaveLength(2);
        expect(audio).toEqual([6]);
        expect(kinds).toEqual(['server', 'hold_line', 'tool_result']);
        expect(live).toEqual({ now: 0, max: 1 });
        await expectQuietAfterClose(transport);
      });

      it('the caller\'s "hello?" after the timeout: the provider\'s reply is not taken for the lost hold line', async () => {
        const { transport, audio, kinds, live } = await toolRunning();
        transport.requestResponse(holdLine);
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS);
        server({ type: 'input_audio_buffer.speech_started' });
        server({ type: 'input_audio_buffer.speech_stopped' });
        server({ type: 'response.created', response: { id: 'resp_reply' } });
        server(delta(8));
        expect(cancels()).toHaveLength(1); // only the lost create's fence
        server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
        expect(kinds).toEqual(['server', 'server']);
        expect(audio).toEqual([8]);
        expect(transport.requestResponse({ kind: 'caller_text' })).toBe(true);
        expect(creates()).toHaveLength(2);
        expect(live.max).toBe(1);
        await expectQuietAfterClose(transport);
      });

      it('the caller\'s reply still playing when a lost create\'s cancel wait runs out: played in full, the result voiced once (review round 2, P2 #2)', async () => {
        const { transport, finish, audio, kinds, live } = await toolRunning();
        const ended: string[] = [];
        transport.on('response.cancelled', (_e: unknown, meta: { kind: string }) => ended.push(meta.kind));
        await finish();
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS); // the result's create is lost: its cancel goes out
        expect(cancels()).toHaveLength(1);
        // "hello?": the provider replies, and never answers our cancel.
        server({ type: 'input_audio_buffer.speech_started' });
        server({ type: 'input_audio_buffer.speech_stopped' });
        server({ type: 'response.created', response: { id: 'resp_reply' } });
        server(delta(8));
        await vi.advanceTimersByTimeAsync(RESPONSE_CANCEL_TIMEOUT_MS + 1);
        server(delta(9));
        server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(ended).toEqual([]); // never faked-cancelled
        expect(audio).toEqual([8, 9]);
        expect(kinds).toEqual(['server', 'server']);
        // The reply was created after the output, so it carried it: the re-queued result is not sent again.
        expect(creates()).toHaveLength(1);
        expect(cancels()).toHaveLength(1);
        expect(live).toEqual({ now: 0, max: 1 });
        await expectQuietAfterClose(transport);
      });
    });

    describe('the hold line', () => {
      it('only if idle: refused while a response is in flight, the caller is speaking, or their reply is due', async () => {
        const { transport } = await toolRunning();
        server({ type: 'response.created', response: { id: 'resp_x' } });
        expect(transport.requestResponse(holdLine)).toBe(false);
        server({ type: 'response.done', response: { id: 'resp_x', status: 'completed' } });
        server({ type: 'input_audio_buffer.speech_started' });
        expect(transport.requestResponse(holdLine)).toBe(false);
        server({ type: 'input_audio_buffer.speech_stopped' });
        expect(transport.requestResponse(holdLine)).toBe(false); // reply due
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS);
        expect(transport.requestResponse(holdLine)).toBe(true);
        expect(creates().at(-1)?.response).toEqual(holdLine.response);
      });

      it('result lands while the hold line is playing: it is not cut; the result response waits for its done', async () => {
        const { transport, finish, audio, kinds } = await toolRunning();
        transport.requestResponse(holdLine);
        server({ type: 'response.created', response: { id: 'resp_hold' } });
        server(delta(5));
        await finish();
        expect(sentTypes()).not.toContain('response.cancel');
        expect(creates()).toHaveLength(1);
        server(delta(6));
        server({ type: 'response.done', response: { id: 'resp_hold', status: 'completed' } });
        expect(creates()).toHaveLength(2);
        expect(audio).toEqual([5, 6]);
        expect(kinds).toEqual(['server', 'hold_line']);
      });

      it('result lands before the hold line made a sound: cancelled, its late deltas dropped, straight to the result', async () => {
        const { transport, finish, audio } = await toolRunning();
        transport.requestResponse(holdLine);
        server({ type: 'response.created', response: { id: 'resp_hold' } });
        await finish();
        expect(sentTypes()).toEqual(['response.create', 'conversation.item.create', 'response.cancel']);
        server(delta(5));
        server({ type: 'response.done', response: { id: 'resp_hold', status: 'cancelled' } });
        expect(creates()).toHaveLength(2);
        expect(audio).toEqual([]);
      });

      it('result lands while the hold line is requested but not created: cancelled as soon as it is', async () => {
        const { transport, finish } = await toolRunning();
        transport.requestResponse(holdLine);
        await finish();
        expect(sentTypes()).toEqual(['response.create', 'conversation.item.create']);
        server({ type: 'response.created', response: { id: 'resp_hold' } });
        expect(sentTypes().at(-1)).toBe('response.cancel');
        server({ type: 'response.done', response: { id: 'resp_hold', status: 'cancelled' } });
        expect(creates()).toHaveLength(2);
      });

      describe('two concurrent tool calls in one response (Codex 4308599613)', () => {
        /** The asking response calls a fast and a slow tool together; returns per-tool resolvers. */
        async function twoToolsRunning() {
          const finishers = new Map<string, (value: string) => void>();
          const onFunctionCall = vi.fn((name: string) => new Promise<string>((resolve) => { finishers.set(name, resolve); }));
          const transport = makeTransport(onFunctionCall);
          await transport.connect({ apiKey: 'xai-test' });
          const audio: number[] = [];
          transport.on('audio', (a: { data: ArrayBuffer }) => audio.push(new Uint8Array(a.data)[0]));
          const kinds: string[] = [];
          transport.on('response.created', (_e: unknown, meta: { kind: string }) => kinds.push(meta.kind));
          const live = { now: 0, max: 0 };
          transport.on('response.created', () => { live.now += 1; live.max = Math.max(live.max, live.now); });
          transport.on('response.done', () => { live.now -= 1; });
          transport.on('response.cancelled', () => { live.now -= 1; });
          server({ type: 'response.created', response: { id: 'resp_ask' } });
          server({ type: 'response.function_call_arguments.done', call_id: 'call-fast', name: 'list_services', arguments: '{}' });
          server({ type: 'response.function_call_arguments.done', call_id: 'call-slow', name: 'check_availability', arguments: '{}' });
          server({ type: 'response.done', response: { id: 'resp_ask', status: 'completed' } });
          await flush();
          expect(onFunctionCall).toHaveBeenCalledTimes(2);
          const finish = async (name: string) => {
            finishers.get(name)?.(JSON.stringify({ success: true }));
            await flush();
          };
          return { transport, finish, audio, kinds, live };
        }

        /** The hold line plays in full, then each result is voiced once on its own response, never overlapping. */
        async function expectHoldLineThenBothResults(t: Awaited<ReturnType<typeof twoToolsRunning>>) {
          server(delta(5));
          server({ type: 'response.done', response: { id: 'resp_hold', status: 'completed' } });
          expect(creates()).toHaveLength(2); // the fast result's response, behind the hold line
          server({ type: 'response.created', response: { id: 'resp_fast' } });
          server(delta(6));
          server({ type: 'response.done', response: { id: 'resp_fast', status: 'completed' } });
          await vi.advanceTimersByTimeAsync(1_000); // the slow tool lands at ~2 s
          await t.finish('check_availability');
          expect(creates()).toHaveLength(3);
          server({ type: 'response.created', response: { id: 'resp_slow' } });
          server(delta(7));
          server({ type: 'response.done', response: { id: 'resp_slow', status: 'completed' } });
          await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
          expect(creates()).toHaveLength(3);
          expect(sentTypes()).not.toContain('response.cancel');
          expect(t.audio).toEqual([5, 6, 7]);
          expect(t.kinds).toEqual(['server', 'hold_line', 'tool_result', 'tool_result']);
          expect(t.live).toEqual({ now: 0, max: 1 });
          await expectQuietAfterClose(t.transport);
        }

        it('the fast result lands while the hold line is requested: not cancelled, it still plays', async () => {
          const t = await twoToolsRunning();
          await vi.advanceTimersByTimeAsync(800);
          expect(t.transport.requestResponse(holdLine)).toBe(true);
          await vi.advanceTimersByTimeAsync(100);
          await t.finish('list_services'); // the slow tool is still running
          server({ type: 'response.created', response: { id: 'resp_hold' } });
          expect(sentTypes()).not.toContain('response.cancel');
          await expectHoldLineThenBothResults(t);
        });

        it('the fast result lands after the hold line is created, before its audio: not cancelled, it still plays', async () => {
          const t = await twoToolsRunning();
          await vi.advanceTimersByTimeAsync(800);
          t.transport.requestResponse(holdLine);
          server({ type: 'response.created', response: { id: 'resp_hold' } });
          await vi.advanceTimersByTimeAsync(100);
          await t.finish('list_services');
          expect(sentTypes()).not.toContain('response.cancel');
          await expectHoldLineThenBothResults(t);
        });

        it('the last tool\'s result before any hold-line audio still cancels it', async () => {
          const t = await twoToolsRunning();
          await t.finish('list_services'); // nothing in flight: its own response at once
          server({ type: 'response.created', response: { id: 'resp_fast' } });
          server({ type: 'response.done', response: { id: 'resp_fast', status: 'completed' } });
          await vi.advanceTimersByTimeAsync(800);
          t.transport.requestResponse(holdLine);
          server({ type: 'response.created', response: { id: 'resp_hold' } });
          await t.finish('check_availability');
          expect(sentTypes().at(-1)).toBe('response.cancel');
          server(delta(5));
          server({ type: 'response.done', response: { id: 'resp_hold', status: 'cancelled' } });
          expect(creates()).toHaveLength(3);
          expect(t.audio).toEqual([]);
          await expectQuietAfterClose(t.transport);
        });
      });

      it('barge-in on the hold line: the queued result starts no response of its own (the caller\'s turn answers)', async () => {
        const { transport, finish } = await toolRunning();
        transport.requestResponse(holdLine);
        server({ type: 'response.created', response: { id: 'resp_hold' } });
        server(delta(5));
        await finish(); // queued behind the hold line
        server({ type: 'input_audio_buffer.speech_started' }); // "hello?" over the hold line
        server({ type: 'response.done', response: { id: 'resp_hold', status: 'cancelled' } });
        expect(creates()).toHaveLength(1);
        server({ type: 'input_audio_buffer.speech_stopped' });
        server({ type: 'response.created', response: { id: 'resp_reply' } }); // server VAD reply carries the output
        server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS * 4);
        expect(creates()).toHaveLength(1);
      });

      it('the caller starts talking before the hold line is created: dropped at once; created anyway, it is retired unheard (review P3 #1)', async () => {
        const { transport, finish, audio, kinds, live } = await toolRunning();
        transport.requestResponse(holdLine);
        server({ type: 'input_audio_buffer.speech_started' });
        expect(sentTypes().at(-1)).toBe('response.cancel'); // its fence, sent right behind the create
        server({ type: 'response.created', response: { id: 'resp_hold' } }); // mid-utterance: it can only be the hold line
        server(delta(5));
        server({ type: 'response.done', response: { id: 'resp_hold', status: 'cancelled' } });
        await finish(); // the caller spoke over the asking turn: withheld for their own turn
        server({ type: 'input_audio_buffer.speech_stopped' });
        server({ type: 'response.created', response: { id: 'resp_reply' } });
        server(delta(6));
        server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(audio).toEqual([6]);
        expect(kinds).toEqual(['server', 'hold_line', 'server']);
        expect(sent().filter((e) => e.type === 'response.cancel')).toHaveLength(1);
        expect(creates()).toHaveLength(1); // the reply carried the result
        expect(live).toEqual({ now: 0, max: 1 });
        await expectQuietAfterClose(transport);
      });

      it('the caller starts talking while the hold-line create is unanswered: the provider\'s reply is theirs, heard, never cancelled (review round 2, P3 #1)', async () => {
        const { transport, finish, audio, kinds, live } = await toolRunning();
        const ended: string[] = [];
        transport.on('response.cancelled', (_e: unknown, meta: { kind: string }) => ended.push(meta.kind));
        transport.requestResponse(holdLine); // the provider drops it without a word
        server({ type: 'input_audio_buffer.speech_started' });
        server({ type: 'input_audio_buffer.speech_stopped' });
        server({ type: 'response.created', response: { id: 'resp_reply' } });
        server(delta(7));
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS + RESPONSE_CANCEL_TIMEOUT_MS);
        server(delta(8));
        server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
        expect(ended).toEqual([]);
        expect(audio).toEqual([7, 8]);
        expect(sent().filter((e) => e.type === 'response.cancel')).toHaveLength(1); // only the dropped hold line's fence
        expect(creates()).toHaveLength(1);
        await finish(); // after the reply: withheld, then voiced once on its own
        expect(creates()).toHaveLength(2);
        expect(creates()[1].response).toBeUndefined();
        server({ type: 'response.created', response: { id: 'resp_voiced' } });
        server({ type: 'response.done', response: { id: 'resp_voiced', status: 'completed' } });
        await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
        expect(creates()).toHaveLength(2);
        expect(kinds).toEqual(['server', 'server', 'withheld_result']);
        expect(live).toEqual({ now: 0, max: 1 });
        await expectQuietAfterClose(transport);
      });

      describe('a hold line dropped at speech_started, created only after speech_stopped (stand-in P3, order 3)', () => {
        /** The result is queued behind the hold-line create; the caller talks briefly; the hold line is created late and our fence cancels it. */
        async function lateHoldLineCancelledByFence() {
          const t = await toolRunning();
          t.transport.requestResponse(holdLine);
          await t.finish(); // queued behind the pending hold line
          expect(creates()).toHaveLength(1);
          server({ type: 'input_audio_buffer.speech_started' }); // a short "uh-huh"
          expect(sentTypes().at(-1)).toBe('response.cancel'); // the dropped hold line's fence
          server({ type: 'input_audio_buffer.speech_stopped' });
          await vi.advanceTimersByTimeAsync(300);
          server({ type: 'response.created', response: { id: 'resp_hold' } }); // the slow hold line, finally
          server({ type: 'response.done', response: { id: 'resp_hold', status: 'cancelled' } }); // the fence lands on it
          expect(creates()).toHaveLength(1); // the caller's reply is still due: nothing on top of it
          return t;
        }

        it('no reply comes: the result is not taken as carried; voiced once after the reply wait', async () => {
          const t = await lateHoldLineCancelledByFence();
          await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS - 1);
          expect(creates()).toHaveLength(1);
          await vi.advanceTimersByTimeAsync(1);
          expect(creates()).toHaveLength(2);
          expect(creates()[1].response).toBeUndefined();
          server({ type: 'response.created', response: { id: 'resp_voiced' } });
          server(delta(6));
          server({ type: 'response.done', response: { id: 'resp_voiced', status: 'completed' } });
          await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
          expect(creates()).toHaveLength(2);
          expect(t.audio).toEqual([6]);
          expect(t.kinds).toEqual(['server', 'server', 'withheld_result']);
          expect(sent().filter((e) => e.type === 'response.cancel')).toHaveLength(1);
          expect(t.live).toEqual({ now: 0, max: 1 });
          await expectQuietAfterClose(t.transport);
        });

        it('the caller\'s reply comes: it carries the result, nothing more is sent', async () => {
          const t = await lateHoldLineCancelledByFence();
          await vi.advanceTimersByTimeAsync(400);
          server({ type: 'response.created', response: { id: 'resp_reply' } });
          server(delta(6));
          server({ type: 'response.done', response: { id: 'resp_reply', status: 'completed' } });
          await vi.advanceTimersByTimeAsync(RESPONSE_CREATED_TIMEOUT_MS * 4);
          expect(creates()).toHaveLength(1);
          expect(t.audio).toEqual([6]);
          expect(t.live).toEqual({ now: 0, max: 1 });
          await expectQuietAfterClose(t.transport);
        });

        it('a real reply the caller barges into is not mistaken for the late hold line', async () => {
          const t = await toolRunning();
          t.transport.requestResponse(holdLine); // the provider drops it
          server({ type: 'input_audio_buffer.speech_started' });
          server({ type: 'input_audio_buffer.speech_stopped' });
          await t.finish(); // withheld (the caller spoke over the asking turn)
          server({ type: 'response.created', response: { id: 'resp_reply' } }); // created after the output: carries it
          server(delta(6));
          server({ type: 'input_audio_buffer.speech_started' }); // barge-in
          server({ type: 'response.done', response: { id: 'resp_reply', status: 'cancelled' } });
          server({ type: 'input_audio_buffer.speech_stopped' });
          await vi.advanceTimersByTimeAsync(CALLER_REPLY_WAIT_MS + RESPONSE_CREATED_TIMEOUT_MS * 4);
          // Not re-voiced: the result was carried by the reply (as before this fix).
          expect(creates()).toHaveLength(1);
          await expectQuietAfterClose(t.transport);
        });
      });

      it('its transcript is flagged (not an answer), and a function call from it is ignored', async () => {
        const onFunctionCall = vi.fn(async () => '{}');
        const transport = makeTransport(onFunctionCall);
        await transport.connect({ apiKey: 'xai-test' });
        const items: Array<Record<string, unknown>> = [];
        transport.on('history_added', (item: Record<string, unknown>) => items.push(item));
        transport.requestResponse(holdLine);
        server({ type: 'response.created', response: { id: 'resp_hold' } });
        server({ type: 'response.function_call_arguments.done', call_id: 'c9', name: 'book', arguments: '{}' });
        server({ type: 'response.output_audio_transcript.done', transcript: 'One moment while I check that.' });
        server({ type: 'response.done', response: { id: 'resp_hold', status: 'completed' } });
        server({ type: 'response.created', response: { id: 'resp_next' } });
        server({ type: 'response.output_audio_transcript.done', transcript: 'Dee is free at nine.' });
        await flush();
        expect(onFunctionCall).not.toHaveBeenCalled();
        expect(items.map((i) => i.holdLine ?? false)).toEqual([true, false]);
      });
    });

    it('timing marks: one tool_timing line per call, with the hold line and the first audio after the result', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { transport, finish, timings } = await toolRunning();
      await vi.advanceTimersByTimeAsync(800);
      transport.requestResponse(holdLine);
      transport.noteHoldLineRequested();
      server({ type: 'response.created', response: { id: 'resp_hold' } });
      server(delta(1));
      await vi.advanceTimersByTimeAsync(1_200);
      server({ type: 'response.done', response: { id: 'resp_hold', status: 'completed' } });
      await finish();
      server({ type: 'response.created', response: { id: 'resp_answer' } });
      await vi.advanceTimersByTimeAsync(300);
      expect(timings).toEqual([]);
      server(delta(2));
      expect(timings).toEqual([{
        tool: 'check_availability',
        tool_call_received_ms: 0,
        action_ms: 2_000,
        result_sent_ms: 2_000,
        first_agent_audio_after_result_ms: 300,
        hold_line_ms: 800,
        voiced: 'now',
      }]);
    });
  });

  it('drops caller audio quietly before the socket opens and after it closes', async () => {
    const transport = makeTransport(async () => '{}');
    expect(() => transport.sendAudio(new ArrayBuffer(160))).not.toThrow();
    await transport.connect({ apiKey: 'xai-test' });
    transport.sendAudio(new ArrayBuffer(160));
    const appends = () => sockets[0].sent.filter((row) => JSON.parse(row).type === 'input_audio_buffer.append');
    expect(appends()).toHaveLength(1);
    transport.close();
    expect(() => transport.sendAudio(new ArrayBuffer(160))).not.toThrow();
    expect(appends()).toHaveLength(1);
  });
});
