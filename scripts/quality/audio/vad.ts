/**
 * Energy VAD for the fake realtime provider, shaped like the provider's
 * server VAD: speech starts after a few loud frames and stops after
 * `silenceDurationMs` of quiet (the session's turn_detection value). Times
 * are audio time: 20 ms per frame received.
 */
import { FRAME_MS, frameRms } from './mulaw';

export type VadEvent =
  | { type: 'speech_started'; audioMs: number }
  | { type: 'speech_stopped'; audioMs: number };

export interface EnergyVadOptions {
  /** Frame RMS (linear PCM) at or above this counts as voiced. */
  rmsThreshold?: number;
  /** Consecutive voiced frames needed to start speech. */
  startFrames?: number;
  /** Quiet needed to end speech (turn_detection.silence_duration_ms). */
  silenceDurationMs?: number;
}

export const DEFAULT_VAD_RMS = 400;

export class EnergyVad {
  private readonly rmsThreshold: number;
  private readonly startFrames: number;
  private silenceDurationMs: number;
  private frames = 0;
  private voicedRun = 0;
  private quietMs = 0;
  private speaking = false;

  constructor(opts: EnergyVadOptions = {}) {
    this.rmsThreshold = opts.rmsThreshold ?? DEFAULT_VAD_RMS;
    this.startFrames = opts.startFrames ?? 2;
    this.silenceDurationMs = opts.silenceDurationMs ?? 500;
  }

  setSilenceDuration(ms: number): void {
    this.silenceDurationMs = ms;
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  push(frame: Uint8Array): VadEvent[] {
    this.frames += 1;
    const audioMs = this.frames * FRAME_MS;
    const voiced = frameRms(frame) >= this.rmsThreshold;
    if (!this.speaking) {
      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= this.startFrames) {
        this.speaking = true;
        this.quietMs = 0;
        return [{ type: 'speech_started', audioMs: audioMs - this.startFrames * FRAME_MS }];
      }
      return [];
    }
    this.quietMs = voiced ? 0 : this.quietMs + FRAME_MS;
    if (this.quietMs >= this.silenceDurationMs) {
      this.speaking = false;
      this.voicedRun = 0;
      return [{ type: 'speech_stopped', audioMs }];
    }
    return [];
  }
}
