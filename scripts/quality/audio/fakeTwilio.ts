/**
 * Twilio's side of the media stream. It opens /twilio/stream on the real
 * route (routes/stream.ts attachWebSocket), sends `connected`, `start` and
 * one `media` event per 20 ms of caller audio, and `stop` when the caller
 * hangs up. For what the gateway sends back it models Twilio's playback
 * buffer: agent `media` queues and plays in real time, a `mark` is echoed
 * once the audio queued before it has played, and `clear` drops the
 * unplayed audio and echoes the pending marks at once (Twilio's documented
 * behaviour). So "what the caller heard" is graded, not just what was sent.
 */
import { EventEmitter } from 'node:events';
import { FRAME_BYTES, FRAME_MS } from './mulaw';

export const OPEN = 1;
export const CLOSED = 3;

/** The gateway's end of the Twilio WebSocket (what `ws` hands routes/stream.ts). */
export class FakeServerSocket extends EventEmitter {
  readyState = OPEN;
  closeCode: number | undefined;

  constructor(private readonly onSend: (data: string) => void, private readonly onClose: (code?: number) => void) {
    super();
  }

  send(data: string | Buffer): void {
    if (this.readyState !== OPEN) return;
    this.onSend(String(data));
  }

  close(code?: number): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.closeCode = code;
    this.onClose(code);
    setImmediate(() => this.emit('close', code ?? 1000));
  }

  terminate(): void {
    this.close(1006);
  }

  /** Twilio → gateway. */
  deliver(event: Record<string, unknown>): void {
    if (this.readyState !== OPEN) return;
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }

  /** Twilio drops the socket after `stop`. */
  dropFromTwilio(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    setImmediate(() => this.emit('close', 1000));
  }
}

export interface PlayedFrame {
  response?: number;
  start: number;
  end: number;
  /** Dropped by a `clear` before it played. */
  cleared: boolean;
}

export interface StartParams {
  tenantId: string;
  agentId: string;
  callSid: string;
  callerNumber: string;
  calledNumber: string;
  token: string;
}

export class FakeTwilioCall {
  readonly streamSid: string;
  readonly frames: PlayedFrame[] = [];
  readonly clears: number[] = [];
  readonly marksSent: Array<{ name: string; at: number }> = [];
  readonly marksEchoed: Array<{ name: string; at: number }> = [];
  readonly unknownEvents: string[] = [];
  serverClosedAt: number | undefined;
  serverCloseCode: number | undefined;
  callerHungUpAt: number | undefined;
  socket: FakeServerSocket | undefined;
  private playhead = 0;
  private pendingMarks: Array<{ name: string; at: number }> = [];
  private mediaSeq = 0;
  private playingSince: number | undefined;

  constructor(
    private readonly now: () => number,
    private readonly tagOf: (base64: string) => number | undefined,
    readonly callSid: string,
  ) {
    this.streamSid = `MZ${callSid.replace(/[^A-Za-z0-9]/g, '').slice(-30)}`;
  }

  /** Socket created by the fake `ws` server for this call. */
  attach(): FakeServerSocket {
    this.socket = new FakeServerSocket(
      (data) => this.fromGateway(JSON.parse(data) as Record<string, unknown>),
      (code) => {
        this.serverClosedAt = this.now();
        this.serverCloseCode = code;
      },
    );
    return this.socket;
  }

