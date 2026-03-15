import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { createLogger } from '../../core/logger';

const logger = createLogger('CONNECTOR_CRYPTO');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT = 'connector-config-v1';

const IS_DEV = ['development', 'dev', 'local', 'test'].includes(
  (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development').toLowerCase(),
);

function deriveKey(): Buffer {
  const secret = process.env.CONNECTOR_ENCRYPTION_KEY;

  if (!secret) {
    if (IS_DEV) {
      const devKey = 'qvo-dev-connector-' + (process.env.REPL_ID ?? 'local');
      logger.warn('CONNECTOR_ENCRYPTION_KEY not set — using auto-generated dev key (NOT for production)');
      return scryptSync(devKey, SALT, 32) as Buffer;
    }
    throw new Error(
      'CONNECTOR_ENCRYPTION_KEY environment variable is required in production. ' +
        'Set a 32-byte+ random secret before starting the server.',
    );
  }

  if (secret.length < 16) {
    throw new Error(
      'CONNECTOR_ENCRYPTION_KEY is too short — minimum 16 characters required.',
    );
  }

  return scryptSync(secret, SALT, 32) as Buffer;
}

export function encryptValue(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptValue(ciphertext: string): string {
  const key = deriveKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}
