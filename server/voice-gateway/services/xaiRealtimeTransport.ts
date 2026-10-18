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

/**
 * How long our response.create waits for its response.created (or an error
 * that rejects it) before it counts as lost: a rejection we could not
 * recognise, or a create the provider dropped without a word. It is then
 * recovered like a rejection, so the one create path never stalls behind it.
 * Realtime responses are created within a few hundred ms; 3 s is far past a
 * slow provider and still well inside the 15 s heard-caller check.
 */
export const RESPONSE_CREATED_TIMEOUT_MS = 3_000;

/**
 * How long a response.cancel we sent waits for the response's done/cancelled
 * (or, with nothing in flight, for the provider's "nothing to cancel" error)
 * before the response counts as ended. A cancel lands in a few hundred ms.
 */
export const RESPONSE_CANCEL_TIMEOUT_MS = 2_000;

export interface TransportLayerAudio {
  data: ArrayBuffer;
}

export interface XaiRealtimeTransportOptions {
  sessionUpdate: XaiSessionUpdate;
  model?: string;
  onFunctionCall: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/**
 * Who asked for a response:
 * - tool_result: a tool output's own response (the normal tool path);
 * - withheld_result: a tool output no caller reply carried (voiceWithheldResult);
 * - instruction: a runtime instruction (greeting, silence ladder, handoff, reasoning);
 * - caller_text: typed widget text;
 * - hold_line: "one moment while I check that" during a slow tool.
 * A response the provider starts itself (server VAD) is 'server'.
 */
export type ResponseRequestKind = 'tool_result' | 'withheld_result' | 'instruction' | 'caller_text' | 'hold_line';
export type ResponseKind = ResponseRequestKind | 'server';

export interface ResponseRequest {
  kind: ResponseRequestKind;
  /** The response.create `response` object (one-response instructions). */
  response?: Record<string, unknown>;
  /**
   * Cancel the provider's response in flight first, then create this one
   * (sendModelInstruction: a reasoning instruction replaces the auto-reply).
   * Without it the request waits for the in-flight response to finish.
   */
  cancelInFlight?: boolean;
  /**
   * Start now or not at all: refused (false) while a response is in flight,
   * requested, queued or due (the caller is speaking, or their reply or a
   * withheld result is about to be created).
   */
  onlyIfIdle?: boolean;
}

/** response.created / response.done listeners get this as their second argument. */
export interface ResponseMeta {
  kind: ResponseKind;
}

/**
 * One structured line per tool call (RT-HOLD-LINE timing marks), no PII.
 * Times in ms; *_ms durations are from the tool call's arrival.
 */
export interface ToolTiming {
  tool: string;
  /** When the model's function call arrived, since the socket opened. */
  tool_call_received_ms: number;
  /** Tool handler time: the runtime's bookkeeping writes plus the action itself. */
  action_ms: number;
  /** Arrival to the function_call_output sent to the model. */
  result_sent_ms: number;
  /**
   * Result sent to the first agent audio (toward Twilio) of a response
   * started after it. null: none before the next tool call or the hangup.
   */
  first_agent_audio_after_result_ms: number | null;
  /** Arrival to the hold line's request, if this call got one. */
  hold_line_ms: number | null;
  /** How the output went back: its own response, queued behind one, or withheld (the caller spoke). */
  voiced: 'now' | 'queued' | 'withheld' | 'dropped';
}

interface FunctionCallState {
  name: string;
  callId: string;
  arguments: string;
}

interface QueuedRequest {
  request: ResponseRequest;
  /** outputSeq when it was asked for (a tool_result covers the outputs up to it). */
  outputSeq: number;
  /** callerSpeechSeq of the turn that asked for the tool (tool_result only). */
  askedAtSpeechSeq: number;
  /** Re-sent once after a provider rejection. */
  retried: boolean;
}

interface PendingCreate extends QueuedRequest {
  /** callerSpeechSeq when it was sent. */
  sentAtSpeechSeq: number;
  /** outputSeq when it was sent: its response sees those outputs, never one sent after it. */
  sentAtOutputSeq: number;
  /** seenOutputSeq before a withheld_result moved it (restored if the create is rejected). */
  seenBefore: number;
  /** Cancel it as soon as it is created (superseded before it existed). */
  cancelOnCreated: boolean;
}

interface CurrentResponse {
  kind: ResponseKind;
  audioSeen: boolean;
  /** The provider's response id, when it gives one. */
  id?: string;
  /**
   * A 'server' response created while a lost hold line's fence cancel was
   * out: the caller's reply, or that hold line created only now. seenOutputSeq
   * before it, restored if the fence turns out to cancel it.
   */
  maybeLateHoldLineSeenBefore?: number;
  /**
   * Cancelled as it was created (superseded before it existed, or a lost
   * create turning up late): never heard, so its transcript and function
   * calls are ignored until it ends (Codex 4308886261).
   */
  retired?: boolean;
  /** Its ignored events were logged (once per response). */
  retiredLogged?: boolean;
}

interface ToolTimingState {
  tool: string;
  receivedAt: number;
  handlerDoneAt?: number;
  resultSentAt?: number;
  holdLineAt?: number;
  voiced?: ToolTiming['voiced'];
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
  /** response.created and no response.done yet. */
  private responseInFlight = false;
  /** Our response.create sent and not created (or rejected) yet. One at a time. */
  private pendingCreate: PendingCreate | null = null;
  /** pendingCreate's RESPONSE_CREATED_TIMEOUT_MS. */
  private createTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Our last create that got no response.created in time. A response.created
   * that still turns up for it (the provider was only slow) meets the cancel
   * sent at the timeout: it is retired silently, not claimed as anything else.
   */
  private lostCreate: PendingCreate | null = null;
  /** A cancel we sent is waiting to land (RESPONSE_CANCEL_TIMEOUT_MS); no create goes meanwhile. */
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  /** What that cancel is aimed at: the response then in flight, or null for a lost create (until its late response turns up). */
  private cancelTarget: CurrentResponse | null = null;
  /** Responses we stopped waiting for (cancel never landed): their late done/cancelled is ignored. */
  private abandonedResponseIds = new Set<string>();
  private abandonedWithoutId = 0;
  /**
   * Of those, the ones retired at creation: their late transcript and function
   * calls stay ignored (stand-in P3 b), by response_id until their end, and
   * without one until the next response.created (a real reply starts with one).
   */
  private abandonedRetiredIds = new Set<string>();
  private abandonedRetiredUntilCreated = false;
  /** Requests waiting for the response in flight (or requested) to finish. */
  private responseQueue: QueuedRequest[] = [];
  /** The response in flight: who asked for it, and whether its audio started. */
  private current: CurrentResponse | null = null;
  /** function_call_output items sent so far. */
  private outputSeq = 0;
  /** outputSeq of the latest output sent without a response.create. */
  private withheldOutputSeq = 0;
  /** Outputs a response has been created after (it can use them), or that we voiced. */
  private seenOutputSeq = 0;
  /** withheldOutputSeq whose voicing the provider rejected once already (it is re-voiced once, not in a loop). */
  private voicingRejectedSeq = 0;
  /** Tool handlers still running (concurrent calls in one response): a silent hold line stays while any is. */
  private toolCallsRunning = 0;
  /** Tool calls by call id, from arrival until their timing line is logged. */
  private toolTimings = new Map<string, ToolTimingState>();
  private openedAt = 0;
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
        this.openedAt = Date.now();
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
        this.clearAckTimers();
        this.responseQueue = [];
        this.flushToolTimings();
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
    this.clearAckTimers();
    this.endInterruptedAudioDrop();
    this.responseQueue = [];
    this.flushToolTimings();
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

