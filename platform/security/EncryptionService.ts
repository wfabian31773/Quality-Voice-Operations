import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('ENCRYPTION');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEK_SALT = 'envelope-kek-v1';

const IS_DEV = ['development', 'dev', 'local', 'test'].includes(
  (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development').toLowerCase(),
);

function deriveKEK(): Buffer {
  const secret = process.env.ENCRYPTION_MASTER_KEY ?? process.env.CONNECTOR_ENCRYPTION_KEY;

  if (!secret) {
    if (IS_DEV) {
      const devKey = 'qvo-dev-encryption-' + (process.env.REPL_ID ?? 'local');
      logger.warn('ENCRYPTION_MASTER_KEY not set — using auto-generated dev key');
      return scryptSync(devKey, KEK_SALT, 32) as Buffer;
    }
    throw new Error('ENCRYPTION_MASTER_KEY environment variable is required in production.');
  }

  return scryptSync(secret, KEK_SALT, 32) as Buffer;
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptWithKey(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}

export function generateDEK(): Buffer {
  return randomBytes(32);
}

export function encryptDEK(dek: Buffer): string {
  const kek = deriveKEK();
  return encryptWithKey(dek.toString('hex'), kek);
}

export function decryptDEK(encryptedDek: string): Buffer {
  const kek = deriveKEK();
  const hex = decryptWithKey(encryptedDek, kek);
  return Buffer.from(hex, 'hex');
}

const ENVELOPE_PREFIX = 'env1:';

export function encryptField(plaintext: string, dek: Buffer, keyId?: string): string {
  const encrypted = encryptWithKey(plaintext, dek);
  if (keyId) {
    return `${ENVELOPE_PREFIX}${keyId}:${encrypted}`;
  }
  return `${ENVELOPE_PREFIX}${encrypted}`;
}

export function isEnvelopeEncrypted(ciphertext: string): boolean {
  return ciphertext.startsWith(ENVELOPE_PREFIX);
}

export function parseEnvelopeCiphertext(ciphertext: string): { keyId: string | null; payload: string } {
  const withoutPrefix = ciphertext.slice(ENVELOPE_PREFIX.length);
  const parts = withoutPrefix.split(':');
  if (parts.length >= 2 && parts[0].length === 36) {
    return { keyId: parts[0], payload: parts.slice(1).join(':') };
  }
  return { keyId: null, payload: withoutPrefix };
}

export function decryptField(ciphertext: string, dek: Buffer): string {
  if (ciphertext.startsWith(ENVELOPE_PREFIX)) {
    const { payload } = parseEnvelopeCiphertext(ciphertext);
    return decryptWithKey(payload, dek);
  }
  return decryptWithKey(ciphertext, dek);
}

export async function getOrCreateTenantDEK(tenantId: string, keyAlias: string = 'default'): Promise<{ keyId: string; dek: Buffer }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, encrypted_dek FROM encryption_keys
       WHERE tenant_id = $1 AND key_alias = $2 AND is_active = TRUE
       LIMIT 1`,
      [tenantId, keyAlias],
    );

    if (rows.length > 0) {
      await client.query('COMMIT');
      return {
        keyId: rows[0].id as string,
        dek: decryptDEK(rows[0].encrypted_dek as string),
      };
    }

    const dek = generateDEK();
    const encryptedDek = encryptDEK(dek);

    const { rows: newRows } = await client.query(
      `INSERT INTO encryption_keys (tenant_id, key_alias, encrypted_dek)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [tenantId, keyAlias, encryptedDek],
    );
    await client.query('COMMIT');

    logger.info('Created new DEK', { tenantId, keyAlias, keyId: newRows[0].id as string });
    return { keyId: newRows[0].id as string, dek };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function rotateTenantDEK(tenantId: string, keyAlias: string = 'default'): Promise<{ keyId: string }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    await client.query(
      `UPDATE encryption_keys SET is_active = FALSE, rotated_at = NOW()
       WHERE tenant_id = $1 AND key_alias = $2 AND is_active = TRUE`,
      [tenantId, keyAlias],
    );

    const dek = generateDEK();
    const encryptedDek = encryptDEK(dek);

    const { rows } = await client.query(
      `INSERT INTO encryption_keys (tenant_id, key_alias, encrypted_dek)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [tenantId, keyAlias, encryptedDek],
    );
    await client.query('COMMIT');

    logger.info('Rotated DEK', { tenantId, keyAlias, newKeyId: rows[0].id as string });
    return { keyId: rows[0].id as string };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getEncryptionStatus(tenantId: string): Promise<{
  encryptionEnabled: boolean;
  activeKeys: number;
  encryptedTables: string[];
  lastKeyRotation: string | null;
}> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: keyRows } = await client.query(
      `SELECT COUNT(*) as count, MAX(created_at) as latest
       FROM encryption_keys WHERE tenant_id = $1 AND is_active = TRUE`,
      [tenantId],
    );

    const { rows: rotationRows } = await client.query(
      `SELECT MAX(rotated_at) as last_rotation
       FROM encryption_keys WHERE tenant_id = $1 AND rotated_at IS NOT NULL`,
      [tenantId],
    );

    const { rows: fieldRows } = await client.query(
      `SELECT DISTINCT table_name FROM encrypted_fields WHERE tenant_id = $1`,
      [tenantId],
    );

    await client.query('COMMIT');

    const activeKeys = parseInt(keyRows[0]?.count as string ?? '0');
    return {
      encryptionEnabled: activeKeys > 0,
      activeKeys,
      encryptedTables: fieldRows.map(r => r.table_name as string),
      lastKeyRotation: (rotationRows[0]?.last_rotation as string) ?? null,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
