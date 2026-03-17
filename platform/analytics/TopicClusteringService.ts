import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('TOPIC_CLUSTERING');

const DEFAULT_TOPICS = [
  'scheduling',
  'billing_inquiry',
  'emergency',
  'complaint',
  'general_inquiry',
  'follow_up',
  'cancellation',
  'technical_support',
  'new_patient',
  'prescription_refill',
  'insurance',
  'other',
];

const TOPIC_PROMPT = `You are a call topic classifier. Classify the primary topic and any secondary topics of this call transcript.

Available topics: ${DEFAULT_TOPICS.join(', ')}

Return ONLY valid JSON:
{
  "primary_topic": "<one of the available topics>",
  "secondary_topics": ["<topic1>", "<topic2>"],
  "confidence": <float 0.0 to 1.0>,
  "reasoning": "<brief explanation>"
}`;

export interface TopicClassification {
  id: string;
  tenantId: string;
  callSessionId: string;
  primaryTopic: string;
  secondaryTopics: string[];
  confidence: number;
  classifiedAt: string;
}

export interface TopicDistribution {
  topic: string;
  count: number;
  percentage: number;
}

export interface TopicTrend {
  date: string;
  topic: string;
  count: number;
}

export async function classifyCallTopic(
  tenantId: string,
  callSessionId: string,
  transcript: Array<{ role: string; content: string }>,
): Promise<TopicClassification | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping topic classification');
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
          { role: 'system', content: TOPIC_PROMPT },
          { role: 'user', content: `Classify this call:\n\n${transcriptText}` },
        ],
        temperature: 0.2,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.error('OpenAI API error during topic classification', { status: response.status, callSessionId });
      return null;
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const rawPrimary = parsed.primary_topic ?? 'other';
    const primaryTopic = DEFAULT_TOPICS.includes(rawPrimary) ? rawPrimary : 'other';
    const secondaryTopics = (parsed.secondary_topics ?? []).filter((t: string) => DEFAULT_TOPICS.includes(t));
    const confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0));

    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      const row = await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `INSERT INTO call_topic_classifications (tenant_id, call_session_id, primary_topic, secondary_topics, confidence, details)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, call_session_id) DO UPDATE SET
             primary_topic = EXCLUDED.primary_topic,
             secondary_topics = EXCLUDED.secondary_topics,
             confidence = EXCLUDED.confidence,
             details = EXCLUDED.details,
             classified_at = NOW()
           RETURNING id, tenant_id, call_session_id, primary_topic, secondary_topics, confidence, classified_at`,
          [tenantId, callSessionId, primaryTopic, secondaryTopics, confidence, JSON.stringify({ reasoning: parsed.reasoning ?? '' })],
        );
        return rows[0];
      });

      logger.info('Topic classified', { tenantId, callSessionId, primaryTopic });

      return {
        id: row.id as string,
        tenantId: row.tenant_id as string,
        callSessionId: row.call_session_id as string,
        primaryTopic: row.primary_topic as string,
        secondaryTopics: row.secondary_topics as string[],
        confidence: row.confidence as number,
        classifiedAt: row.classified_at as string,
      };
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('Topic classification failed', { callSessionId, error: String(err) });
    return null;
  }
}

export async function getTopicDistribution(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<TopicDistribution[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT
           primary_topic AS topic,
           COUNT(*)::int AS count
         FROM call_topic_classifications
         WHERE tenant_id = $1
           AND classified_at >= $2
           AND classified_at < $3
         GROUP BY primary_topic
         ORDER BY count DESC`,
        [tenantId, from, to],
      );
      return rows;
    });

    const total = rows.reduce((sum, r) => sum + ((r.count as number) ?? 0), 0);

    return rows.map((r) => {
      const count = (r.count as number) ?? 0;
      return {
        topic: r.topic as string,
        count,
        percentage: total > 0 ? count / total : 0,
      };
    });
  } catch (err) {
    logger.error('Failed to get topic distribution', { tenantId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}

export async function getTopicTrends(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<TopicTrend[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT
           DATE(classified_at) AS date,
           primary_topic AS topic,
           COUNT(*)::int AS count
         FROM call_topic_classifications
         WHERE tenant_id = $1
           AND classified_at >= $2
           AND classified_at < $3
         GROUP BY DATE(classified_at), primary_topic
         ORDER BY date, count DESC`,
        [tenantId, from, to],
      );
      return rows;
    });

    return rows.map((r) => ({
      date: String(r.date).slice(0, 10),
      topic: r.topic as string,
      count: (r.count as number) ?? 0,
    }));
  } catch (err) {
    logger.error('Failed to get topic trends', { tenantId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}
