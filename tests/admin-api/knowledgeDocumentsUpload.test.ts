/**
 * Coverage for the tightened Knowledge Base upload validation:
 * - Rejects non-PDF MIME types via Multer fileFilter (415)
 * - Rejects non-.pdf extensions via Multer fileFilter (415)
 * - Rejects oversized uploads via Multer limits (413)
 * - Rejects files whose magic bytes don't match a real PDF (415)
 * - Accepts a real PDF (passes validation, reaches DB layer)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ connect: connectMock }),
  withTenantContext: vi.fn(async (_client: unknown, _tenantId: unknown, fn: () => Promise<void>) => {
    await fn();
  }),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const processDocumentMock = vi.fn(async () => undefined);
vi.mock('../../platform/knowledge/ingestionPipeline', () => ({
  processDocument: (...args: unknown[]) => processDocumentMock(...args),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      userId: 'user-1',
      tenantId: 'tenant-A',
      email: 'owner@acme.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    } as unknown as express.Request['user'];
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

async function buildApp(): Promise<express.Express> {
  const router = (await import('../../server/admin-api/routes/knowledgeDocuments')).default;
  const app = express();
  app.use(router);
  return app;
}

function pdfBuffer(size = 256): Buffer {
  // Minimal PDF magic bytes followed by padding so the buffer has a realistic length.
  const header = Buffer.from('%PDF-1.4\n', 'utf8');
  const padding = Buffer.alloc(Math.max(0, size - header.length), 0x20);
  return Buffer.concat([header, padding]);
}

describe('Knowledge Base upload tightening', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    processDocumentMock.mockReset();

    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql).trim().toUpperCase();
      if (text.startsWith('BEGIN') || text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith('INSERT INTO KNOWLEDGE_DOCUMENTS')) {
        return {
          rows: [{
            id: 42,
            tenant_id: 'tenant-A',
            title: 'doc',
            source_type: 'pdf',
            category: null,
            status: 'processing',
            file_name: 'file.pdf',
            file_size: 256,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it('rejects uploads with a non-PDF MIME type', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/knowledge-documents/upload')
      .attach('file', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' });

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/Only PDF files are allowed/i);
    expect(processDocumentMock).not.toHaveBeenCalled();
  });

  it('rejects uploads with a non-.pdf extension even if MIME is forged', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/knowledge-documents/upload')
      .attach('file', pdfBuffer(), { filename: 'sneaky.exe', contentType: 'application/pdf' });

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/extension/i);
    expect(processDocumentMock).not.toHaveBeenCalled();
  });

  it('rejects uploads whose magic bytes do not match a real PDF', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/knowledge-documents/upload')
      .attach('file', Buffer.from('this is not a pdf, but I claim it is'), {
        filename: 'fake.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/do not match a PDF/i);
    expect(processDocumentMock).not.toHaveBeenCalled();
  });

  it('rejects uploads larger than the 10MB cap', async () => {
    const app = await buildApp();
    const big = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'utf8'),
      Buffer.alloc(10 * 1024 * 1024 + 1, 0x20),
    ]);
    const res = await request(app)
      .post('/knowledge-documents/upload')
      .attach('file', big, { filename: 'big.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
    expect(processDocumentMock).not.toHaveBeenCalled();
  });

  it('accepts a valid PDF with matching MIME, extension, and magic bytes', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/knowledge-documents/upload')
      .field('title', 'My Doc')
      .attach('file', pdfBuffer(1024), { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.document).toBeDefined();
    expect(processDocumentMock).toHaveBeenCalledTimes(1);
    expect(processDocumentMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-A',
      sourceType: 'pdf',
    });
  });
});
