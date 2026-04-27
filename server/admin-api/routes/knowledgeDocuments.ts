import { Router } from 'express';
import multer from 'multer';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { processDocument } from '../../../platform/knowledge/ingestionPipeline';
import { scanPdfBuffer, buildRejectionMessage } from '../../../platform/knowledge/pdfSecurityScanner';

const router = Router();
const logger = createLogger('ADMIN_KNOWLEDGE_DOCUMENTS');

const ALLOWED_MIME_TYPES = new Set<string>(['application/pdf']);
const ALLOWED_EXTENSIONS = new Set<string>(['.pdf']);

type MagicByteSignature = {
  mime: string;
  bytes: number[];
  offset?: number;
};

const MAGIC_BYTE_SIGNATURES: MagicByteSignature[] = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

function detectMimeFromMagicBytes(buffer: Buffer): string | null {
  for (const sig of MAGIC_BYTE_SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (buffer.length < offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return sig.mime;
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = getFileExtension(file.originalname);
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error(`Unsupported file type "${file.mimetype}". Only PDF files are allowed.`));
    }
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error(`Unsupported file extension "${ext}". Only .pdf files are allowed.`));
    }
    cb(null, true);
  },
});

function handleUploadError(err: unknown, res: import('express').Response): boolean {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File is too large. Maximum size is 10 MB.' });
      return true;
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({ error: 'Only a single file upload is allowed.' });
      return true;
    }
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof Error) {
    res.status(415).json({ error: err.message });
    return true;
  }
  return false;
}

function uploadSingle(field: string): import('express').RequestHandler {
  const handler = upload.single(field);
  return (req, res, next) => {
    handler(req, res, (err) => {
      if (err) {
        if (handleUploadError(err, res)) return;
        return next(err);
      }
      next();
    });
  };
}

const VALID_CATEGORIES = ['FAQ', 'Services', 'Policies', 'Pricing', 'Procedures', 'Troubleshooting'];

router.get('/knowledge-documents', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const sourceType = req.query.source_type as string | undefined;
    let sql = `SELECT id, tenant_id, title, source_type, source_url, category, status, error_message, file_name, file_size, chunk_count, metadata, created_at, updated_at
       FROM knowledge_documents WHERE tenant_id = $1`;
    const values: unknown[] = [tenantId];

    if (sourceType) {
      values.push(sourceType);
      sql += ` AND source_type = $${values.length}`;
    }

    sql += ` ORDER BY created_at DESC`;

    const { rows } = await client.query(sql, values);
    await client.query('COMMIT');

    return res.json({ documents: rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to list knowledge documents', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list knowledge documents' });
  } finally {
    client.release();
  }
});

router.get('/knowledge-documents/:id', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, tenant_id, title, source_type, source_url, category, status, error_message, file_name, file_size, chunk_count, metadata, created_at, updated_at
       FROM knowledge_documents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Document not found' });
    }

    const { rows: chunks } = await client.query(
      `SELECT id, chunk_index, content, metadata, created_at
       FROM knowledge_chunks WHERE document_id = $1 AND tenant_id = $2 ORDER BY chunk_index`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    return res.json({ document: rows[0], chunks });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: 'Failed to retrieve document' });
  } finally {
    client.release();
  }
});

