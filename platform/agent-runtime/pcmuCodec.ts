/** G.711 μ-law (PCMU) at the Master Voice Agent locked rate. */
export const PCMU_SAMPLE_RATE = 8000;
const BIAS = 0x84;
const CLIP = 32635;

const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

export function linearToMulaw(sample: number): number {
  let mask: number;
  if (sample < 0) {
    sample = BIAS - sample;
    mask = 0x7f;
  } else {
    sample += BIAS;
    mask = 0xff;
  }
  if (sample > CLIP) sample = CLIP;
  let seg = 8;
  for (let i = 0; i < 8; i += 1) {
    if (sample <= SEG_END[i]) {
      seg = i;
      break;
    }
  }
  if (seg >= 8) return (~mask) & 0xff;
  const uval = (seg << 4) | ((sample >> (seg + 3)) & 0x0f);
  return (uval ^ mask) & 0xff;
}

export function mulawToLinear(mulaw: number): number {
  const inverted = ~mulaw & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const sample = ((mantissa << 3) + BIAS) << exponent;
  return (sign !== 0 ? BIAS - sample : sample - BIAS);
}

export function downsamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate <= 0 || toRate <= 0 || input.length === 0) return new Int16Array(0);
  if (fromRate === toRate) return input.slice();
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end && j < input.length; j += 1) sum += input[j];
    output[i] = Math.round(sum / Math.max(1, end - start));
  }
  return output;
}

export function encodePcmuFromPcm16(pcm16: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) out[i] = linearToMulaw(pcm16[i]);
  return out;
}

export function decodePcmuToPcm16(pcmu: Uint8Array): Int16Array {
  const out = new Int16Array(pcmu.length);
  for (let i = 0; i < pcmu.length; i += 1) out[i] = mulawToLinear(pcmu[i]);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
