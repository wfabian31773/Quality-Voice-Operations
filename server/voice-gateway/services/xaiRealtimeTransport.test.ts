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
});