    if (type === 'error') {
      this.handleProviderError(event);
      return;
    }

    if (type === 'response.created') {
      this.endInterruptedAudioDrop();
      this.abandonedRetiredUntilCreated = false;
      const replyWasDue = this.callerSpeaking || this.callerReplyPending;
      this.responseSpeechSeq = this.callerSpeechSeq;
      this.responseInFlight = true;
      this.callerReplyPending = false;
      this.clearCallerReplyTimer();
      // Our pending create, or one the provider started itself (server VAD).
      const ours = this.pendingCreate;
      this.clearPendingCreate();
      // Our lost create turning up late: the caller is mid-utterance (server
      // VAD replies only after it) or has not spoken since it was sent.
      // Otherwise this is the provider's reply to them: 'server'.
      const lost = this.lostCreate;
      this.lostCreate = null;
      const late = !ours && lost !== null && (this.callerSpeaking || (!replyWasDue && !this.callerSpokeSince(lost.sentAtSpeechSeq))) ? lost : null;
      const kind: ResponseKind = ours?.request.kind ?? late?.request.kind ?? 'server';
      const retired = Boolean(ours?.cancelOnCreated) || late !== null;
      const responseId = responseIdOf(event);
      this.current = { kind, audioSeen: false, ...(retired ? { retired } : {}), ...(responseId ? { id: responseId } : {}) };
      if (lost && this.cancelTimer !== null && this.cancelTarget === null) {
        // The lost create's cancel is aimed at its late response; the caller's reply ends that wait, untouched by it.
        if (late) this.cancelTarget = this.current;
        else if (kind === 'server') {
          // A hold line dropped at speech_started and created only after
          // speech_stopped looks just like the reply here (stand-in P3):
          // heard as the reply unless the fence cancels it (see its end).
          if (lost.request.kind === 'hold_line') this.current.maybeLateHoldLineSeenBefore = this.seenOutputSeq;
          this.clearCancelWait();
        }
      }
      // Every output sent so far is in the conversation this response sees,
      // except after our voicing of a withheld result (it saw those up to the
      // request) and the hold line (told to say its line and nothing else, so
      // it carries no output). A response we cancel at once carries nothing.
      // Ours sees only the outputs sent before its response.create: one sent
      // after it (a concurrent tool) keeps its own queued reply (Codex 4308809826).
      if (!retired && kind !== 'hold_line' && kind !== 'withheld_result') {
        this.seenOutputSeq = ours ? Math.max(this.seenOutputSeq, ours.sentAtOutputSeq) : this.outputSeq;
      }
      this.emit('response.created', event, { kind } satisfies ResponseMeta);
      if (ours?.cancelOnCreated) {
        this.cancelCurrentResponse();
      } else if (late) {
        // The cancel sent at its timeout is already behind it on the socket: silent until it lands.
        logger.info('A lost response.create was created late: cancelled, its audio dropped', { kind });
        this.dropInterruptedAudio();
      }
    }
    if (type === 'response.done' || type === 'response.cancelled' || type === 'response.canceled') {
      if (this.isAbandonedResponseEnd(event)) {
        // Already treated as ended; a create the provider refused meanwhile can go now.
        this.drainResponseQueue();
        this.voiceWithheldResult();
        return;
      }
      const meta: ResponseMeta = { kind: this.current?.kind ?? 'server' };
      const seenBefore = this.current?.maybeLateHoldLineSeenBefore;
      if (seenBefore !== undefined && isCancelledEnd(type, event) && !this.callerSpokeSince(this.responseSpeechSeq) && !this.closed) {
        // Our fence cancelled it (no barge-in did): it was the dropped hold
        // line, late. It carried no output, and the caller's reply is still due.
        logger.info('A dropped hold line was created late and cancelled by its fence: the caller\'s reply is still due');
        this.seenOutputSeq = Math.min(this.seenOutputSeq, seenBefore);
        this.startCallerReplyWait();
      }
      this.responseInFlight = false;
      this.current = null;
      // Whatever we cancelled has ended (or the lost create's cancel found it gone).
      this.clearCancelWait();
      this.lostCreate = null;
      if (type === 'response.done') this.emit('response.done', event, meta);
      else this.emit('response.cancelled', event, meta);
      this.drainResponseQueue();
      this.voiceWithheldResult();
    }
    if (type === 'input_audio_buffer.speech_started') {
      this.callerSpeechSeq += 1;
      this.callerSpeaking = true;
      this.callerReplyPending = false;
      this.clearCallerReplyTimer();
      this.dropInterruptedAudio();
      // A hold line asked for and not created yet would start over the caller:
      // dropped, so the provider's reply to them is never taken for it. If it
      // is created anyway, its fence retires it unheard.
      const holdLine = this.pendingCreate?.request.kind === 'hold_line' ? this.pendingCreate : null;
      if (holdLine) {
        this.clearPendingCreate();
        this.giveUpCreate(holdLine);
      }
    }
    if (type === 'input_audio_buffer.speech_stopped' && !this.closed) {
      this.callerSpeaking = false;
      this.startCallerReplyWait();
    }
    // Server VAD: the caller is mid-utterance (the silence watchdog pauses).
    if (type === 'input_audio_buffer.speech_started' || type === 'input_audio_buffer.speech_stopped') this.emit(type, event);

