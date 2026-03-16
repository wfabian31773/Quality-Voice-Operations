import { globalToolRegistry } from '../registry';
import type { ToolContext } from '../registry/types';
import { getPlatformPool, withTenantContext } from '../../db';
import { generateEmbedding, searchByEmbedding } from '../../knowledge/embeddingService';
import { createLogger } from '../../core/logger';

const logger = createLogger('RETRIEVE_KNOWLEDGE_TOOL');

async function handleRetrieveKnowledge(
  input: unknown,
  context: ToolContext,
): Promise<unknown> {
  const { tenantId } = context;
  const args = input as { query: string; category?: string; top_k?: number };

  if (!args.query || typeof args.query !== 'string') {
    return { success: false, message: 'query is required' };
  }

  let queryEmbedding: number[];
  try {
    queryEmbedding = await generateEmbedding(args.query);
  } catch (err) {
    logger.error('Embedding generation failed in tool', { tenantId, error: String(err) });
    return { success: false, message: 'Embedding service unavailable' };
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    let sql = `SELECT id, title, content, category, embedding FROM knowledge_articles WHERE tenant_id = $1 AND status = 'active'`;
    const values: unknown[] = [tenantId];
    if (args.category) {
      values.push(args.category);
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

    const results = await searchByEmbedding(queryEmbedding, articles, args.top_k ?? 3);

    if (results.length === 0) {
      return { success: true, found: false, message: 'No relevant knowledge base articles found.' };
    }

    const context_items = results.map((r) => ({
      title: r.title,
      content: r.content,
      category: r.category,
      relevance: Math.round(r.score * 100),
    }));

    return {
      success: true,
      found: true,
      results: context_items,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Knowledge retrieval failed', { tenantId, error: String(err) });
    return { success: false, message: 'Knowledge retrieval failed' };
  } finally {
    client.release();
  }
}

export function registerRetrieveKnowledgeTool(): void {
  globalToolRegistry.register({
    name: 'retrieve_knowledge',
    description: 'Search the company knowledge base for relevant articles, FAQs, and documentation. Use this when you need to find information to answer a caller\'s question about products, services, policies, or procedures.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query describing what information you need',
        },
        category: {
          type: 'string',
          description: 'Optional category to filter results (e.g., "faq", "policy", "product")',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of results to return (default: 3)',
        },
      },
      required: ['query'],
    },
    handler: handleRetrieveKnowledge,
  });

  logger.info('retrieve_knowledge tool registered');
}
