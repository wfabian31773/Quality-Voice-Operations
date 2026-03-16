import { createLogger } from '../core/logger';

const logger = createLogger('EMBEDDING_SERVICE');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set, returning empty embedding');
    return [];
  }

  const input = text.slice(0, 8000);

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error('OpenAI embeddings API error', { status: res.status, body });
    throw new Error(`Embedding generation failed: ${res.status}`);
  }

  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  if (magnitude === 0) return 0;

  return dot / magnitude;
}

export interface SearchResult {
  id: number;
  title: string;
  content: string;
  category: string | null;
  score: number;
}

export async function searchByEmbedding(
  queryEmbedding: number[],
  articles: Array<{ id: number; title: string; content: string; category: string | null; embedding: number[] | null }>,
  topK = 5,
  minScore = 0.3,
): Promise<SearchResult[]> {
  if (queryEmbedding.length === 0) return [];

  const scored = articles
    .filter((a) => a.embedding && a.embedding.length > 0)
    .map((a) => ({
      id: a.id,
      title: a.title,
      content: a.content,
      category: a.category,
      score: cosineSimilarity(queryEmbedding, a.embedding!),
    }))
    .filter((r) => r.score >= minScore)
    .sort((x, y) => y.score - x.score)
    .slice(0, topK);

  return scored;
}
