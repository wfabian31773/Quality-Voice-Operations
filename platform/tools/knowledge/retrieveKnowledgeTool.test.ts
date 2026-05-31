import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  generateEmbeddingMock: vi.fn(),
  searchByEmbeddingMock: vi.fn(),
  getCachedResponseMock: vi.fn(),
  setCachedResponseMock: vi.fn(),
  recordSessionCacheHitMock: vi.fn(),
  recordSessionCacheMissMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: h.queryMock, release: h.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../knowledge/embeddingService', () => ({
  generateEmbedding: h.generateEmbeddingMock,
  searchByEmbedding: h.searchByEmbeddingMock,
}));
vi.mock('../../billing/cost/ResponseCache', () => ({
  getCachedResponse: h.getCachedResponseMock,
  setCachedResponse: h.setCachedResponseMock,
}));
vi.mock('../../billing/cost', () => ({
  recordSessionCacheHit: h.recordSessionCacheHitMock,
  recordSessionCacheMiss: h.recordSessionCacheMissMock,
}));

import { globalToolRegistry } from '../registry';
import { registerRetrieveKnowledgeTool } from './retrieveKnowledgeTool';

registerRetrieveKnowledgeTool();
const tool = globalToolRegistry.get('retrieve_knowledge')!;
const ctx = { tenantId: 'tenant-1', callLogId: 'cs-1' };

beforeEach(() => {
  for (const fn of Object.values(h)) (fn as ReturnType<typeof vi.fn>).mockReset();
  h.queryMock.mockResolvedValue({ rows: [] });
  h.generateEmbeddingMock.mockResolvedValue([0.1, 0.2, 0.3]);
  h.searchByEmbeddingMock.mockResolvedValue([]);
  h.getCachedResponseMock.mockResolvedValue(null);
  h.setCachedResponseMock.mockResolvedValue(undefined);
});

describe('retrieve_knowledge tool', () => {
  it('requires a query string', async () => {
    const r = (await tool.handler({}, ctx)) as { success: boolean; message: string };
    expect(r.success).toBe(false);
    expect(r.message).toContain('query is required');
  });

  it('returns the cached response on a cache hit', async () => {
    h.getCachedResponseMock.mockResolvedValue({ responseText: JSON.stringify({ success: true, cached: true }) });
    const r = (await tool.handler({ query: 'refund policy' }, ctx)) as { cached: boolean };
    expect(r.cached).toBe(true);
    expect(h.recordSessionCacheHitMock).toHaveBeenCalledWith('cs-1');
    expect(h.generateEmbeddingMock).not.toHaveBeenCalled();
  });

  it('reports when the embedding service is unavailable', async () => {
    h.generateEmbeddingMock.mockRejectedValue(new Error('embeddings down'));
    const r = (await tool.handler({ query: 'hours' }, ctx)) as { success: boolean; message: string };
    expect(r.success).toBe(false);
    expect(r.message).toContain('Embedding service unavailable');
    expect(h.recordSessionCacheMissMock).toHaveBeenCalledWith('cs-1');
  });

  it('returns found:false when nothing matches', async () => {
    h.searchByEmbeddingMock.mockResolvedValue([]);
    const r = (await tool.handler({ query: 'unknown topic' }, ctx)) as { success: boolean; found: boolean };
    expect(r.success).toBe(true);
    expect(r.found).toBe(false);
  });

  it('returns ranked results and caches the response when matches are found', async () => {
    h.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('knowledge_articles')) return { rows: [{ id: 1, title: 'Refunds', content: '30 days', category: 'Policies', embedding: [0.1] }] };
      if (sql.includes('knowledge_chunks')) return { rows: [] };
      return { rows: [] };
    });
    h.searchByEmbeddingMock.mockResolvedValue([{ title: 'Refunds', content: '30 days', category: 'Policies', score: 0.92 }]);
    const r = (await tool.handler({ query: 'refund policy', category: 'Policies' }, ctx)) as {
      found: boolean;
      results: Array<{ title: string; relevance: number }>;
    };
    expect(r.found).toBe(true);
    expect(r.results[0]).toMatchObject({ title: 'Refunds', relevance: 92 });
    expect(h.setCachedResponseMock).toHaveBeenCalled();
  });

  it('returns a safe error when the DB query throws', async () => {
    h.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK|COMMIT)/i.test(sql)) return { rows: [] };
      throw new Error('db exploded');
    });
    const r = (await tool.handler({ query: 'anything' }, ctx)) as { success: boolean; message: string };
    expect(r.success).toBe(false);
    expect(r.message).toContain('Knowledge retrieval failed');
  });
});