    if (type === 'response.output_audio.delta' || type === 'response.audio.delta' || type === 'response.output_audio_transcript.delta') {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (type !== 'response.output_audio_transcript.delta' && delta) {
        if (this.droppingInterruptedAudio) {
          this.droppedInterruptedDeltas += 1;
        } else {
          if (this.current && !this.current.audioSeen) {
            this.current.audioSeen = true;
            this.emit('response.audio_started', { kind: this.current.kind } satisfies ResponseMeta);
            if (this.current.kind !== 'hold_line') this.noteFirstAgentAudio();
          }
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
      if (transcript && !this.ignoredFromRetired(event)) {
        this.emit('history_added', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', transcript, text: transcript }],
          // The runtime's hold line: not an answer (no "agent spoke" for the invariants).
          ...(this.current?.kind === 'hold_line' ? { holdLine: true } : {}),
        });
      }
    }

    if (type === 'response.function_call_arguments.delta' && !this.current?.retired && !this.fromAbandonedRetired(event)) {
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
      // Never heard: no tool runs, no output, nothing counted.
      if (this.ignoredFromRetired(event)) return;
      if (this.current?.kind === 'hold_line') {
        // Told to say its line and nothing else: the hold line never runs a tool.
        logger.warn('Ignoring a function call from the hold line response', { tool: name });
        return;
      }
      this.completeFunctionCall(callId, name, argumentText, this.responseSpeechSeq).catch((err) => {
        logger.error('xAI function call failed', { tool: name, error: String(err) });
      });
    }
  }

