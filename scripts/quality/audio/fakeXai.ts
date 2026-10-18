/**
 * Scripted fake of the xAI realtime server, on the far side of the real
 * XaiRealtimeTransport's socket. It speaks the wire events the transport
 * consumes (input_audio_buffer.speech_started / speech_stopped, input
 * transcription completed or not, response.created, response.output_audio
 * .delta, response.output_audio_transcript.done, function calls,
 * response.done) and honours the session's turn_detection the way server
 * VAD does: energy VAD on the caller audio the transport appends, an
 * automatic response at the end of each caller turn (create_response), and
 * a cancelled in-flight response when the caller starts talking
 * (interrupt_response; at once, or after the script's interruptLatencyMs with
 * audio deltas still arriving meanwhile).
 *
 * "The model" is a script: the k-th caller utterance gets the scenario's
 * k-th reply (or a transcript of nothing, for S17). Instructions the runtime
 * sends (greeting, silence prompt, goodbye) are obeyed literally: it says
 * the quoted line. Audio streams 4x faster than real time after 300 ms, like
 * the real model, so Twilio holds a backlog of agent audio.
 */
import { lineDurationMs } from './callerVoice';
import { FRAME_BYTES, framesForMs, linearToMulaw } from './mulaw';
import type { AgentReply, Transcription } from './scenario';
import { EnergyVad } from './vad';
import {
  MAX_DURATION_WRAP_UP_INSTRUCTION,
  NEVER_HEARD_GOODBYE_INSTRUCTION,
  SILENCE_PROMPT_INSTRUCTION,
} from '../../../server/voice-gateway/services/silenceWatchdog';

export const FIRST_AUDIO_MS = 300;
export const FRAMES_PER_TICK = 4;
export const TRANSCRIPT_DELAY_MS = 200;
export const AUTO_RESPONSE_DELAY_MS = 300;

export type ResponseKind =
  | 'greeting'
  | 'silence_prompt'
  | 'never_heard_goodbye'
  | 'max_duration_wrap'
  | 'instruction'
  | 'reply'
  | 'after_tool'
  | 'client';

export interface ResponseRecord {
  no: number;
  id: string;
  kind: ResponseKind;
  /** Who started it: the runtime (response.create) or server VAD (end of a caller turn). */
  trigger: 'client' | 'server_vad';
  text: string;
  /** Caller utterance it answers (server_vad replies). */
  utterance?: number;
  createdAt: number;
  doneAt?: number;
  status: 'in_progress' | 'completed' | 'cancelled';
  cancelledBy?: 'client' | 'barge_in';
  frames: number;
  framesSent: number;
  tool?: { callId: string; name: string; args: Record<string, unknown> };
  afterTool?: string;
}

export interface UtteranceRecord {
  index: number;
  startedAt: number;
  stoppedAt?: number;
  transcription: Transcription;
  transcript: string;
}

export interface FunctionOutputRecord {
  callId: string;
  at: number;
  /** The response.create the runtime sent right after it, if any. */
  followedBy?: number;
}

export interface FakeXaiScript {
  replies: AgentReply[];
  /** Per caller utterance: what the transcriber returns. */
  transcriptions: Array<{ text: string; transcription: Transcription }>;
  /**
   * interrupt_response takes effect this long after speech_started; the
   * response keeps streaming audio deltas until then (default 0: at once).
   */
  interruptLatencyMs?: number;
}

export interface FakeXaiHooks {
  now(): number;
  /** Deliver one server event to the client socket. */
  deliver(event: Record<string, unknown>): void;
  /** Agent audio frame → which response/frame it is (so Twilio-side playback can be attributed). */
  tagAgentFrame(base64: string, response: number, frame: number): void;
}

interface Scheduled {
  at: number;
  run: () => void;
}

/** A tone with the response number and frame index mixed in, so every frame's base64 is unique. */
function agentFrame(response: number, frame: number): Uint8Array {
  const out = new Uint8Array(FRAME_BYTES);
  const hz = 180 + 20 * (response % 8);
  for (let i = 0; i < FRAME_BYTES; i += 1) {
    const n = frame * FRAME_BYTES + i;
    out[i] = linearToMulaw(5_000 * Math.sin((2 * Math.PI * hz * n) / 8_000));
  }
  out[0] = response & 0xff;
  out[1] = frame & 0xff;
  out[2] = (frame >> 8) & 0xff;
  return out;
}

function quoted(instructions: string): string | undefined {
  return /"([^"]+)"/.exec(instructions)?.[1];
}

