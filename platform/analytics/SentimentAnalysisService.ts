import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('SENTIMENT_ANALYSIS');

const SENTIMENT_PROMPT = `You are a customer sentiment analyst. Analyze this call transcript and determine the customer's sentiment.

Return ONLY valid JSON:
{
  "sentiment_score": <float -1.0 to 1.0, where -1 is very negative, 0 is neutral, 1 is very positive>,
  "sentiment_label": "<one of: very_negative, negative, neutral, positive, very_positive>",
  "confidence": <float 0.0 to 1.0>,
  "key_emotions": ["<emotion1>", "<emotion2>"],
  "summary": "<one sentence explaining the sentiment>"
}`;

export interface SentimentScore {
  id: string;
  tenantId: string;
  callSessionId: string;
  sentimentScore: number;
  sentimentLabel: string;
  confidence: number;
  details: {
    key_emotions: string[];
    summary: string;
  };
  scoredAt: string;
}

export interface SentimentTrend {
  date: string;
  avgScore: number;
  callCount: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
}

export interface AgentSentiment {
  agentId: string;
  agentName: string;
  avgScore: number;
  callCount: number;
  positiveRate: number;
}

export async function analyzeCallSentiment(
  tenantId: string,
  callSessionId: string,
  transcript: Array<{ role: string; content: string }>,
): Promise<SentimentScore | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping sentiment analysis');
    return null;
  }

  if (transcript.length < 2) {
    return null;
  }

  const transcriptText = transcript
    .map((line) => `${line.role}: ${line.content}`)
    .join('\n');

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SENTIMENT_PROMPT },
          { role: 'user', content: `Analyze sentiment for this call:\n\n${transcriptText}` },
        ],
        temperature: 0.2,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.error('OpenAI API error during sentiment analysis', { status: response.status, callSessionId });
      return null;
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const sentimentScore = Math.max(-1, Math.min(1, parsed.sentiment_score ?? 0));
    const sentimentLabel = parsed.sentiment_label ?? 'neutral';
    const confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0));

    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      const row = await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `INSERT INTO call_sentiment_scores (tenant_id, call_session_id, sentiment_score, sentiment_label, confidence, details)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, call_session_id) DO UPDATE SET
             sentiment_score = EXCLUDED.sentiment_score,
             sentiment_label = EXCLUDED.sentiment_label,
             confidence = EXCLUDED.confidence,
             details = EXCLUDED.details,
             scored_at = NOW()
           RETURNING id, tenant_id, call_session_id, sentiment_score, sentiment_label, confidence, details, scored_at`,
          [tenantId, callSessionId, sentimentScore, sentimentLabel, confidence, JSON.stringify({
            key_emotions: parsed.key_emotions ?? [],
            summary: parsed.summary ?? '',
          })],
        );
        return rows[0];
      });

      logger.info('Sentiment analyzed', { tenantId, callSessionId, sentimentScore, sentimentLabel });

      return {
        id: row.id as string,
        tenantId: row.tenant_id as string,
        callSessionId: row.call_session_id as string,
        sentimentScore: row.sentiment_score as number,
        sentimentLabel: row.sentiment_label as string,
        confidence: row.confidence as number,
        details: row.details as SentimentScore['details'],
        scoredAt: row.scored_at as string,
      };
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('Sentiment analysis failed', { callSessionId, error: String(err) });
    return null;
  }
}

export async function getSentimentTrends(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<SentimentTrend[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT
           DATE(scored_at) AS date,
           AVG(sentiment_score) AS avg_score,
           COUNT(*)::int AS call_count,
           COUNT(*) FILTER (WHERE sentiment_label IN ('positive', 'very_positive'))::int AS positive_count,
           COUNT(*) FILTER (WHERE sentiment_label = 'neutral')::int AS neutral_count,
           COUNT(*) FILTER (WHERE sentiment_label IN ('negative', 'very_negative'))::int AS negative_count
         FROM call_sentiment_scores
         WHERE tenant_id = $1
           AND scored_at >= $2
           AND scored_at < $3
         GROUP BY DATE(scored_at)
         ORDER BY date`,
        [tenantId, from, to],
      );
      return rows;
    });

    return rows.map((r) => ({
      date: String(r.date).slice(0, 10),
      avgScore: parseFloat(String(r.avg_score ?? 0)),
      callCount: (r.call_count as number) ?? 0,
      positiveCount: (r.positive_count as number) ?? 0,
      neutralCount: (r.neutral_count as number) ?? 0,
      negativeCount: (r.negative_count as number) ?? 0,
    }));
  } catch (err) {
    logger.error('Failed to get sentiment trends', { tenantId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}

export async function getAgentSentiments(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<AgentSentiment[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT
           cs.agent_id,
           COALESCE(a.name, 'Unknown') AS agent_name,
           AVG(css.sentiment_score) AS avg_score,
           COUNT(*)::int AS call_count,
           COUNT(*) FILTER (WHERE css.sentiment_label IN ('positive', 'very_positive'))::int AS positive_count
         FROM call_sentiment_scores css
         JOIN call_sessions cs ON cs.id = css.call_session_id
         LEFT JOIN agents a ON a.id = cs.agent_id
         WHERE css.tenant_id = $1
           AND css.scored_at >= $2
           AND css.scored_at < $3
         GROUP BY cs.agent_id, a.name
         ORDER BY avg_score DESC`,
        [tenantId, from, to],
      );
      return rows;
    });

    return rows.map((r) => {
      const callCount = (r.call_count as number) ?? 0;
      const positiveCount = (r.positive_count as number) ?? 0;
      return {
        agentId: r.agent_id as string,
        agentName: r.agent_name as string,
        avgScore: parseFloat(String(r.avg_score ?? 0)),
        callCount,
        positiveRate: callCount > 0 ? positiveCount / callCount : 0,
      };
    });
  } catch (err) {
    logger.error('Failed to get agent sentiments', { tenantId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}
