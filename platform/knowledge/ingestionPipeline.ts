import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { generateEmbedding } from './embeddingService';
import { extractTextFromPDF, extractTextFromURL, normalizeText } from './textExtractor';
import { chunkText } from './chunkingService';
import type { TenantId } from '../core/types';

const logger = createLogger('INGESTION_PIPELINE');

interface IngestionInput {
  tenantId: TenantId;
  documentId: number;
  sourceType: 'pdf' | 'url' | 'text' | 'faq';
  content?: string;
  url?: string;
  fileBuffer?: Buffer;
}

export async function processDocument(input: IngestionInput): Promise<void> {
  const { tenantId, documentId, sourceType } = input;
  const pool = getPlatformPool();

  logger.info('Starting document ingestion', { tenantId, documentId, sourceType });

  try {
    let rawText: string;

    switch (sourceType) {
      case 'pdf':
        if (!input.fileBuffer) throw new Error('PDF buffer is required');
        rawText = await extractTextFromPDF(input.fileBuffer);
        break;
      case 'url':
        if (!input.url) throw new Error('URL is required');
        rawText = await extractTextFromURL(input.url);
        break;
      case 'text':
      case 'faq':
        if (!input.content) throw new Error('Content is required');
        rawText = input.content;
        break;
      default:
        throw new Error(`Unsupported source type: ${sourceType}`);
    }

    const normalizedText = normalizeText(rawText);
    const chunks = chunkText(normalizedText);

    if (chunks.length === 0) {
      throw new Error('No content could be extracted');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      await client.query(
        `DELETE FROM knowledge_chunks WHERE document_id = $1 AND tenant_id = $2`,
        [documentId, tenantId],
      );

      for (const chunk of chunks) {
        let embedding: number[] = [];
        try {
          embedding = await generateEmbedding(chunk.content);
        } catch (embErr) {
          logger.warn('Embedding failed for chunk', {
            documentId,
            chunkIndex: chunk.index,
            error: String(embErr),
          });
        }

        await client.query(
          `INSERT INTO knowledge_chunks (tenant_id, document_id, chunk_index, content, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            tenantId,
            documentId,
            chunk.index,
            chunk.content,
            JSON.stringify(embedding),
            JSON.stringify({ charCount: chunk.content.length }),
          ],
        );
      }

      await client.query(
        `UPDATE knowledge_documents SET status = 'ready', chunk_count = $1, error_message = NULL, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3`,
        [chunks.length, documentId, tenantId],
      );

      await client.query('COMMIT');
      logger.info('Document ingestion complete', { tenantId, documentId, chunks: chunks.length });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('Document ingestion failed', { tenantId, documentId, error: String(err) });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});
      await client.query(
        `UPDATE knowledge_documents SET status = 'failed', error_message = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3`,
        [(err as Error).message, documentId, tenantId],
      );
      await client.query('COMMIT');
    } catch (updateErr) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Failed to update document status', { documentId, error: String(updateErr) });
    } finally {
      client.release();
    }
  }
}
