import { getPlatformPool, withTenantContext } from '../db';
import { getOrCreateTenantDEK, encryptField, decryptField, isEnvelopeEncrypted, parseEnvelopeCiphertext, decryptDEK } from './EncryptionService';
import { createLogger } from '../core/logger';

const logger = createLogger('FIELD_ENCRYPTION');

export async function encryptSensitiveField(tenantId: string, plaintext: string): Promise<string> {
  const { keyId, dek } = await getOrCreateTenantDEK(tenantId);
  return encryptField(plaintext, dek, keyId);
}

export async function decryptSensitiveField(tenantId: string, ciphertext: string): Promise<string> {
  if (!isEnvelopeEncrypted(ciphertext)) {
    const { dek } = await getOrCreateTenantDEK(tenantId);
    return decryptField(ciphertext, dek);
  }

  const { keyId } = parseEnvelopeCiphertext(ciphertext);

  if (keyId) {
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});
      const { rows } = await client.query(
        `SELECT encrypted_dek FROM encryption_keys WHERE id = $1 AND tenant_id = $2`,
        [keyId, tenantId],
      );
      await client.query('COMMIT');
      if (rows.length > 0) {
        const dek = decryptDEK(rows[0].encrypted_dek as string);
        return decryptField(ciphertext, dek);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.warn('Failed to decrypt with specific key, trying active key', { tenantId, keyId });
    } finally {
      client.release();
    }
  }

  const { dek } = await getOrCreateTenantDEK(tenantId);
  return decryptField(ciphertext, dek);
}

export async function encryptTranscript(tenantId: string, transcript: string): Promise<string> {
  return await encryptSensitiveField(tenantId, transcript);
}

export async function decryptTranscript(tenantId: string, encryptedTranscript: string): Promise<string> {
  if (isEnvelopeEncrypted(encryptedTranscript)) {
    return await decryptSensitiveField(tenantId, encryptedTranscript);
  }
  return encryptedTranscript;
}

export async function encryptPiiFields(
  tenantId: string,
  data: Record<string, string>,
  fieldsToEncrypt: string[],
): Promise<Record<string, string>> {
  const result = { ...data };
  const { keyId, dek } = await getOrCreateTenantDEK(tenantId);

  for (const field of fieldsToEncrypt) {
    if (result[field]) {
      result[field] = encryptField(result[field], dek, keyId);
    }
  }
  return result;
}

export async function decryptPiiFields(
  tenantId: string,
  data: Record<string, string>,
  fieldsToDecrypt: string[],
): Promise<Record<string, string>> {
  const result = { ...data };
  try {
    const { dek } = await getOrCreateTenantDEK(tenantId);
    for (const field of fieldsToDecrypt) {
      if (result[field]) {
        try {
          result[field] = decryptField(result[field], dek);
        } catch {
          // Field may not be encrypted yet
        }
      }
    }
  } catch (err) {
    logger.warn('Could not decrypt PII fields', { tenantId, error: String(err) });
  }
  return result;
}