export class FakeXaiServer {
  readonly responses: ResponseRecord[] = [];
  readonly utterances: UtteranceRecord[] = [];
  readonly functionOutputs: FunctionOutputRecord[] = [];
  /** Client event types in order, with times (no audio payloads). */
  readonly clientEvents: Array<{ at: number; type: string }> = [];
  readonly errors: string[] = [];
  sessionUpdates = 0;
  authorization: string | undefined;
  private createResponse = true;
  private interruptResponse = true;
  private readonly vad = new EnergyVad();
  private active: ResponseRecord | null = null;
  private scheduled: Scheduled[] = [];
  private pendingAudio = new Uint8Array(0);
  private lastClientItem: 'function_call_output' | 'other' = 'other';

  constructor(private readonly hooks: FakeXaiHooks, private readonly script: FakeXaiScript) {}

  get inFlight(): ResponseRecord | null {
    return this.active;
  }

  get hasPendingWork(): boolean {
    return this.active !== null || this.scheduled.length > 0 || this.vad.inSpeech;
  }

  onClientEvent(event: Record<string, unknown>): void {
    const type = String(event.type ?? '');
    const now = this.hooks.now();
    if (type !== 'input_audio_buffer.append') this.clientEvents.push({ at: now, type });
    switch (type) {
      case 'session.update': {
        this.sessionUpdates += 1;
        const td = (event.session as { turn_detection?: Record<string, unknown> } | undefined)?.turn_detection;
        if (td) {
          this.createResponse = td.create_response !== false;
          this.interruptResponse = td.interrupt_response !== false;
          if (typeof td.silence_duration_ms === 'number') this.vad.setSilenceDuration(td.silence_duration_ms);
        }
        return;
      }
      case 'input_audio_buffer.append':
        this.onAudio(Buffer.from(String(event.audio ?? ''), 'base64'));
        return;
      case 'response.create': {
        const instructions = (event.response as { instructions?: unknown } | undefined)?.instructions;
        const followsOutput = this.lastClientItem === 'function_call_output';
        this.lastClientItem = 'other';
        const started = this.startResponse(this.classify(typeof instructions === 'string' ? instructions : undefined, followsOutput));
        const output = this.functionOutputs[this.functionOutputs.length - 1];
        if (followsOutput && started && output && output.followedBy === undefined) output.followedBy = started.no;
        return;
      }
      case 'response.cancel':
        if (this.active) this.finish(this.active, 'cancelled', 'client');
        return;
      case 'conversation.item.create': {
        const item = event.item as { type?: string; call_id?: string } | undefined;
        if (item?.type === 'function_call_output') {
          this.lastClientItem = 'function_call_output';
          this.functionOutputs.push({ callId: String(item.call_id ?? ''), at: now });
        } else {
          this.lastClientItem = 'other';
        }
        return;
      }
      default:
        return;
    }
  }

  /** One harness tick (20 ms): stream the in-flight response, run due server work. */
  tick(): void {
    const now = this.hooks.now();
    const due = this.scheduled.filter((item) => item.at <= now);
    this.scheduled = this.scheduled.filter((item) => item.at > now);
    for (const item of due) item.run();
    const response = this.active;
    if (!response || now < response.createdAt + FIRST_AUDIO_MS) return;
    for (let i = 0; i < FRAMES_PER_TICK && response.framesSent < response.frames; i += 1) {
      const frame = agentFrame(response.no, response.framesSent);
      const b64 = Buffer.from(frame).toString('base64');
      this.hooks.tagAgentFrame(b64, response.no, response.framesSent);
      response.framesSent += 1;
      this.hooks.deliver({ type: 'response.output_audio.delta', response_id: response.id, delta: b64 });
    }
    if (response.framesSent < response.frames) return;
    if (response.tool) {
      this.hooks.deliver({
        type: 'response.function_call_arguments.done',
        response_id: response.id,
        call_id: response.tool.callId,
        name: response.tool.name,
        arguments: JSON.stringify(response.tool.args),
      });
    }
    this.hooks.deliver({ type: 'response.output_audio_transcript.done', response_id: response.id, transcript: response.text });
    this.finish(response, 'completed');
  }

  private onAudio(bytes: Buffer): void {
    let buffer = Buffer.concat([Buffer.from(this.pendingAudio), bytes]);
    while (buffer.length >= FRAME_BYTES) {
      const frame = new Uint8Array(buffer.subarray(0, FRAME_BYTES));
      buffer = buffer.subarray(FRAME_BYTES);
      for (const vadEvent of this.vad.push(frame)) {
        if (vadEvent.type === 'speech_started') this.onSpeechStarted(vadEvent.audioMs);
        else this.onSpeechStopped(vadEvent.audioMs);
      }
    }
    this.pendingAudio = new Uint8Array(buffer);
  }

