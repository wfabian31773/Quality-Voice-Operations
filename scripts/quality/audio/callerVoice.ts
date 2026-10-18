/**
 * Synthetic caller voice. `CallerVoice` is the plug point for a real TTS
 * later (a nightly with real speech needs Wayne's OK for the cost and a CI
 * secret); only the offline synthesizer exists today. It needs no network,
 * no key and no env: the same line always gives the same frames.
 *
 * The offline voice is not speech. It is speech-like for a VAD: a voiced
 * buzz (120 Hz fundamental, harmonics band-limited to the 3.4 kHz phone
 * band) plus a little breath noise, shaped by a ~4 Hz syllable envelope,
 * about as loud as a caller close to the phone. Its length follows the
 * line's word count, so a longer line is a longer utterance.
 */
import { encodeFrame, FRAME_BYTES, framesForMs, MULAW_SILENCE, SAMPLE_RATE } from './mulaw';

export type CallerLang = 'en' | 'es';

export interface CallerVoice {
  readonly id: string;
  /** One caller line → 20 ms μ-law frames (8 kHz), ready for Twilio `media` events. */
  synthesize(line: string, lang: CallerLang): Uint8Array[];
}

/** FNV-1a: a stable seed from a string. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small deterministic PRNG in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Speaking rate: ~150 words a minute, plus a short onset. */
export const MS_PER_WORD = 380;
export const LINE_ONSET_MS = 200;
const PEAK = 9_000;
const F0_HZ = 120;
const BAND_HZ = 3_400;

export function lineDurationMs(line: string): number {
  const words = line.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(400, LINE_ONSET_MS + words * MS_PER_WORD);
}

export class OfflineCallerVoice implements CallerVoice {
  readonly id = 'offline-synth@1';

  synthesize(line: string, lang: CallerLang): Uint8Array[] {
    const rand = prng(hashSeed(`${lang}:${line}`));
    const total = framesForMs(lineDurationMs(line)) * FRAME_BYTES;
    const samples = new Float64Array(total);
    const harmonics = Math.floor(BAND_HZ / F0_HZ);
    const phases = Array.from({ length: harmonics }, () => rand() * 2 * Math.PI);
    const syllableHz = lang === 'es' ? 4.6 : 4.0;
    const rampSamples = (SAMPLE_RATE * 40) / 1_000;
    for (let n = 0; n < total; n += 1) {
      const t = n / SAMPLE_RATE;
      const f0 = F0_HZ * (1 + 0.04 * Math.sin(2 * Math.PI * 1.3 * t));
      let voiced = 0;
      for (let h = 1; h <= harmonics; h += 1) {
        voiced += Math.sin(2 * Math.PI * f0 * h * t + phases[h - 1]) / h;
      }
      const breath = (rand() * 2 - 1) * 0.15;
      // Syllables: never fully closed, so one line is one utterance to a VAD.
      const syllable = 0.45 + 0.55 * Math.abs(Math.sin(Math.PI * syllableHz * t));
      const edge = Math.min(1, n / rampSamples, (total - n) / rampSamples);
      samples[n] = PEAK * 0.5 * (voiced + breath) * syllable * edge;
    }
    const frames: Uint8Array[] = [];
    for (let at = 0; at < total; at += FRAME_BYTES) frames.push(encodeFrame(samples.subarray(at, at + FRAME_BYTES)));
    return frames;
  }
}

export function silenceFrames(ms: number): Uint8Array[] {
  return Array.from({ length: framesForMs(ms) }, () => new Uint8Array(FRAME_BYTES).fill(MULAW_SILENCE));
}

/**
 * An open line with nobody talking: faint hiss well under any speech VAD
 * (a dialler, or a caller who never speaks). Deterministic per seed.
 */
export function lineNoiseFrames(ms: number, seed: number, level = 60): Uint8Array[] {
  const rand = prng(seed);
  return Array.from({ length: framesForMs(ms) }, () => {
    const samples = new Float64Array(FRAME_BYTES);
    for (let i = 0; i < FRAME_BYTES; i += 1) samples[i] = (rand() * 2 - 1) * level;
    return encodeFrame(samples);
  });
}