  /** The response in flight was retired at creation: its event is ignored (logged once per response, kind only). */
  private ignoredFromRetired(event: Record<string, unknown>): boolean {
    if (this.fromAbandonedRetired(event)) return true;
    const current = this.current;
    if (!current?.retired) return false;
    if (!current.retiredLogged) {
      current.retiredLogged = true;
      logger.info('Ignoring transcript and function calls of a response retired at creation', { kind: current.kind });
    }
    return true;
  }

  /** A late event of a retired response abandoned at its cancel timeout: never heard, ignored too. */
  private fromAbandonedRetired(event: Record<string, unknown>): boolean {
    const id = event.response_id;
    if (typeof id === 'string' && this.abandonedRetiredIds.has(id)) return true;
    return this.current === null && this.abandonedRetiredUntilCreated;
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

  /** The reply to the caller's turn is due: CALLER_REPLY_WAIT_MS for the provider to create it. */
  private startCallerReplyWait(): void {
    this.callerReplyPending = true;
    this.clearCallerReplyTimer();
    this.callerReplyTimer = setTimeout(() => {
      this.callerReplyTimer = null;
      // No reply to that speech: noise, not a caller turn.
      this.callerReplyPending = false;
      this.voiceWithheldResult();
    }, CALLER_REPLY_WAIT_MS);
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
    if (this.callerSpeaking || this.callerReplyPending || this.responseBusy() || this.responseQueue.length > 0 || !this.isOpen()) return;
    const seenBefore = this.seenOutputSeq;
    this.seenOutputSeq = this.withheldOutputSeq;
    logger.info('Voicing a withheld tool result: no caller reply carried it');
    const retried = this.voicingRejectedSeq >= this.withheldOutputSeq;
    this.sendCreate({ request: { kind: 'withheld_result' }, outputSeq: this.withheldOutputSeq, askedAtSpeechSeq: this.callerSpeechSeq, retried }, seenBefore);
  }

  /** A response is in flight, ours is requested and not created yet, or a cancel we sent has not landed. */
  private responseBusy(): boolean {
    return this.responseInFlight || this.pendingCreate !== null || this.cancelTimer !== null;
  }

  /**
   * The one way a response.create goes out (P3 #1 of the #133 review): never
   * two in flight, nothing after close. A request made while a response is in
   * flight or requested waits in order behind it and goes at its
   * response.done, unless `cancelInFlight` (the in-flight response is
   * cancelled, then this one is created) or `onlyIfIdle` (refused). Returns
   * false if nothing was sent or queued.
   */
  requestResponse(request: ResponseRequest): boolean {
    if (!this.isOpen()) return false;
    const entry: QueuedRequest = { request, outputSeq: this.outputSeq, askedAtSpeechSeq: this.callerSpeechSeq, retried: false };
    if (request.onlyIfIdle) {
      const due = this.callerSpeaking || this.callerReplyPending || this.withheldOutputSeq > this.seenOutputSeq;
      if (this.responseBusy() || this.responseQueue.length > 0 || due) return false;
      this.sendCreate(entry);
      return true;
    }
    if (request.cancelInFlight) {
      if (this.pendingCreate) {
        // Ours is requested but not created yet: cancel it once it is, then this one.
        this.pendingCreate.cancelOnCreated = true;
        this.responseQueue.unshift(entry);
        return true;
      }
      if (!this.responseInFlight && this.cancelTimer !== null) {
        // A lost create's cancel is still out: this one goes first once it lands.
        this.responseQueue.unshift(entry);
        return true;
      }
      if (this.responseInFlight && this.cancelTimer === null) this.cancelCurrentResponse();
      // On the ordered socket the cancel lands first; this create follows it.
      this.sendCreate(entry);
      return true;
    }
    if (this.responseBusy()) {
      // Typed turns coalesce: a queued reply sees every message added before it goes.
      if (!this.hasQueuedCallerText(request.kind)) this.responseQueue.push(entry);
      return true;
    }
    this.sendCreate(entry);
    return true;
  }

  /**
   * A caller_text reply is already queued, not sent yet (Codex 4308599619):
   * one reply answers all the typed messages before it, never one each. A
   * message after it was sent gets its own (that create could not see it).
   */
  private hasQueuedCallerText(kind: ResponseRequestKind): boolean {
    return kind === 'caller_text' && this.responseQueue.some((queued) => queued.request.kind === 'caller_text');
  }

  /**
   * Sends one response.create. It waits at most RESPONSE_CREATED_TIMEOUT_MS
   * for its response.created (onCreateTimeout).
   */
  private sendCreate(entry: QueuedRequest, seenBefore = this.seenOutputSeq): void {
    this.clearPendingCreate();
    this.pendingCreate = { ...entry, sentAtSpeechSeq: this.callerSpeechSeq, sentAtOutputSeq: this.outputSeq, seenBefore, cancelOnCreated: false };
    this.createTimer = setTimeout(() => this.onCreateTimeout(), RESPONSE_CREATED_TIMEOUT_MS);
    const response = entry.request.response;
    this.sendEvent(response ? { type: 'response.create', response } : { type: 'response.create' });
  }

  private clearPendingCreate(): void {
    if (this.createTimer !== null) clearTimeout(this.createTimer);
    this.createTimer = null;
    this.pendingCreate = null;
  }

  /** Cancels the response in flight (its late audio deltas are dropped, like a barge-in's). */
  private cancelCurrentResponse(): void {
    if (!this.responseInFlight) return;
    this.dropInterruptedAudio();
    this.sendCancel(this.current);
  }

  /**
   * Sends a response.cancel aimed at `target` (null: a lost create) and
   * holds the create path until it lands: the response's done/cancelled, the
   * provider's "nothing to cancel" error when nothing is in flight, or
   * RESPONSE_CANCEL_TIMEOUT_MS (onCancelTimeout).
   */
  private sendCancel(target: CurrentResponse | null): void {
    try {
      this.sendEvent({ type: 'response.cancel' });
    } catch (err) {
      logger.debug('response.cancel failed (likely already closed)', { error: String(err) });
      return;
    }
    this.cancelTarget = target;
    if (this.cancelTimer !== null) clearTimeout(this.cancelTimer);
    this.cancelTimer = setTimeout(() => this.onCancelTimeout(), RESPONSE_CANCEL_TIMEOUT_MS);
  }

  private clearCancelWait(): void {
    if (this.cancelTimer !== null) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
    this.cancelTarget = null;
  }

  private clearAckTimers(): void {
    this.clearPendingCreate();
    this.clearCancelWait();
    this.lostCreate = null;
  }

  /**
   * Our create got neither a response.created nor an error we could tie to
   * it in RESPONSE_CREATED_TIMEOUT_MS: an unrecognised rejection, or dropped.
   * It is recovered like a recognised rejection. A cancel goes out first, so
   * if the provider was only slow, its late response is cancelled as soon as
   * it exists (the socket is ordered) and retired silently; no create goes
   * until that cancel lands, so two responses are never in flight.
   */
  private onCreateTimeout(): void {
    this.createTimer = null;
    const lost = this.pendingCreate;
    if (!lost || this.closed) return;
    this.pendingCreate = null;
    // Kind and counts only.
    logger.warn('xAI response.create got no response.created in time: treated as lost', {
      kind: lost.request.kind,
      waitedMs: RESPONSE_CREATED_TIMEOUT_MS,
      queued: this.responseQueue.length,
      retried: lost.retried,
    });
    this.giveUpCreate(lost);
  }

  /** Our create is given up: fenced by a cancel (a late response.created for it is retired), then recovered. */
  private giveUpCreate(lost: PendingCreate): void {
    this.lostCreate = lost;
    this.sendCancel(null);
    this.recoverRejectedCreate(lost);
  }

  /**
   * A cancel we sent did not land in RESPONSE_CANCEL_TIMEOUT_MS. The
   * response it was aimed at, if still in flight, is treated as ended (its
   * late done/cancelled is ignored, its late deltas dropped until the next
   * response); any other response (the caller's reply, one created after the
   * cancel) is left alone. Then the queue goes on.
   */
  private onCancelTimeout(): void {
    const target = this.cancelTarget;
    this.cancelTimer = null;
    this.cancelTarget = null;
    if (this.closed) return;
    this.lostCreate = null;
    if (this.responseInFlight && target !== null && this.current === target) {
      const meta: ResponseMeta = { kind: this.current?.kind ?? 'server' };
      logger.warn('xAI response.cancel not acknowledged in time: response treated as ended', { kind: meta.kind, waitedMs: RESPONSE_CANCEL_TIMEOUT_MS });
      if (this.current?.id) this.abandonedResponseIds.add(this.current.id);
      else this.abandonedWithoutId += 1;
      if (this.current?.retired) {
        if (this.current.id) this.abandonedRetiredIds.add(this.current.id);
        this.abandonedRetiredUntilCreated = true;
      }
      this.dropInterruptedAudio();
      this.responseInFlight = false;
      this.current = null;
      this.emit('response.cancelled', { type: 'response.cancelled' }, meta);
    }
    this.drainResponseQueue();
    this.voiceWithheldResult();
  }

  /** A done/cancelled for a response we already treated as ended (onCancelTimeout). */
  private isAbandonedResponseEnd(event: Record<string, unknown>): boolean {
    const id = responseIdOf(event);
    if (id && this.abandonedResponseIds.delete(id)) {
      this.abandonedRetiredIds.delete(id);
      return true;
    }
    if (!id && !this.responseInFlight && this.abandonedWithoutId > 0) {
      this.abandonedWithoutId -= 1;
      return true;
    }
    return false;
  }

  /**
   * The next queued request, once nothing is in flight. A tool result a
   * response has been created after since it was queued is already in that
   * response's conversation: skipped. One the caller has since spoken over
   * (e.g. a barge-in on the hold line) starts no response of its own: it is
   * withheld, like any late result (voiceWithheldResult).
   */
  private drainResponseQueue(): void {
    while (!this.responseBusy() && this.responseQueue.length > 0 && this.isOpen()) {
      const entry = this.responseQueue.shift() as QueuedRequest;
      if (entry.request.kind === 'tool_result') {
        if (entry.outputSeq <= this.seenOutputSeq) continue;
        if (this.callerSpokeSince(entry.askedAtSpeechSeq)) {
          logger.info('Queued tool result withheld: the caller spoke since the turn that asked for it');
          this.withheldOutputSeq = Math.max(this.withheldOutputSeq, entry.outputSeq);
          continue;
        }
      }
      this.sendCreate(entry);
    }
  }

  /**
   * A provider `error` event (P3 #2 of the #133 review). Logged with its
   * code/type only (no message text: it can echo conversation content). An
   * error about a "response" (and not a cancel) is taken to reject our
   * pending create. Anything else is only logged: a create it did reject is
   * recovered at RESPONSE_CREATED_TIMEOUT_MS instead. A rejected create is
   * cleared and recovered (recoverRejectedCreate). The "nothing to cancel"
   * answer to a lost create's cancel ends that wait.
   */
  private handleProviderError(event: Record<string, unknown>): void {
    const error = (event.error && typeof event.error === 'object' ? event.error : {}) as Record<string, unknown>;
    const code = typeof error.code === 'string' ? error.code : undefined;
    const errorType = typeof error.type === 'string' ? error.type : undefined;
    const pending = this.pendingCreate;
    const detail = `${code ?? ''} ${String(error.param ?? '')} ${String(error.message ?? '')}`;
    const aboutCancel = /cancel/i.test(detail);
    const rejectsCreate = pending !== null && !aboutCancel && /response/i.test(detail);
    const aboutOurCancel = aboutCancel && this.cancelTimer !== null;
    logger.warn('xAI realtime provider error', { code, type: errorType, pendingCreate: pending?.request.kind, rejectsCreate });
    if (aboutOurCancel && !this.responseInFlight) {
      // Nothing was in flight to cancel: the lost create is gone for good.
      this.clearCancelWait();
      this.lostCreate = null;
      this.drainResponseQueue();
      this.voiceWithheldResult();
    }
    if (!pending || !rejectsCreate) return;
    this.clearPendingCreate();
    this.recoverRejectedCreate(pending);
  }

  /**
   * A create the provider rejected, or one that never got its
   * response.created: later voicing is neither blocked nor counted as
   * carried. A withheld result's voicing is undone (voiced again, once), a
   * tool result, instruction or caller text is re-queued once, a hold line
   * is dropped. A create that fails twice is not sent a third time.
   */
  private recoverRejectedCreate(pending: PendingCreate): void {
    if (pending.request.kind === 'withheld_result') {
      // Voiced again once (a later caller reply can still carry it); never a loop of rejected creates.
      if (!pending.retried) {
        this.seenOutputSeq = Math.min(this.seenOutputSeq, pending.seenBefore);
        this.voicingRejectedSeq = pending.outputSeq;
      }
    } else if (pending.request.kind !== 'hold_line' && !pending.retried && !pending.cancelOnCreated && !this.hasQueuedCallerText(pending.request.kind)) {
      // (One superseded before it existed is not wanted any more: what replaced it is queued.
      // Nor typed text with a later caller_text reply queued: that one answers it.)
      this.responseQueue.unshift({ request: pending.request, outputSeq: pending.outputSeq, askedAtSpeechSeq: pending.askedAtSpeechSeq, retried: true });
    }
    this.emit('response.rejected', { kind: pending.request.kind } satisfies ResponseMeta);
    this.drainResponseQueue();
    this.voiceWithheldResult();
  }

  /**
   * The last running tool's result landed while the hold line has been asked
   * for but has not produced audio yet: cancel it and go straight to the
   * result. (While another tool still runs, the caller is still waiting:
   * completeFunctionCall does not call this, and the result waits behind it.) Once
   * its audio has started it finishes (never cut mid-word); the result's
   * response waits behind it.
   */
  private cancelSilentHoldLine(): void {
    if (this.pendingCreate?.request.kind === 'hold_line') {
      this.pendingCreate.cancelOnCreated = true;
      return;
    }
    if (this.current?.kind === 'hold_line' && !this.current.audioSeen) this.cancelCurrentResponse();
  }

  // ---------------------------------------------------------------- timing marks

  /** The hold line was asked for while these tool calls ran. */
  noteHoldLineRequested(): void {
    const now = Date.now();
    for (const timing of this.toolTimings.values()) {
      if (timing.resultSentAt === undefined && timing.holdLineAt === undefined) timing.holdLineAt = now;
    }
  }

  /** First audio of a response that is not the hold line: closes every result waiting for it. */
  private noteFirstAgentAudio(): void {
    const now = Date.now();
    for (const [callId, timing] of this.toolTimings) {
      if (timing.resultSentAt === undefined) continue;
      this.logToolTiming(callId, timing, now - timing.resultSentAt);
    }
  }

  /** Results still waiting for agent audio when the call ends (or the next tool call arrives). */
  private flushToolTimings(onlySent = false): void {
    for (const [callId, timing] of this.toolTimings) {
      if (onlySent && timing.resultSentAt === undefined) continue;
      this.logToolTiming(callId, timing, null);
    }
  }

  private logToolTiming(callId: string, timing: ToolTimingState, firstAudioMs: number | null): void {
    this.toolTimings.delete(callId);
    const sentAt = timing.resultSentAt ?? timing.handlerDoneAt ?? timing.receivedAt;
    const line: ToolTiming = {
      tool: timing.tool,
      tool_call_received_ms: Math.max(0, timing.receivedAt - this.openedAt),
      action_ms: (timing.handlerDoneAt ?? sentAt) - timing.receivedAt,
      result_sent_ms: sentAt - timing.receivedAt,
      first_agent_audio_after_result_ms: firstAudioMs,
      hold_line_ms: timing.holdLineAt === undefined ? null : timing.holdLineAt - timing.receivedAt,
      voiced: timing.voiced ?? 'dropped',
    };
    this.emit('tool_timing', line);
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
    // A chained call: results still waiting for agent audio got none before it.
    this.flushToolTimings(true);
    const timing: ToolTimingState = { tool: name, receivedAt: Date.now() };
    this.toolTimings.set(callId, timing);
    let output: string;
    this.toolCallsRunning += 1;
    try {
      output = await this.onFunctionCall(name, args);
    } finally {
      this.toolCallsRunning -= 1;
      timing.handlerDoneAt = Date.now();
    }
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
    timing.resultSentAt = Date.now();
    // Another tool still running: the caller still waits, so the hold line stays.
    if (this.toolCallsRunning === 0) this.cancelSilentHoldLine();
    if (this.callerSpokeSince(askedAtSpeechSeq)) {
      logger.info('Tool result added without a response: the caller spoke over the turn that asked for it', { tool: name });
      timing.voiced = 'withheld';
      this.withheldOutputSeq = this.outputSeq;
      this.voiceWithheldResult();
      return;
    }
    // Behind the response in flight (the hold line, the asking turn's own
    // response.done), never on top of it.
    timing.voiced = this.responseBusy() || this.responseQueue.length > 0 ? 'queued' : 'now';
    this.requestResponse({ kind: 'tool_result' });
  }
}

/** A response.cancelled, or a response.done whose status is cancelled. */
function isCancelledEnd(type: string, event: Record<string, unknown>): boolean {
  if (type !== 'response.done') return true;
  const response = event.response;
  return Boolean(response && typeof response === 'object' && (response as Record<string, unknown>).status === 'cancelled');
}

/** The provider's response id on a response.created/done/cancelled event, if any. */
function responseIdOf(event: Record<string, unknown>): string | undefined {
  const response = event.response;
  const id = response && typeof response === 'object' ? (response as Record<string, unknown>).id : undefined;
  return typeof id === 'string' && id ? id : undefined;
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
