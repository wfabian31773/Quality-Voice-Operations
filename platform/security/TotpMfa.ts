import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_SECRET_BYTES = 20;
const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 'v1';

interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
}

function isProductionLike(): boolean {
  return process.env.APP_ENV === 'production'
    || process.env.APP_ENV === 'staging'
    || process.env.NODE_ENV === 'production';
}

function masterSecret(): string {
  const configured = process.env.ENCRYPTION_MASTER_KEY ?? process.env.CONNECTOR_ENCRYPTION_KEY;
  if (configured) {
    if (isProductionLike() && Buffer.byteLength(configured, 'utf8') < 32) {
      throw new Error('ENCRYPTION_MASTER_KEY must contain at least 32 bytes for platform-admin MFA');
    }
    return configured;
  }
  if (isProductionLike()) {
    throw new Error('ENCRYPTION_MASTER_KEY is required for platform-admin MFA');
  }
  return `qvo-development-mfa-key-${process.env.REPL_ID ?? 'local'}`;
}

function deriveKey(purpose: 'totp-encryption' | 'recovery-code-pepper'): Buffer {
  return scryptSync(masterSecret(), `qvo-mfa-${purpose}-v1`, 32);
}

function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/=+$/u, '').replace(/\s+/gu, '');
  if (!normalized || !/^[A-Z2-7]+$/u.test(normalized)) {
    throw new Error('Invalid base32 TOTP secret');
  }

  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(TOTP_SECRET_BYTES));
}

export function totpAt(secret: string, timestampMs: number = Date.now(), options: TotpOptions = {}): string {
  const digits = options.digits ?? 6;
  const periodSeconds = options.periodSeconds ?? TOTP_PERIOD_SECONDS;
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error('TOTP digits must be between 6 and 8');
  if (!Number.isInteger(periodSeconds) || periodSeconds < 15) throw new Error('TOTP period is invalid');
  if (!Number.isFinite(timestampMs) || timestampMs < 0) throw new Error('TOTP timestamp is invalid');

  const counter = BigInt(Math.floor(timestampMs / 1000 / periodSeconds));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export function verifyTotp(secret: string, code: string, timestampMs: number = Date.now()): boolean {
  return matchTotpStep(secret, code, timestampMs) !== null;
}

export function matchTotpStep(secret: string, code: string, timestampMs: number = Date.now()): bigint | null {
  if (!/^\d{6}$/u.test(code)) return null;
  let matchedStep: bigint | null = null;
  for (const stepOffset of [-1, 0, 1]) {
    const candidateTimestamp = timestampMs + stepOffset * TOTP_PERIOD_SECONDS * 1000;
    const candidate = totpAt(secret, candidateTimestamp);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) {
      matchedStep = BigInt(Math.floor(candidateTimestamp / (TOTP_PERIOD_SECONDS * 1000)));
    }
  }
  return matchedStep;
}

export function encryptTotpSecret(secret: string): string {
  decodeBase32(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, deriveKey('totp-encryption'), iv);
  cipher.setAAD(Buffer.from('qvo:platform-admin:mfa:totp:v1'));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptTotpSecret(ciphertext: string): string {
  const [version, ivValue, tagValue, encryptedValue, extra] = ciphertext.split('.');
  if (version !== FORMAT_VERSION || !ivValue || !tagValue || !encryptedValue || extra !== undefined) {
    throw new Error('Invalid encrypted TOTP secret');
  }
  const iv = Buffer.from(ivValue, 'base64url');
  const tag = Buffer.from(tagValue, 'base64url');
  const encrypted = Buffer.from(encryptedValue, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || encrypted.length === 0) {
    throw new Error('Invalid encrypted TOTP secret');
  }
  const decipher = createDecipheriv(CIPHER, deriveKey('totp-encryption'), iv);
  decipher.setAAD(Buffer.from('qvo:platform-admin:mfa:totp:v1'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  decodeBase32(plaintext);
  return plaintext;
}

export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < 10) {
    const value = encodeBase32(randomBytes(8)).slice(0, 10);
    codes.add(`${value.slice(0, 5)}-${value.slice(5)}`);
  }
  return [...codes];
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return createHmac('sha256', deriveKey('recovery-code-pepper'))
    .update(normalizeRecoveryCode(code), 'utf8')
    .digest('hex');
}

export function verifyRecoveryCode(code: string, expectedHash: string): boolean {
  if (!/^[A-Z0-9]{5}-[A-Z0-9]{5}$/u.test(normalizeRecoveryCode(code))) return false;
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) return false;
  const actual = Buffer.from(hashRecoveryCode(code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return timingSafeEqual(actual, expected);
}
