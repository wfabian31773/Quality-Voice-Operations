import { describe, expect, it } from 'vitest';
import {
  PCMU_SAMPLE_RATE,
  decodePcmuToPcm16,
  downsamplePcm16,
  encodePcmuFromPcm16,
  linearToMulaw,
  mulawToLinear,
} from './pcmuCodec';

const BIAS_TOLERANCE = 132;

describe('pcmuCodec', () => {
  it('round-trips silence and a loud sample through μ-law', () => {
    expect(Math.abs(mulawToLinear(linearToMulaw(0)))).toBeLessThan(BIAS_TOLERANCE);
    const loud = linearToMulaw(12_000);
    expect(Math.abs(mulawToLinear(loud))).toBeGreaterThan(8_000);
  });

  it('encodes PCM frames into one μ-law byte per sample', () => {
    const pcm = new Int16Array([0, 800, -800, 4000]);
    const encoded = encodePcmuFromPcm16(pcm);
    expect(encoded.length).toBe(4);
    const decoded = decodePcmuToPcm16(encoded);
    expect(decoded.length).toBe(4);
    expect(Math.abs(decoded[0])).toBeLessThan(BIAS_TOLERANCE);
    expect(decoded[1]).toBeGreaterThan(0);
    expect(decoded[2]).toBeLessThan(0);
  });

  it('downsamples 24 kHz capture to the locked 8 kHz session rate', () => {
    const input = new Int16Array(24);
    input.fill(1000);
    const out = downsamplePcm16(input, 24_000, PCMU_SAMPLE_RATE);
    expect(out.length).toBe(8);
    expect(out[0]).toBe(1000);
  });
});
