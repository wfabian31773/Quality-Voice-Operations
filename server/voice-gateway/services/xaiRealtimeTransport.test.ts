import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sockets: FakeSocket[] = [];

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

import { XaiRealtimeTransport } from './xaiRealtimeTransport';
import { buildXaiSessionUpdate } from '../../../platform/agent-runtime/xaiSessionConfig';

describe('XaiRealtimeTransport', () => {
  beforeEach(() => {
    sockets.length = 0;
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
      await vi.waitFor(() => expect(sentTypes()).toContain('response.create'));
      expect(sentTypes().filter((t) => t === 'conversation.item.create')).toHaveLength(1);
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