router.post('/knowledge-documents/upload', requireAuth, requireRole('manager'), uploadSingle('file'), async (req, res) => {
  const { tenantId } = req.user!;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'PDF file is required' });

  const detectedMime = detectMimeFromMagicBytes(file.buffer);
  if (detectedMime !== 'application/pdf') {
    logger.warn('Rejected upload with mismatched magic bytes', {
      tenantId,
      claimedMime: file.mimetype,
      filename: file.originalname,
      detectedMime,
    });
    return res.status(415).json({
      error: 'File contents do not match a PDF. Only valid PDF files are accepted.',
    });
  }

  const scan = await scanPdfBuffer(file.buffer);
  if (scan.verdict !== 'clean') {
    logger.warn('Rejected PDF upload that failed malware scan', {
      tenantId,
      filename: file.originalname,
      detector: scan.detector,
      verdict: scan.verdict,
      reason: scan.reason,
      findings: scan.findings,
    });
    return res.status(422).json({ error: buildRejectionMessage(scan) });
  }

  const title = (req.body.title as string) || file.originalname.replace(/\.pdf$/i, '');
  const category = req.body.category as string | undefined;

  if (category && !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `INSERT INTO knowledge_documents (tenant_id, title, source_type, category, status, file_name, file_size, raw_file)
       VALUES ($1, $2, 'pdf', $3, 'processing', $4, $5, $6)
       RETURNING id, tenant_id, title, source_type, category, status, file_name, file_size, created_at, updated_at`,
      [tenantId, title, category ?? null, file.originalname, file.size, file.buffer],
    );
    await client.query('COMMIT');

    const doc = rows[0];
    logger.info('PDF document uploaded, starting processing', { tenantId, documentId: doc.id });

    processDocument({
      tenantId,
      documentId: doc.id,
      sourceType: 'pdf',
      fileBuffer: file.buffer,
    }).catch((err) => {
      logger.error('Background PDF processing failed', { documentId: doc.id, error: String(err) });
    });

    return res.status(201).json({ document: doc });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to upload PDF', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to upload document' });
  } finally {
    client.release();
  }
});

router.post('/knowledge-documents/url', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { url, title, category } = req.body as { url?: string; title?: string; category?: string };

  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are supported' });
  }

  const blockedHosts = ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'metadata.google.internal', 'instance-data'];
  if (
    blockedHosts.includes(parsedUrl.hostname) ||
    parsedUrl.hostname.endsWith('.local') ||
    parsedUrl.hostname.endsWith('.internal') ||
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|127\.)/.test(parsedUrl.hostname)
  ) {
    return res.status(400).json({ error: 'URLs pointing to private or internal networks are not allowed' });
  }

  if (category && !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const docTitle = title || new URL(url).hostname;
    const { rows } = await client.query(
      `INSERT INTO knowledge_documents (tenant_id, title, source_type, source_url, category, status)
       VALUES ($1, $2, 'url', $3, $4, 'processing')
       RETURNING id, tenant_id, title, source_type, source_url, category, status, created_at, updated_at`,
      [tenantId, docTitle, url, category ?? null],
    );
    await client.query('COMMIT');

    const doc = rows[0];
    logger.info('URL document created, starting processing', { tenantId, documentId: doc.id });

    processDocument({
      tenantId,
      documentId: doc.id,
      sourceType: 'url',
      url,
    }).catch((err) => {
      logger.error('Background URL processing failed', { documentId: doc.id, error: String(err) });
    });

    return res.status(201).json({ document: doc });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to create URL document', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create document' });
  } finally {
    client.release();
  }
});

router.post('/knowledge-documents/text', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { title, content, category, source_type } = req.body as {
    title?: string;
    content?: string;
    category?: string;
    source_type?: string;
  };

  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content is required' });

  const docType = source_type === 'faq' ? 'faq' : 'text';

  if (category && !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `INSERT INTO knowledge_documents (tenant_id, title, source_type, category, status, file_size, raw_content)
       VALUES ($1, $2, $3, $4, 'processing', $5, $6)
       RETURNING id, tenant_id, title, source_type, category, status, created_at, updated_at`,
      [tenantId, title, docType, category ?? null, Buffer.byteLength(content, 'utf8'), content],
    );
    await client.query('COMMIT');

    const doc = rows[0];
    logger.info('Text document created, starting processing', { tenantId, documentId: doc.id });

    processDocument({
      tenantId,
      documentId: doc.id,
      sourceType: docType,
      content,
    }).catch((err) => {
      logger.error('Background text processing failed', { documentId: doc.id, error: String(err) });
    });

    return res.status(201).json({ document: doc });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to create text document', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create document' });
  } finally {
    client.release();
  }
});

