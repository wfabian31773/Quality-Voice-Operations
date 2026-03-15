import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('QUALITY_SCORER');

const SCORING_RUBRIC = `You are a call quality analyst. Score this AI voice agent call transcript on a 0-10 scale.

Evaluate these dimensions:
1. Helpfulness (0-10): Did the agent address the caller's needs effectively?
2. Accuracy (0-10): Were the agent's responses factually correct and appropriate?
3. Tone (0-10): Was the agent professional, empathetic, and appropriately warm?
4. Resolution (0-10): Was the call resolved satisfactorily or properly escalated?

Return ONLY valid JSON:
{
  "overall_score": <float 0-10>,
  "helpfulness": <float 0-10>,
  "accuracy": <float 0-10>,
  "tone": <float 0-10>,
  "resolution": <float 0-10>,
  "strengths": ["<strength1>", "<strength2>"],
  "improvements": ["<improvement1>", "<improvement2>"],
  "summary": "<one sentence summary of call quality>"
}`;

export interface QualityScore {
  id: string;
  tenantId: string;
  callSessionId: string;
  score: number;
  feedback: {
    overall_score: number;
    helpfulness: number;
    accuracy: number;
    tone: number;
    resolution: number;
    strengths: string[];
    improvements: string[];
    summary: string;
  };
  scoredBy: string;
  scoredAt: string;
}

export async function scoreCall(
  tenantId: string,
  callSessionId: string,
  transcript: Array<{ role: string; content: string }>,
): Promise<QualityScore | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping quality scoring');
    return null;
  }

  if (transcript.length < 2) {
    logger.info('Transcript too short for quality scoring', { callSessionId, lineCount: transcript.length });
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
          { role: 'system', content: SCORING_RUBRIC },
          { role: 'user', content: `Score this call transcript:\n\n${transcriptText}` },
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.error('OpenAI API error during quality scoring', {
        status: response.status,
        callSessionId,
      });
      return null;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logger.error('Empty response from OpenAI quality scorer', { callSessionId });
      return null;
    }

    const feedback = JSON.parse(content) as QualityScore['feedback'];
    const score = Math.max(0, Math.min(10, feedback.overall_score ?? 0));

    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      const row = await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `INSERT INTO call_quality_scores (tenant_id, call_session_id, score, feedback, scored_by)
           VALUES ($1, $2, $3, $4, 'gpt-4o-mini')
           RETURNING id, tenant_id, call_session_id, score, feedback, scored_by, scored_at`,
          [tenantId, callSessionId, score, JSON.stringify(feedback)],
        );
        return rows[0];
      });

      logger.info('Call quality scored', { tenantId, callSessionId, score });

      return {
        id: row.id as string,
        tenantId: row.tenant_id as string,
        callSessionId: row.call_session_id as string,
        score: row.score as number,
        feedback: row.feedback as QualityScore['feedback'],
        scoredBy: row.scored_by as string,
        scoredAt: row.scored_at as string,
      };
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('Quality scoring failed', { callSessionId, error: String(err) });
    return null;
  }
}

export async function getCallQualityScore(
  tenantId: string,
  callSessionId: string,
): Promise<QualityScore | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, call_session_id, score, feedback, scored_by, scored_at
         FROM call_quality_scores
         WHERE call_session_id = $1 AND tenant_id = $2
         ORDER BY scored_at DESC LIMIT 1`,
        [callSessionId, tenantId],
      );
      return rows;
    });

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      callSessionId: row.call_session_id as string,
      score: row.score as number,
      feedback: row.feedback as QualityScore['feedback'],
      scoredBy: row.scored_by as string,
      scoredAt: row.scored_at as string,
    };
  } finally {
    client.release();
  }
}

export interface QualityTrend {
  date: string;
  avgScore: number;
  callCount: number;
  agentId: string;
  agentName: string;
}

export async function getQualityAnalytics(
  tenantId: string,
  days: number = 30,
): Promise<QualityTrend[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT DATE(cqs.scored_at) AS date,
                AVG(cqs.score) AS avg_score,
                COUNT(*)::int AS call_count,
                cs.agent_id,
                COALESCE(a.name, 'Unknown') AS agent_name
         FROM call_quality_scores cqs
         JOIN call_sessions cs ON cs.id = cqs.call_session_id
         LEFT JOIN agents a ON a.id = cs.agent_id
         WHERE cqs.tenant_id = $1
           AND cqs.scored_at >= NOW() - INTERVAL '1 day' * $2
         GROUP BY DATE(cqs.scored_at), cs.agent_id, a.name
         ORDER BY date DESC, agent_name`,
        [tenantId, days],
      );
      return rows;
    });

    return rows.map((r) => ({
      date: String(r.date).slice(0, 10),
      avgScore: parseFloat(String(r.avg_score)),
      callCount: r.call_count as number,
      agentId: r.agent_id as string,
      agentName: r.agent_name as string,
    }));
  } catch (err) {
    logger.error('Failed to get quality analytics', { tenantId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}

export interface LowestScoringCall {
  callSessionId: string;
  score: number;
  agentName: string;
  agentId: string;
  durationSeconds: number;
  scoredAt: string;
  summary: string;
  transcriptPreview: string;
}

export async function getLowestScoringCalls(
  tenantId: string,
  limit: number = 20,
): Promise<LowestScoringCall[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT cqs.call_session_id, cqs.score, cqs.feedback, cqs.scored_at,
                COALESCE(a.name, 'Unknown') AS agent_name,
                cs.agent_id,
                COALESCE(cs.duration_seconds, 0) AS duration_seconds,
                COALESCE(
                  (SELECT string_agg(ct.role || ': ' || ct.content, E'\n' ORDER BY ct.sequence_number)
                   FROM call_transcripts ct
                   WHERE ct.call_session_id = cqs.call_session_id
                     AND ct.sequence_number <= 4),
                  ''
                ) AS transcript_preview
         FROM call_quality_scores cqs
         JOIN call_sessions cs ON cs.id = cqs.call_session_id
         LEFT JOIN agents a ON a.id = cs.agent_id
         WHERE cqs.tenant_id = $1
           AND cqs.scored_at >= NOW() - INTERVAL '30 days'
         ORDER BY cqs.score ASC, cqs.scored_at DESC
         LIMIT $2`,
        [tenantId, limit],
      );
      return rows;
    });

    return rows.map((r) => {
      const feedback = r.feedback as Record<string, unknown>;
      return {
        callSessionId: r.call_session_id as string,
        score: r.score as number,
        agentName: r.agent_name as string,
        agentId: r.agent_id as string,
        durationSeconds: r.duration_seconds as number,
        scoredAt: r.scored_at as string,
        summary: (feedback.summary as string) ?? '',
        transcriptPreview: (r.transcript_preview as string) ?? '',
      };
    });
  } catch (err) {
    logger.error('Failed to get lowest scoring calls', { tenantId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}
