import { decryptSensitiveField } from '../security/FieldEncryption';
import {
  createPiiLookupHashRecord,
  getCurrentPiiLookupKeyVersion,
} from '../security/PiiLookupHash';

export const CALLER_LOOKUP_BACKFILL_ACKNOWLEDGEMENT = 'APPLY CALLER LOOKUP HASH BACKFILL';

interface BackfillClient {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface CallerLookupHashBackfillInput {
  mode?: 'dry-run' | 'apply';
  acknowledgement?: string;
  cursor?: string | null;
  batchSize?: number;
}

export interface CallerLookupHashBackfillResult {
  mode: 'dry-run' | 'apply';
  keyVersion: string;
  scanned: number;
  eligible: number;
  updated: number;
  skipped: number;
  failed: number;
  nextCursor: string | null;
  batchComplete: boolean;
}

export async function runCallerLookupHashBackfill(
  client: BackfillClient,
  input: CallerLookupHashBackfillInput = {},
  dependencies: {
    decrypt?: (tenantId: string, ciphertext: string) => Promise<string>;
  } = {},
): Promise<CallerLookupHashBackfillResult> {
  const mode = input.mode ?? 'dry-run';
  if (mode === 'apply' && input.acknowledgement !== CALLER_LOOKUP_BACKFILL_ACKNOWLEDGEMENT) {
    throw new Error(`Apply mode requires acknowledgement: ${CALLER_LOOKUP_BACKFILL_ACKNOWLEDGEMENT}`);
  }
  const batchSize = input.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error('Batch size must be an integer from 1 to 500');
  }
  const cursor = input.cursor?.trim() || null;
  if (cursor && (cursor.length > 100 || /[\u0000-\u001f]/.test(cursor))) {
    throw new Error('Cursor is invalid');
  }
  const keyVersion = getCurrentPiiLookupKeyVersion();
  if (!keyVersion) throw new Error('Caller lookup HMAC keyring is not valid');

  const { rows } = await client.query(
    `SELECT id, tenant_id, caller_number
       FROM call_sessions
      WHERE caller_number IS NOT NULL
        AND (caller_lookup_hash IS NULL OR caller_lookup_key_version IS DISTINCT FROM $1)
        AND ($2::text IS NULL OR id::text > $2)
      ORDER BY id::text
      LIMIT $3`,
    [keyVersion, cursor, batchSize],
  );

  const result: CallerLookupHashBackfillResult = {
    mode,
    keyVersion,
    scanned: rows.length,
    eligible: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    nextCursor: rows.length > 0 ? String(rows[rows.length - 1].id) : cursor,
    batchComplete: rows.length < batchSize,
  };
  const decrypt = dependencies.decrypt ?? decryptSensitiveField;

  for (const row of rows) {
    try {
      const id = String(row.id ?? '');
      const tenantId = String(row.tenant_id ?? '');
      const ciphertext = String(row.caller_number ?? '');
      if (!id || !tenantId || !ciphertext) {
        result.failed += 1;
        continue;
      }
      const phone = await decrypt(tenantId, ciphertext);
      const lookup = createPiiLookupHashRecord(tenantId, phone, 'caller_memory');
      if (!lookup || lookup.keyVersion !== keyVersion) {
        result.skipped += 1;
        continue;
      }
      result.eligible += 1;
      if (mode === 'dry-run') continue;
      const update = await client.query(
        `UPDATE call_sessions
            SET caller_lookup_hash = $3, caller_lookup_key_version = $4
          WHERE id = $1 AND tenant_id = $2 AND caller_number = $5
            AND (caller_lookup_hash IS DISTINCT FROM $3
                 OR caller_lookup_key_version IS DISTINCT FROM $4)`,
        [id, tenantId, lookup.hash, lookup.keyVersion, ciphertext],
      );
      if (update.rowCount === 1) result.updated += 1;
      else result.skipped += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
