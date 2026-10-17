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