  private onSpeechStarted(audioMs: number): void {
    const index = this.utterances.length;
    const scripted = this.script.transcriptions[index];
    this.utterances.push({
      index,
      startedAt: this.hooks.now(),
      transcription: scripted?.transcription ?? 'ok',
      transcript: scripted?.text ?? '',
    });
    this.hooks.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: audioMs, item_id: `item_caller_${index}` });
    const interrupted = this.active;
    if (!this.interruptResponse || !interrupted) return;
    const latency = this.script.interruptLatencyMs ?? 0;
    if (latency <= 0) {
      this.finish(interrupted, 'cancelled', 'barge_in');
      return;
    }
    // Deltas already on their way: the response streams on until the cancel lands.
    this.scheduled.push({
      at: this.hooks.now() + latency,
      run: () => {
        if (this.active === interrupted) this.finish(interrupted, 'cancelled', 'barge_in');
      },
    });
  }

  private onSpeechStopped(audioMs: number): void {
    const utterance = this.utterances[this.utterances.length - 1];
    if (!utterance) return;
    const now = this.hooks.now();
    utterance.stoppedAt = now;
    const itemId = `item_caller_${utterance.index}`;
    this.hooks.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: audioMs, item_id: itemId });
    this.hooks.deliver({ type: 'input_audio_buffer.committed', item_id: itemId });
    if (utterance.transcription !== 'none') {
      const transcript = utterance.transcription === 'ok' ? utterance.transcript : '';
      this.scheduled.push({
        at: now + TRANSCRIPT_DELAY_MS,
        run: () => this.hooks.deliver({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript }),
      });
    }
    if (this.createResponse) {
      this.scheduled.push({ at: now + AUTO_RESPONSE_DELAY_MS, run: () => this.startReply(utterance.index) });
    }
  }

  private startReply(index: number): void {
    if (this.active) {
      // One response at a time: answer the turn once the current one is done.
      this.scheduled.push({ at: this.hooks.now() + 20, run: () => this.startReply(index) });
      return;
    }
    const reply = this.script.replies[index];
    this.startResponse({ kind: 'reply', trigger: 'server_vad', text: reply?.say ?? 'Okay.', utterance: index, reply });
  }

  private classify(
    instructions: string | undefined,
    followsOutput: boolean,
  ): { kind: ResponseKind; trigger: 'client'; text: string } {
    if (instructions === undefined) {
      if (followsOutput) {
        const asked = [...this.responses].reverse().find((r) => r.tool);
        return { kind: 'after_tool', trigger: 'client', text: asked?.afterTool ?? 'Here is what I found.' };
      }
      return { kind: 'client', trigger: 'client', text: 'Okay.' };
    }
    const line = quoted(instructions) ?? 'Okay.';
    if (instructions === SILENCE_PROMPT_INSTRUCTION) return { kind: 'silence_prompt', trigger: 'client', text: line };
    if (instructions === NEVER_HEARD_GOODBYE_INSTRUCTION) return { kind: 'never_heard_goodbye', trigger: 'client', text: line };
    if (instructions === MAX_DURATION_WRAP_UP_INSTRUCTION) return { kind: 'max_duration_wrap', trigger: 'client', text: line };
    if (instructions.startsWith('The caller just connected.')) return { kind: 'greeting', trigger: 'client', text: line };
    return { kind: 'instruction', trigger: 'client', text: line };
  }

  private startResponse(spec: {
    kind: ResponseKind;
    trigger: 'client' | 'server_vad';
    text: string;
    utterance?: number;
    reply?: AgentReply;
  }): ResponseRecord | undefined {
    if (this.active) {
      // Like the real API: one response at a time.
      this.errors.push(`response.create while ${this.active.id} is in progress`);
      this.hooks.deliver({ type: 'error', error: { code: 'conversation_already_has_active_response' } });
      return undefined;
    }
    const no = this.responses.length + 1;
    const record: ResponseRecord = {
      no,
      id: `resp_${no}`,
      kind: spec.kind,
      trigger: spec.trigger,
      text: spec.text,
      utterance: spec.utterance,
      createdAt: this.hooks.now(),
      status: 'in_progress',
      frames: framesForMs(lineDurationMs(spec.text)),
      framesSent: 0,
      tool: spec.reply?.tool ? { callId: `call_${no}`, name: spec.reply.tool.name, args: spec.reply.tool.args ?? {} } : undefined,
      afterTool: spec.reply?.afterTool,
    };
    this.responses.push(record);
    this.active = record;
    this.hooks.deliver({ type: 'response.created', response: { id: record.id, status: 'in_progress' } });
    return record;
  }

  private finish(response: ResponseRecord, status: 'completed' | 'cancelled', cancelledBy?: 'client' | 'barge_in'): void {
    response.status = status;
    response.cancelledBy = cancelledBy;
    response.doneAt = this.hooks.now();
    if (this.active === response) this.active = null;
    this.hooks.deliver({ type: 'response.done', response: { id: response.id, status } });
  }
}
