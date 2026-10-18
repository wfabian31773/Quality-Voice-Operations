/**
 * G.711 μ-law at 8 kHz, the format of a Twilio media stream (and of the xAI
 * session's `audio/pcmu` input and output). One frame = 20 ms = 160 bytes,
 * the size Twilio sends per `media` event.
 */

export const SAMPLE_RATE = 8_000;
export const FRAME_MS = 20;
export const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS) / 1_000;

const BIAS = 0x84;
const CLIP = 32_635;

/** One 16-bit linear PCM sample → one μ-law byte. */
export function linearToMulaw(input: number): number {
  let sample = Math.max(-32_768, Math.min(32_767, Math.round(input)));
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One μ-law byte → one 16-bit linear PCM sample. */
export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}

/** μ-law of digital silence (0xff). */
export const MULAW_SILENCE = linearToMulaw(0);

export function encodeFrame(samples: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = linearToMulaw(samples[i]);
  return out;
}

/** Root-mean-square level of a μ-law frame, in linear PCM units (0..32767). */
export function frameRms(frame: Uint8Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const s = mulawToLinear(frame[i]);
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

export function framesForMs(ms: number): number {
  return Math.max(0, Math.round(ms / FRAME_MS));
}
