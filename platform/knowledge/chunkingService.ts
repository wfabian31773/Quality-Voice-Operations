import { createLogger } from '../core/logger';

const logger = createLogger('CHUNKING_SERVICE');

export interface ChunkOptions {
  maxChunkSize?: number;
  chunkOverlap?: number;
  minChunkSize?: number;
}

export interface TextChunk {
  index: number;
  content: string;
}

const DEFAULT_MAX_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_MIN_CHUNK_SIZE = 100;

export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChunkSize = options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const minChunkSize = options.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;

  if (!text || text.trim().length === 0) {
    return [];
  }

  const paragraphs = text.split(/\n\n+/);
  const chunks: TextChunk[] = [];
  let currentChunk = '';
  let chunkIndex = 0;

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (currentChunk.length + trimmed.length + 1 > maxChunkSize && currentChunk.length >= minChunkSize) {
      chunks.push({ index: chunkIndex++, content: currentChunk.trim() });

      const overlap = currentChunk.slice(-chunkOverlap).trim();
      currentChunk = overlap ? overlap + '\n\n' + trimmed : trimmed;
    } else {
      currentChunk = currentChunk ? currentChunk + '\n\n' + trimmed : trimmed;
    }
  }

  if (currentChunk.trim().length > 0) {
    if (currentChunk.trim().length < minChunkSize && chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1];
      lastChunk.content = lastChunk.content + '\n\n' + currentChunk.trim();
    } else {
      chunks.push({ index: chunkIndex, content: currentChunk.trim() });
    }
  }

  if (chunks.length === 0 && text.trim().length > 0) {
    chunks.push({ index: 0, content: text.trim() });
  }

  logger.info('Text chunked', { totalChunks: chunks.length, inputLength: text.length });
  return chunks;
}
