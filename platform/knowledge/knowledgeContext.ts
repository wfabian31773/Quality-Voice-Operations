import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';

const logger = createLogger('KNOWLEDGE_CONTEXT');

export async function hasKnowledgeArticles(tenantId: TenantId): Promise<boolean> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT 1 FROM knowledge_articles WHERE tenant_id = $1 AND status = 'active' LIMIT 1`,
      [tenantId],
    );
    await client.query('COMMIT');

    return rows.length > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to check knowledge articles', { tenantId, error: String(err) });
    return false;
  } finally {
    client.release();
  }
}
