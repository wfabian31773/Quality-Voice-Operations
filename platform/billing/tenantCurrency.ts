import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('TENANT_CURRENCY');

const DEFAULT_CURRENCY = 'usd';

const cache = new Map<string, { currency: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export function normalizeCurrencyCode(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return DEFAULT_CURRENCY;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length !== 3) return DEFAULT_CURRENCY;
  return trimmed;
}

export async function getTenantBillingCurrency(tenantId: string): Promise<string> {
  if (!tenantId) return DEFAULT_CURRENCY;

  const cached = cache.get(tenantId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.currency;
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);
    const { rows } = await client.query(
      `SELECT COALESCE(billing_currency, 'usd') AS billing_currency FROM tenants WHERE id = $1`,
      [tenantId],
    );
    await client.query('COMMIT');
    const currency = normalizeCurrencyCode(rows[0]?.billing_currency as string | undefined);
    cache.set(tenantId, { currency, expiresAt: now + CACHE_TTL_MS });
    return currency;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    logger.warn('Failed to look up tenant billing currency, defaulting to USD', {
      tenantId,
      error: String(err),
    });
    return DEFAULT_CURRENCY;
  } finally {
    client.release();
  }
}

export function invalidateTenantCurrencyCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}