router.post('/knowledge-documents/:id/reindex', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, source_type, source_url, raw_content, raw_file, file_name FROM knowledge_documents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = rows[0];

    await client.query(
      `UPDATE knowledge_documents SET status = 'processing', error_message = NULL, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (doc.source_type === 'pdf') {
      if (!doc.raw_file) {
        const errClient = await pool.connect();
        try {
          await errClient.query('BEGIN');
          await withTenantContext(errClient, tenantId, async () => {});
          await errClient.query(
            `UPDATE knowledge_documents SET status = 'failed', error_message = 'Original PDF file not stored. Please re-upload the document.', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
            [id, tenantId],
          );
          await errClient.query('COMMIT');
        } catch { await errClient.query('ROLLBACK').catch(() => {}); } finally { errClient.release(); }
        return res.status(400).json({ error: 'Original PDF file not stored. Please re-upload the document.' });
      }

      const pdfBuffer = Buffer.from(doc.raw_file);
      const scan = await scanPdfBuffer(pdfBuffer);
      if (scan.verdict !== 'clean') {
        const message = buildRejectionMessage(scan);
        logger.warn('Rejected PDF reindex that failed malware scan', {
          tenantId,
          documentId: doc.id,
          filename: doc.file_name ?? null,
          detector: scan.detector,
          verdict: scan.verdict,
          reason: scan.reason,
          findings: scan.findings,
        });
        const errClient = await pool.connect();
        try {
          await errClient.query('BEGIN');
          await withTenantContext(errClient, tenantId, async () => {});
          await errClient.query(
            `UPDATE knowledge_documents SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
            [message, id, tenantId],
          );
          await errClient.query('COMMIT');
        } catch { await errClient.query('ROLLBACK').catch(() => {}); } finally { errClient.release(); }
        return res.status(422).json({ error: message });
      }

      processDocument({
        tenantId,
        documentId: doc.id,
        sourceType: 'pdf',
        fileBuffer: pdfBuffer,
      }).catch((err) => {
        logger.error('Background PDF reindex failed', { documentId: doc.id, error: String(err) });
      });
    } else if (doc.source_type === 'url') {
      processDocument({
        tenantId,
        documentId: doc.id,
        sourceType: 'url',
        url: doc.source_url,
      }).catch((err) => {
        logger.error('Background reindex failed', { documentId: doc.id, error: String(err) });
      });
    } else {
      if (!doc.raw_content) {
        const errClient = await pool.connect();
        try {
          await errClient.query('BEGIN');
          await withTenantContext(errClient, tenantId, async () => {});
          await errClient.query(
            `UPDATE knowledge_documents SET status = 'failed', error_message = 'Original content not stored. Please re-create the document.', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
            [id, tenantId],
          );
          await errClient.query('COMMIT');
        } catch { await errClient.query('ROLLBACK').catch(() => {}); } finally { errClient.release(); }
        return res.status(400).json({ error: 'Original content not stored. Please re-create the document.' });
      }
      processDocument({
        tenantId,
        documentId: doc.id,
        sourceType: doc.source_type,
        content: doc.raw_content,
      }).catch((err) => {
        logger.error('Background reindex failed', { documentId: doc.id, error: String(err) });
      });
    }

    return res.json({ message: 'Reindexing started', documentId: parseInt(id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to reindex document', { tenantId, documentId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to reindex document' });
  } finally {
    client.release();
  }
});

router.delete('/knowledge-documents/:id', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rowCount } = await client.query(
      `DELETE FROM knowledge_documents WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (!rowCount) return res.status(404).json({ error: 'Document not found' });
    logger.info('Knowledge document deleted', { tenantId, documentId: id });
    return res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: 'Failed to delete document' });
  } finally {
    client.release();
  }
});

export default router;
