import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  generateEmbeddingMock: vi.fn(),
  searchByEmbeddingMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ connect: async () => ({ query: a.queryMock, release: a.releaseMock }) }),
  withTenantContext: async (_c: unknown, _t: string, cb: () => Promise<void>) => cb(),
}));
vi.mock('../../../platform/knowledge/embeddingService', () => ({
  generateEmbedding: a.generateEmbeddingMock,
  searchByEmbedding: a.searchByEmbeddingMock,
}));

import router from './knowledgeBase';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.releaseMock.mockReset();
  a.generateEmbeddingMock.mockReset().mockResolvedValue([0.1, 0.2]);
  a.searchByEmbeddingMock.mockReset().mockResolvedValue([]);
});

describe('GET /knowledge-articles', () => {
  it('lists articles with total + categories', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('ORDER BY created_at DESC LIMIT')) return { rows: [{ id: 'a1', title: 'T' }] };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: '1' }] };
      if (sql.includes('DISTINCT category')) return { rows: [{ category: 'FAQ' }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/knowledge-articles?category=FAQ&limit=10');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, categories: ['FAQ'] });
  });

  it('returns 500 and rolls back on error', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/knowledge-articles')).status).toBe(500);
  });
});

describe('GET /knowledge-articles/:id', () => {
  it('returns an article', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('WHERE id = $1 AND tenant_id = $2') ? { rows: [{ id: 'a1' }] } : { rows: [] },
    );
    expect((await request(app()).get('/knowledge-articles/a1')).body.article).toMatchObject({ id: 'a1' });
  });
  it('404 when missing', async () => {
    expect((await request(app()).get('/knowledge-articles/x')).status).toBe(404);
  });
});

describe('POST /knowledge-articles', () => {
  it('validates title/content/status', async () => {
    expect((await request(app()).post('/knowledge-articles').send({ content: 'c' })).status).toBe(400);
    expect((await request(app()).post('/knowledge-articles').send({ title: 't' })).status).toBe(400);
    expect((await request(app()).post('/knowledge-articles').send({ title: 't', content: 'c', status: 'weird' })).status).toBe(400);
  });
  it('rejects a viewer via rbac', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/knowledge-articles').send({ title: 't', content: 'c' })).status).toBe(403);
  });
  it('creates an article (embeds title+content)', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO knowledge_articles') ? { rows: [{ id: 'a9', title: 't' }] } : { rows: [] },
    );
    const res = await request(app()).post('/knowledge-articles').send({ title: 't', content: 'c', category: 'FAQ' });
    expect(res.status).toBe(201);
    expect(a.generateEmbeddingMock).toHaveBeenCalled();
  });
  it('still creates when embedding generation fails', async () => {
    a.generateEmbeddingMock.mockRejectedValue(new Error('emb down'));
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO knowledge_articles') ? { rows: [{ id: 'a9' }] } : { rows: [] },
    );
    expect((await request(app()).post('/knowledge-articles').send({ title: 't', content: 'c' })).status).toBe(201);
  });
});

describe('PATCH /knowledge-articles/:id', () => {
  it('rejects an empty update', async () => {
    expect((await request(app()).patch('/knowledge-articles/a1').send({})).status).toBe(400);
  });
  it('updates + re-embeds on content change', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT title, content FROM knowledge_articles')) return { rows: [{ title: 'old', content: 'old' }] };
      if (sql.includes('UPDATE knowledge_articles SET')) return { rows: [{ id: 'a1', title: 'new' }] };
      return { rows: [] };
    });
    const res = await request(app()).patch('/knowledge-articles/a1').send({ content: 'new body' });
    expect(res.status).toBe(200);
    expect(a.generateEmbeddingMock).toHaveBeenCalled();
  });
  it('404 when the update matches no row', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE knowledge_articles SET') ? { rows: [] } : { rows: [] },
    );
    expect((await request(app()).patch('/knowledge-articles/x').send({ status: 'archived' })).status).toBe(404);
  });
});

describe('DELETE /knowledge-articles/:id', () => {
  it('deletes an article', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('DELETE FROM knowledge_articles') ? { rows: [], rowCount: 1 } : { rows: [] },
    );
    expect((await request(app()).delete('/knowledge-articles/a1')).body).toEqual({ deleted: true });
  });
  it('404 when nothing deleted', async () => {
    expect((await request(app()).delete('/knowledge-articles/x')).status).toBe(404);
  });
});

describe('POST /knowledge-articles/search', () => {
  it('requires a query', async () => {
    expect((await request(app()).post('/knowledge-articles/search').send({})).status).toBe(400);
  });
  it('returns 503 when embedding is unavailable', async () => {
    a.generateEmbeddingMock.mockRejectedValue(new Error('down'));
    expect((await request(app()).post('/knowledge-articles/search').send({ query: 'hi' })).status).toBe(503);
  });
  it('returns ranked results', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes("status = 'active'") ? { rows: [{ id: 1, title: 'T', content: 'C', category: null, embedding: [0.1] }] } : { rows: [] },
    );
    a.searchByEmbeddingMock.mockResolvedValue([{ id: 1, score: 0.9 }]);
    const res = await request(app()).post('/knowledge-articles/search').send({ query: 'hours', top_k: 3 });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });
});
