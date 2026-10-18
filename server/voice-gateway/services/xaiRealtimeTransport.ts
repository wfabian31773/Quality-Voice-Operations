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

/**
 * After the caller's speech_stopped, how long the provider's server VAD has
 * to create its reply to that turn before the speech counts as noise (a
 * cough, line noise, echo: no caller turn). A withheld tool result waits
 * this long at most for a caller reply that could carry it, then is voiced
 * on its own. Realtime replies are created within a few hundred ms of
 * speech_stopped (the silence was already waited out); 1.5 s leaves room for
 * a slow provider without a reply colliding with ours, and is still far
 * inside the 15 s heard-caller check.
 */
export const CALLER_REPLY_WAIT_MS = 1_500;

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
  private droppedAudioFrames = 0;
  /** Server-VAD speech_started events so far (caller utterances). */
  private callerSpeechSeq = 0;
  /** callerSpeechSeq when the current response was created. */
  private responseSpeechSeq = 0;
  /** The caller spoke over the current response: drop its remaining audio until the next one. */
  private droppingInterruptedAudio = false;
  /** Audio deltas dropped since the drop started (logged once when it ends). */
  private droppedInterruptedDeltas = 0;
  /** Server VAD: speech_started and no speech_stopped yet. */
  private callerSpeaking = false;
  /** speech_stopped, and the reply to that turn not created yet (at most CALLER_REPLY_WAIT_MS). */
  private callerReplyPending = false;
  private callerReplyTimer: ReturnType<typeof setTimeout> | null = null;
  /** response.created (or our response.create) and no response.done yet. */
  private responseInFlight = false;
  /** Our response.create for a withheld result, until its response.created. */
  private voicingRequested = false;
  /** function_call_output items sent so far. */
  private outputSeq = 0;
  /** outputSeq of the latest output sent without a response.create. */
  private withheldOutputSeq = 0;
  /** Outputs a response has been created after (it can use them), or that we voiced. */
  private seenOutputSeq = 0;
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
        this.clearCallerReplyTimer();
        this.emit('close');
      });
    });
    return this.connectPromise;
  }

  sendAudio(audio: ArrayBuffer): void {
    // Twilio starts streaming caller audio before the xAI socket is open,
    // and keeps going for a moment after it closes. Those frames predate the
    // greeting or follow the hangup, so drop them quietly instead of
    // throwing (which logged "Failed to send audio to xAI" at every call start).
    if (!this.isOpen()) {
      if (this.droppedAudioFrames === 0) {
        logger.debug('Dropping caller audio while the xAI socket is not open', { closed: this.closed });
      }
      this.droppedAudioFrames += 1;
      return;
    }
    const audioB64 = Buffer.from(audio).toString('base64');
    this.sendEvent({ type: 'input_audio_buffer.append', audio: audioB64 });
  }

  sendEvent(event: Record<string, unknown>): void {
    if (!this.isOpen()) {
      throw new Error('WebSocket is not connected');
    }
    this.ws!.send(JSON.stringify(event));
  }

  private isOpen(): boolean {
    return !this.closed && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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
    this.clearCallerReplyTimer();
    this.endInterruptedAudioDrop();
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

    if (type === 'response.created') {
      this.endInterruptedAudioDrop();
      this.responseSpeechSeq = this.callerSpeechSeq;
      this.responseInFlight = true;
      this.callerReplyPending = false;
      this.clearCallerReplyTimer();
      // Every output sent so far is in the conversation this response sees,
      // except after our own response.create (it saw those up to the request).
      if (this.voicingRequested) this.voicingRequested = false;
      else this.seenOutputSeq = this.outputSeq;
      this.emit('response.created', event);
    }
    if (type === 'response.done') this.emit('response.done', event);
    if (type === 'response.cancelled' || type === 'response.canceled') this.emit('response.cancelled', event);
    if (type === 'response.done' || type === 'response.cancelled' || type === 'response.canceled') {
      this.responseInFlight = false;
      this.voiceWithheldResult();
    }
    if (type === 'input_audio_buffer.speech_started') {
      this.callerSpeechSeq += 1;
      this.callerSpeaking = true;
      this.callerReplyPending = false;
      this.clearCallerReplyTimer();
      this.dropInterruptedAudio();
    }
    if (type === 'input_audio_buffer.speech_stopped' && !this.closed) {
      this.callerSpeaking = false;
      this.callerReplyPending = true;
      this.clearCallerReplyTimer();
      this.callerReplyTimer = setTimeout(() => {
        this.callerReplyTimer = null;
        // No reply to that speech: noise, not a caller turn.
        this.callerReplyPending = false;
        this.voiceWithheldResult();
      }, CALLER_REPLY_WAIT_MS);
    }
    // Server VAD: the caller is mid-utterance (the silence watchdog pauses).
    if (type === 'input_audio_buffer.speech_started' || type === 'input_audio_buffer.speech_stopped') this.emit(type, event);

    if (type === 'response.output_audio.delta' || type === 'response.audio.delta' || type === 'response.output_audio_transcript.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (type !== 'response.output_audio_transcript.delta' && delta) {
        if (this.droppingInterruptedAudio) {
          this.droppedInterruptedDeltas += 1;
        } else {
          const data = Buffer.from(delta, 'base64');
          this.emit('audio', { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) } satisfies TransportLayerAudio);
        }
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
      this.completeFunctionCall(callId, name, argumentText, this.responseSpeechSeq).catch((err) => {
        logger.error('xAI function call failed', { tool: name, error: String(err) });
      });
    }
  }

  /**
   * Barge-in: the caller started speaking. With interrupt_response the
   * provider cancels the response, but deltas it already produced can still
   * arrive; drop them, so nothing of the interrupted turn is queued on Twilio
   * after its `clear`. The next response.created ends the drop.
   * (`conversation.item.truncate` to the played length is not sent: xAI's
   * realtime API does not document it.)
   */
  private dropInterruptedAudio(): void {
    this.droppingInterruptedAudio = true;
  }

  /**
   * One log line per drop with what it dropped, so a provider that did not
   * cancel the response on speech_started (the rest of it silently lost, no
   * Twilio `clear`) shows up on real calls. Counts only, no audio.
   */
  private endInterruptedAudioDrop(): void {
    if (this.droppedInterruptedDeltas > 0) {
      logger.info('Dropped interrupted response audio after caller speech_started', { deltas: this.droppedInterruptedDeltas });
    }
    this.droppingInterruptedAudio = false;
    this.droppedInterruptedDeltas = 0;
  }

  private clearCallerReplyTimer(): void {
    if (this.callerReplyTimer !== null) clearTimeout(this.callerReplyTimer);
    this.callerReplyTimer = null;
  }

  /** The caller started an utterance after the given point (a callerSpeechSeq). */
  private callerSpokeSince(speechSeq: number): boolean {
    return this.callerSpeechSeq !== speechSeq;
  }

  /**
   * Voices a withheld tool result that no response has been created after:
   * the caller's reply was already under way without it (a backchannel
   * "thanks" during a slow write), or their speech got no reply at all
   * (noise). Waits while that would double-answer: the caller is speaking,
   * the reply to their turn is in flight or due (CALLER_REPLY_WAIT_MS), or
   * any response is in flight. One response.create covers every output
   * withheld so far; nothing after hangup.
   */
  private voiceWithheldResult(): void {
    if (this.withheldOutputSeq <= this.seenOutputSeq) return;
    if (this.callerSpeaking || this.callerReplyPending || this.responseInFlight || !this.isOpen()) return;
    this.seenOutputSeq = this.withheldOutputSeq;
    this.responseInFlight = true;
    this.voicingRequested = true;
    logger.info('Voicing a withheld tool result: no caller reply carried it');
    this.sendEvent({ type: 'response.create' });
  }

  /**
   * Runs the tool and hands its output to the model. The output starts a
   * response of its own at once only if the caller has not spoken since the
   * turn that asked for it was created. Once they talk over that turn, the
   * answer to them comes from their own turn (server VAD), which can use the
   * output item: two answers, a stale one then the real one, is the barge-in
   * race (plan F10, S12). If no response is created after the item (the
   * caller's reply had already started, or their speech was noise), it is
   * voiced once things are quiet (voiceWithheldResult), so a write is never
   * left unspoken. The tool handler (invariants, floor bookkeeping) runs
   * either way.
   */
  private async completeFunctionCall(
    callId: string,
    name: string,
    argumentText: string,
    askedAtSpeechSeq = this.callerSpeechSeq,
  ): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = argumentText ? JSON.parse(argumentText) as Record<string, unknown> : {};
    } catch {
      args = {};
    }
    const output = await this.onFunctionCall(name, args);
    // The caller can hang up while a tool runs (Oct 17: record_call_outcome
    // finished after hangup and the send became a critical unhandled
    // rejection). Nobody is left to hear the result, so drop it.
    if (!this.isOpen()) {
      logger.info('Dropping tool result: xAI socket closed before it was sent', { tool: name });
      return;
    }
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
    this.outputSeq += 1;
    if (this.callerSpokeSince(askedAtSpeechSeq)) {
      logger.info('Tool result added without a response: the caller spoke over the turn that asked for it', { tool: name });
      this.withheldOutputSeq = this.outputSeq;
      this.voiceWithheldResult();
      return;
    }
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
