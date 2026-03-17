import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('RESPONSE_CACHE');

const DEFAULT_TTL_SECONDS = 3600;

export interface CachedResponse {
  id: string;
  cacheKey: string;
  intent: string;
  responseText: string;
  hitCount: number;
}

function buildCacheKey(tenantId: string, intent: string, contextHash: string): string {
  return `${tenantId}:${intent}:${contextHash}`;
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

export async function getCachedResponse(
  tenantId: string,
  intent: string,
  contextText: string,
): Promise<CachedResponse | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});
    const cacheKey = buildCacheKey(tenantId, intent, simpleHash(contextText));
    const { rows } = await client.query(
      `UPDATE response_cache
       SET hit_count = hit_count + 1, last_hit_at = NOW()
       WHERE tenant_id = $1 AND cache_key = $2 AND expires_at > NOW()
       RETURNING id, cache_key, intent, response_text, hit_count`,
      [tenantId, cacheKey],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    logger.info('Cache hit', { tenantId, intent, cacheKey });
    return {
      id: row.id,
      cacheKey: row.cache_key,
      intent: row.intent,
      responseText: row.response_text,
      hitCount: row.hit_count,
    };
  } catch (err) {
    logger.error('Cache lookup failed', { tenantId, error: String(err) });
    return null;
  } finally {
    client.release();
  }
}

export async function setCachedResponse(
  tenantId: string,
  intent: string,
  contextText: string,
  responseText: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});
    const cacheKey = buildCacheKey(tenantId, intent, simpleHash(contextText));
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await client.query(
      `INSERT INTO response_cache (id, tenant_id, cache_key, intent, response_text, ttl_seconds, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, cache_key)
       DO UPDATE SET
         response_text = EXCLUDED.response_text,
         ttl_seconds = EXCLUDED.ttl_seconds,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [tenantId, cacheKey, intent, responseText, ttlSeconds, expiresAt.toISOString()],
    );
    logger.info('Cache entry set', { tenantId, intent, cacheKey, ttlSeconds });
  } catch (err) {
    logger.error('Failed to set cache entry', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}

export async function getCacheStats(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<{ totalHits: number; totalEntries: number; hitRate: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT
         COALESCE(SUM(hit_count), 0)::int as total_hits,
         COUNT(*)::int as total_entries
       FROM response_cache
       WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3`,
      [tenantId, from.toISOString(), to.toISOString()],
    );
    const totalHits = rows[0]?.total_hits ?? 0;
    const totalEntries = rows[0]?.total_entries ?? 0;
    return {
      totalHits,
      totalEntries,
      hitRate: totalHits > 0 ? Math.round((totalHits / (totalHits + totalEntries)) * 100) : 0,
    };
  } finally {
    client.release();
  }
}

export async function cleanExpiredCache(): Promise<number> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const { rowCount } = await client.query(
      `DELETE FROM response_cache WHERE expires_at < NOW()`,
    );
    if (rowCount && rowCount > 0) {
      logger.info('Cleaned expired cache entries', { count: rowCount });
    }
    return rowCount ?? 0;
  } finally {
    client.release();
  }
}
