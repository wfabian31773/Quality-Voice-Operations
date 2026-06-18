import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  releaseMock: vi.fn(),
  processDocumentMock: vi.fn(),
  isPrivateHostMock: vi.fn(),
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
vi.mock('../../../platform/knowledge/ingestionPipeline', () => ({ processDocument: a.processDocumentMock }));
vi.mock('../../../platform/knowledge/pdfSecurityScanner', () => ({ scanPdfBuffer: vi.fn(), buildRejectionMessage: () => 'rejected' }));
vi.mock('../../../platform/security/privateHostBlocklist', () => ({ isPrivateOrInternalHost: a.isPrivateHostMock }));

import router from './knowledgeDocuments';

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
  a.processDocumentMock.mockReset().mockResolvedValue(undefined);
  a.isPrivateHostMock.mockReset().mockReturnValue(false);
});

describe('GET /knowledge-documents', () => {
  it('lists documents (with source_type filter)', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM knowledge_documents WHERE tenant_id = $1') && sql.includes('ORDER BY')
        ? { rows: [{ id: 'd1', title: 'Doc' }] } : { rows: [] },
    );
    expect((await request(app()).get('/knowledge-documents?source_type=url')).body.documents).toHaveLength(1);
  });
  it('500 on error', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (/^\s*(BEGIN|ROLLBACK)/i.test(sql)) return { rows: [] };
      throw new Error('db down');
    });
    expect((await request(app()).get('/knowledge-documents')).status).toBe(500);
  });
});

describe('GET /knowledge-documents/:id', () => {
  it('404 when missing', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('WHERE id = $1 AND tenant_id = $2') ? { rows: [] } : { rows: [] },
    );
    expect((await request(app()).get('/knowledge-documents/d1')).status).toBe(404);
  });
  it('returns the document with chunks', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM knowledge_documents WHERE id = $1')) return { rows: [{ id: 'd1' }] };
      if (sql.includes('FROM knowledge_chunks')) return { rows: [{ id: 'ch1', chunk_index: 0 }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/knowledge-documents/d1');
    expect(res.body.document).toMatchObject({ id: 'd1' });
    expect(res.body.chunks).toHaveLength(1);
  });
});

describe('POST /knowledge-documents/url', () => {
  it('requires a url', async () => {
    expect((await request(app()).post('/knowledge-documents/url').send({})).status).toBe(400);
  });
  it('rejects an invalid URL', async () => {
    expect((await request(app()).post('/knowledge-documents/url').send({ url: 'not a url' })).status).toBe(400);
  });
  it('rejects a non-http(s) protocol', async () => {
    expect((await request(app()).post('/knowledge-documents/url').send({ url: 'ftp://x.com/f' })).status).toBe(400);
  });
  it('rejects a private/internal host (SSRF guard)', async () => {
    a.isPrivateHostMock.mockReturnValue(true);
    expect((await request(app()).post('/knowledge-documents/url').send({ url: 'http://169.254.169.254/' })).status).toBe(400);
  });
  it('rejects a viewer via rbac', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/knowledge-documents/url').send({ url: 'https://x.com' })).status).toBe(403);
  });
  it('creates a URL document and kicks off processing', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO knowledge_documents') ? { rows: [{ id: 'd9', source_type: 'url' }] } : { rows: [] },
    );
    const res = await request(app()).post('/knowledge-documents/url').send({ url: 'https://example.com/doc', title: 'Doc' });
    expect(res.status).toBe(201);
    expect(a.processDocumentMock).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'url' }));
  });
});

describe('POST /knowledge-documents/text', () => {
  it('requires title and content', async () => {
    expect((await request(app()).post('/knowledge-documents/text').send({ title: 'T' })).status).toBe(400);
  });
  it('creates a text document', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO knowledge_documents') ? { rows: [{ id: 'd9', source_type: 'text' }] } : { rows: [] },
    );
    const res = await request(app()).post('/knowledge-documents/text').send({ title: 'T', content: 'hello world' });
    expect(res.status).toBe(201);
    expect(a.processDocumentMock).toHaveBeenCalled();
  });
});

describe('DELETE /knowledge-documents/:id', () => {
  it('deletes a document', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('DELETE FROM knowledge_documents') ? { rows: [], rowCount: 1 } : { rows: [] },
    );
    expect((await request(app()).delete('/knowledge-documents/d1')).body).toEqual({ deleted: true });
  });
  it('404 when nothing deleted', async () => {
    expect((await request(app()).delete('/knowledge-documents/ghost')).status).toBe(404);
  });
});
