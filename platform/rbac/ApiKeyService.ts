import { randomBytes, createHash } from 'crypto';
import { getPlatformPool, withPrivilegedClient, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('API_KEY_SERVICE');

const KEY_PREFIX = 'vai_';

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface ValidatedApiKey {
  tenantId: string;
  keyId: string;
  scopes: string[];
}

export async function generateApiKey(
  tenantId: string,
  name: string,
  scopes: string[] = ['*'],
  expiresAt: Date | null = null,
): Promise<{ key: ApiKeyRecord; plaintextKey: string }> {
  const rawKey = `${KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  const pool = getPlatformPool();
  const client = await pool.connect();
  let rows: Record<string, unknown>[];
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const inserted = await client.query(
      `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, name, key_prefix, scopes, last_used_at, expires_at, created_at, revoked_at`,
      [tenantId, name, keyHash, keyPrefix, JSON.stringify(scopes), expiresAt],
    );
    rows = inserted.rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const row = rows[0];
  logger.info('API key generated', { tenantId, keyId: row.id as string, name });

  return {
    key: {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      name: row.name as string,
      keyPrefix: row.key_prefix as string,
      scopes: row.scopes as string[],
      lastUsedAt: row.last_used_at as string | null,
      expiresAt: row.expires_at as string | null,
      createdAt: row.created_at as string,
      revokedAt: row.revoked_at as string | null,
    },
    plaintextKey: rawKey,
  };
}

export async function validateApiKey(rawKey: string): Promise<ValidatedApiKey | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;

  const keyHash = hashKey(rawKey);

  try {
    return await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, scopes, expires_at, revoked_at
         FROM api_keys
         WHERE key_hash = $1`,
        [keyHash],
      );

      if (rows.length === 0) return null;

      const row = rows[0];
      if (row.revoked_at) return null;
      if (row.expires_at && new Date(row.expires_at as string) < new Date()) return null;

      await client.query(
        `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
        [row.id],
      );

      return {
        tenantId: row.tenant_id as string,
        keyId: row.id as string,
        scopes: row.scopes as string[],
      };
    });
  } catch (err) {
    logger.error('Failed to validate API key', { error: String(err) });
    return null;
  }
}

export async function listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  let rows: Record<string, unknown>[];
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const listed = await client.query(
      `SELECT id, tenant_id, name, key_prefix, scopes, last_used_at, expires_at, created_at, revoked_at
       FROM api_keys
       WHERE tenant_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [tenantId],
    );
    rows = listed.rows;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return rows.map((row) => ({
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    keyPrefix: row.key_prefix as string,
    scopes: row.scopes as string[],
    lastUsedAt: row.last_used_at as string | null,
    expiresAt: row.expires_at as string | null,
    createdAt: row.created_at as string,
    revokedAt: row.revoked_at as string | null,
  }));
}

export async function revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  let rowCount: number | null | undefined;
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const updated = await client.query(
      `UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
      [keyId, tenantId],
    );
    rowCount = updated.rowCount;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (rowCount && rowCount > 0) {
    logger.info('API key revoked', { tenantId, keyId });
    return true;
  }
  return false;
}