  start(params: StartParams): void {
    this.socket?.deliver({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    this.socket?.deliver({
      event: 'start',
      sequenceNumber: '1',
      streamSid: this.streamSid,
      start: {
        streamSid: this.streamSid,
        accountSid: 'ACrt11harness',
        callSid: params.callSid,
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        customParameters: { ...params },
      },
    });
  }

  sendCallerFrame(frame: Uint8Array): void {
    this.mediaSeq += 1;
    this.socket?.deliver({
      event: 'media',
      sequenceNumber: String(this.mediaSeq + 1),
      streamSid: this.streamSid,
      media: { track: 'inbound', chunk: String(this.mediaSeq), timestamp: String(this.mediaSeq * FRAME_MS), payload: Buffer.from(frame).toString('base64') },
    });
  }

  hangUp(): void {
    if (this.callerHungUpAt !== undefined || this.serverClosedAt !== undefined) return;
    this.callerHungUpAt = this.now();
    this.socket?.deliver({ event: 'stop', streamSid: this.streamSid, stop: { accountSid: 'ACrt11harness', callSid: this.callSid } });
    this.socket?.dropFromTwilio();
  }

  get ended(): boolean {
    return this.serverClosedAt !== undefined || this.callerHungUpAt !== undefined;
  }

  /** Agent audio is queued or playing now. */
  isPlaying(at = this.now()): boolean {
    return this.playhead > at;
  }

  /** How long the current stretch of agent audio has been audible (0 when quiet). */
  playingFor(at = this.now()): number {
    if (!this.isPlaying(at) || this.playingSince === undefined) return 0;
    return Math.max(0, at - this.playingSince);
  }

  /** The response whose audio is audible at `at` (or was due then, before a `clear` dropped it). */
  responseAudibleAt(at: number, includeCleared = false): number | undefined {
    return this.frames.find((f) => (includeCleared || !f.cleared) && f.start <= at && f.end > at)?.response;
  }

  /** Audible ms of a response's audio after `after`. */
  audibleMsAfter(response: number, after: number): number {
    return this.frames
      .filter((f) => f.response === response && !f.cleared && f.end > after)
      .reduce((sum, f) => sum + (f.end - Math.max(f.start, after)), 0);
  }

  /** Last moment any agent audio played, at or before `at`. */
  lastAudioEndBefore(at: number): number | undefined {
    let last: number | undefined;
    for (const f of this.frames) {
      if (f.cleared || f.start > at) continue;
      const end = Math.min(f.end, at);
      if (last === undefined || end > last) last = end;
    }
    return last;
  }

  /** One harness tick: echo marks whose audio has finished playing. */
  tick(): void {
    const now = this.now();
    const due = this.pendingMarks.filter((mark) => mark.at <= now);
    this.pendingMarks = this.pendingMarks.filter((mark) => mark.at > now);
    for (const mark of due) this.echoMark(mark.name);
  }

  private echoMark(name: string): void {
    this.marksEchoed.push({ name, at: this.now() });
    this.socket?.deliver({ event: 'mark', sequenceNumber: '0', streamSid: this.streamSid, mark: { name } });
  }

  private fromGateway(msg: Record<string, unknown>): void {
    const now = this.now();
    const event = String(msg.event ?? '');
    if (event === 'media') {
      const payload = String((msg.media as { payload?: unknown } | undefined)?.payload ?? '');
      const bytes = Buffer.from(payload, 'base64').length;
      const start = Math.max(now, this.playhead);
      if (start > this.playhead || this.playhead <= now) this.playingSince = start;
      const end = start + (bytes / FRAME_BYTES) * FRAME_MS;
      this.playhead = end;
      this.frames.push({ response: this.tagOf(payload), start, end, cleared: false });
      return;
    }
    if (event === 'mark') {
      const name = String((msg.mark as { name?: unknown } | undefined)?.name ?? '');
      this.marksSent.push({ name, at: now });
      this.pendingMarks.push({ name, at: Math.max(now, this.playhead) });
      return;
    }
    if (event === 'clear') {
      this.clears.push(now);
      for (const f of this.frames) if (!f.cleared && f.start >= now) f.cleared = true;
      this.playhead = Math.min(this.playhead, now);
      const pending = this.pendingMarks;
      this.pendingMarks = [];
      for (const mark of pending) this.echoMark(mark.name);
      return;
    }
    this.unknownEvents.push(event);
  }
}
