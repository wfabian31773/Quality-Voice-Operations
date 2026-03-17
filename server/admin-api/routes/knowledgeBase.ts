import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { generateEmbedding, searchByEmbedding } from '../../../platform/knowledge/embeddingService';

const router = Router();
const logger = createLogger('ADMIN_KNOWLEDGE_BASE');

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

router.get('/knowledge-articles', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const category = req.query.category as string | undefined;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    let query = `SELECT id, tenant_id, title, content, category, metadata, status, created_at, updated_at
       FROM knowledge_articles WHERE tenant_id = $1`;
    const values: unknown[] = [tenantId];

    if (category) {
      values.push(category);
      query += ` AND category = $${values.length}`;
    }

    query += ` ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
    values.push(limit, offset);

    const { rows } = await client.query(query, values);

    const countValues: unknown[] = [tenantId];
    let countQuery = `SELECT COUNT(*) AS total FROM knowledge_articles WHERE tenant_id = $1`;
    if (category) {
      countValues.push(category);
      countQuery += ` AND category = $${countValues.length}`;
    }
    const { rows: countRows } = await client.query(countQuery, countValues);

    const { rows: catRows } = await client.query(
      `SELECT DISTINCT category FROM knowledge_articles WHERE tenant_id = $1 AND category IS NOT NULL ORDER BY category`,
      [tenantId],
    );
    await client.query('COMMIT');

    return res.json({
      articles: rows,
      total: parseInt(countRows[0].total as string),
      categories: catRows.map((r: Record<string, unknown>) => r.category),
      limit,
      offset,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list knowledge articles', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list knowledge articles' });
  } finally {
    client.release();
  }
});

router.get('/knowledge-articles/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, tenant_id, title, content, category, metadata, status, created_at, updated_at
       FROM knowledge_articles WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (rows.length === 0) return res.status(404).json({ error: 'Article not found' });
    return res.json({ article: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to retrieve article' });
  } finally {
    client.release();
  }
});

router.post('/knowledge-articles', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as Record<string, unknown>;
  const { title, content, category, metadata = {}, status = 'active' } = body;

  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content is required' });

  const validStatuses = ['active', 'draft', 'archived'];
  if (!validStatuses.includes(status as string)) return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    let embedding: number[] = [];
    try {
      embedding = await generateEmbedding(`${title}\n\n${content}`);
    } catch (embErr) {
      logger.warn('Embedding generation failed, storing without embedding', { tenantId, error: String(embErr) });
    }

    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `INSERT INTO knowledge_articles (tenant_id, title, content, category, metadata, embedding, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, tenant_id, title, content, category, metadata, status, created_at, updated_at`,
      [tenantId, title, content, category ?? null, JSON.stringify(metadata), JSON.stringify(embedding), status],
    );
    await client.query('COMMIT');

    logger.info('Knowledge article created', { tenantId, articleId: rows[0].id });
    return res.status(201).json({ article: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to create knowledge article', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create knowledge article' });
  } finally {
    client.release();
  }
});

router.patch('/knowledge-articles/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const body = req.body as Record<string, unknown>;

  const allowed = ['title', 'content', 'category', 'metadata', 'status'];
  const updates: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [id, tenantId];

  for (const key of allowed) {
    if (key in body) {
      const val = key === 'metadata' ? JSON.stringify(body[key]) : body[key];
      values.push(val);
      updates.push(`${key} = $${values.length}`);
    }
  }

  if (updates.length === 1) return res.status(400).json({ error: 'No valid fields to update' });

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const needsReEmbed = 'title' in body || 'content' in body;
    let embedding: number[] | null = null;

    if (needsReEmbed) {
      const titleVal = body.title as string | undefined;
      const contentVal = body.content as string | undefined;

      const { rows: existing } = await client.query(
        `SELECT title, content FROM knowledge_articles WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      if (existing.length > 0) {
        const finalTitle = titleVal ?? existing[0].title as string;
        const finalContent = contentVal ?? existing[0].content as string;
        try {
          embedding = await generateEmbedding(`${finalTitle}\n\n${finalContent}`);
        } catch (embErr) {
          logger.warn('Re-embedding failed on update', { tenantId, articleId: id, error: String(embErr) });
        }
      }
    }

    if (embedding) {
      values.push(JSON.stringify(embedding));
      updates.push(`embedding = $${values.length}`);
    }

    const { rows } = await client.query(
      `UPDATE knowledge_articles SET ${updates.join(', ')} WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, title, content, category, metadata, status, created_at, updated_at`,
      values,
    );
    await client.query('COMMIT');

    if (rows.length === 0) return res.status(404).json({ error: 'Article not found' });
    return res.json({ article: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update knowledge article', { tenantId, articleId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to update knowledge article' });
  } finally {
    client.release();
  }
});

router.delete('/knowledge-articles/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rowCount } = await client.query(
      `DELETE FROM knowledge_articles WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (!rowCount) return res.status(404).json({ error: 'Article not found' });
    logger.info('Knowledge article deleted', { tenantId, articleId: id });
    return res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to delete article' });
  } finally {
    client.release();
  }
});

router.post('/knowledge-articles/search', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const body = req.body as { query: string; top_k?: number; category?: string };
  const { query, category } = body;
  const top_k = Math.min(Math.max(parseInt(String(body.top_k ?? '5'), 10) || 5, 1), 20);

  if (!query || typeof query !== 'string') return res.status(400).json({ error: 'query is required' });

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await generateEmbedding(query);
    } catch {
      return res.status(503).json({ error: 'Embedding service unavailable' });
    }

    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    let sql = `SELECT id, title, content, category, embedding FROM knowledge_articles WHERE tenant_id = $1 AND status = 'active'`;
    const values: unknown[] = [tenantId];
    if (category) {
      values.push(category);
      sql += ` AND category = $${values.length}`;
    }

    const { rows } = await client.query(sql, values);
    await client.query('COMMIT');

    const articles = rows.map((r: Record<string, unknown>) => ({
      id: r.id as number,
      title: r.title as string,
      content: r.content as string,
      category: r.category as string | null,
      embedding: (typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding) as number[] | null,
    }));

    const results = await searchByEmbedding(queryEmbedding, articles, top_k);
    return res.json({ results });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Knowledge search failed', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Search failed' });
  } finally {
    client.release();
  }
});

export default router;
