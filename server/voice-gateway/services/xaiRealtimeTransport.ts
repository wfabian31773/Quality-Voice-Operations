import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { createLogger } from '../../../platform/core/logger';
import {
  MASTER_VOICE_AGENT_CONTRACT,
  MASTER_VOICE_AGENT_MODEL,
} from '../../../platform/agent-runtime/masterVoiceAgent';
import {
  buildXaiRealtimeUrl,
  type XaiSessionUpdate,
} from '../../../platform/agent-runtime/xaiSessionConfig';

const logger = createLogger('XAI_REALTIME');

export interface TransportLayerAudio {
  data: ArrayBuffer;
}

export interface XaiRealtimeTransportOptions {
  sessionUpdate: XaiSessionUpdate;
  model?: string;
  onFunctionCall: (name: string, args: Record<string, unknown>) => Promise<string>;
}

interface FunctionCallState {
  name: string;
  callId: string;
  arguments: string;
}

export class XaiRealtimeTransport extends EventEmitter {
  private ws: WebSocket | null = null;
  private closed = false;
  private pendingCalls = new Map<string, FunctionCallState>();
  private connectPromise: Promise<void> | null = null;
  private readonly model: string;
  private sessionUpdate: XaiSessionUpdate;
  private onFunctionCall: XaiRealtimeTransportOptions['onFunctionCall'];

  constructor(opts: XaiRealtimeTransportOptions) {
    super();
    this.model = opts.model ?? MASTER_VOICE_AGENT_MODEL;
    this.sessionUpdate = opts.sessionUpdate;
    this.onFunctionCall = opts.onFunctionCall;
  }

  async connect(input: { apiKey: string }): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = buildXaiRealtimeUrl(this.model);
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${input.apiKey}` },
      });

      this.ws.on('open', () => {
        this.sendEvent({ type: 'session.update', session: this.sessionUpdate });
        this.emit('session.created', { type: 'session.created' });
        resolve();
      });

      this.ws.on('message', (raw) => {
        this.handleMessage(raw.toString());
      });

      this.ws.on('error', (err) => {
        logger.error('xAI realtime socket error', { error: String(err) });
        if (!this.closed) reject(err);
      });

      this.ws.on('close', () => {
        this.closed = true;
        this.emit('close');
      });
    });
    return this.connectPromise;
  }

  sendAudio(audio: ArrayBuffer): void {
    const audioB64 = Buffer.from(audio).toString('base64');
    this.sendEvent({ type: 'input_audio_buffer.append', audio: audioB64 });
  }

  sendEvent(event: Record<string, unknown>): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(event));
  }

  updateSession(session: XaiSessionUpdate): void {
    this.sessionUpdate = session;
    this.sendEvent({ type: 'session.update', session });
  }

  setFunctionHandler(handler: XaiRealtimeTransportOptions['onFunctionCall']): void {
    this.onFunctionCall = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // already closing
    }
    this.emit('close');
  }

  private handleMessage(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(event.type ?? '');

    if (type === 'response.created') this.emit('response.created', event);
    if (type === 'response.done') this.emit('response.done', event);
    if (type === 'response.cancelled' || type === 'response.canceled') this.emit('response.cancelled', event);

    if (type === 'response.output_audio.delta' || type === 'response.audio.delta' || type === 'response.output_audio_transcript.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (type !== 'response.output_audio_transcript.delta' && delta) {
        const data = Buffer.from(delta, 'base64');
        this.emit('audio', { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) } satisfies TransportLayerAudio);
      }
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String((event.transcript as string | undefined) ?? '');
      if (transcript) {
        this.emit('history_added', {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', transcript, text: transcript }],
        });
      }
    }

    if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
      const transcript = String((event.transcript as string | undefined) ?? '');
      if (transcript) {
        this.emit('history_added', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', transcript, text: transcript }],
        });
      }
    }

    if (type === 'response.function_call_arguments.delta') {
      const callId = String(event.call_id ?? event.item_id ?? '');
      const name = String(event.name ?? this.pendingCalls.get(callId)?.name ?? '');
      const prev = this.pendingCalls.get(callId) ?? { name, callId, arguments: '' };
      prev.arguments += String(event.delta ?? '');
      if (name) prev.name = name;
      this.pendingCalls.set(callId, prev);
    }

    if (type === 'response.function_call_arguments.done') {
      const callId = String(event.call_id ?? event.item_id ?? '');
      const name = String(event.name ?? this.pendingCalls.get(callId)?.name ?? '');
      const argumentText = String(event.arguments ?? this.pendingCalls.get(callId)?.arguments ?? '{}');
      this.pendingCalls.delete(callId);
      void this.completeFunctionCall(callId, name, argumentText);
    }
  }

  private async completeFunctionCall(callId: string, name: string, argumentText: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = argumentText ? JSON.parse(argumentText) as Record<string, unknown> : {};
    } catch {
      args = {};
    }
    const output = await this.onFunctionCall(name, args);
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
    this.sendEvent({ type: 'response.create' });
  }
}

export class XaiVoiceSession {
  constructor(private readonly transport: XaiRealtimeTransport) {}

  connect(input: { apiKey: string }): Promise<void> {
    return this.transport.connect(input);
  }

  close(): void {
    this.transport.close();
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.transport.on(event, listener);
    return this;
  }

  updateSession(session: XaiSessionUpdate): void {
    this.transport.updateSession(session);
  }

  setFunctionHandler(handler: XaiRealtimeTransportOptions['onFunctionCall']): void {
    this.transport.setFunctionHandler(handler);
  }

  get provider(): typeof MASTER_VOICE_AGENT_CONTRACT.provider {
    return MASTER_VOICE_AGENT_CONTRACT.provider;
  }
}
