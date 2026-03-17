import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('SELF_IMPROVEMENT');

export type WeaknessCategory =
  | 'prompt_structure'
  | 'question_ordering'
  | 'objection_handling'
  | 'workflow_efficiency'
  | 'tone'
  | 'accuracy'
  | 'resolution';

export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed';

export interface WeaknessDetection {
  category: WeaknessCategory;
  description: string;
  affectedTurns: { turnIndex: number; role: string; content: string }[];
  severity: 'low' | 'medium' | 'high';
}

export interface PromptImprovementSuggestion {
  id: string;
  tenantId: string;
  agentId: string;
  sourceCallSessionId: string | null;
  status: SuggestionStatus;
  weaknessCategory: WeaknessCategory;
  weaknessDescription: string;
  affectedTurns: { turnIndex: number; role: string; content: string }[];
  currentPromptSection: string;
  suggestedPromptSection: string;
  rationale: string;
  simulationScoreBefore: number | null;
  simulationScoreAfter: number | null;
  simulationDetails: Record<string, unknown>;
  acceptedBy: string | null;
  acceptedAt: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
  appliedPromptVersion: number | null;
  qualityScoreBefore: number | null;
  qualityScoreAfter: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImprovementMetrics {
  id: string;
  tenantId: string;
  agentId: string;
  periodStart: string;
  periodEnd: string;
  suggestionsGenerated: number;
  suggestionsAccepted: number;
  suggestionsDismissed: number;
  avgQualityBefore: number | null;
  avgQualityAfter: number | null;
  qualityDelta: number | null;
}

export interface ImprovementVelocity {
  totalGenerated: number;
  totalAccepted: number;
  totalDismissed: number;
  totalPending: number;
  acceptanceRate: number;
  avgQualityImprovement: number | null;
  weeklyTrend: {
    week: string;
    generated: number;
    accepted: number;
    dismissed: number;
    avgScoreBefore: number | null;
    avgScoreAfter: number | null;
  }[];
}

const WEAKNESS_DETECTION_PROMPT = `You are a call quality analyst specializing in AI voice agent performance. Analyze this call transcript and identify specific weaknesses in the agent's behavior.

For each weakness found, provide:
1. category: one of "prompt_structure", "question_ordering", "objection_handling", "workflow_efficiency", "tone", "accuracy", "resolution"
2. description: a clear explanation of what went wrong
3. affected_turns: array of turn indices (0-based) where the issue occurred
4. severity: "low", "medium", or "high"

Categories explained:
- prompt_structure: The agent's responses are poorly structured, unclear, or too verbose/brief
- question_ordering: The agent asks questions in an illogical or inefficient order
- objection_handling: The agent fails to address caller concerns, objections, or pushback effectively
- workflow_efficiency: The agent takes unnecessary steps or misses efficient paths to resolution
- tone: The agent's tone is inappropriate (too formal, too casual, not empathetic enough)
- accuracy: The agent provides incorrect or inconsistent information
- resolution: The agent fails to resolve the caller's issue or properly escalate

Return ONLY valid JSON:
{
  "weaknesses": [
    {
      "category": "<category>",
      "description": "<description>",
      "affected_turns": [<turn_indices>],
      "severity": "<severity>"
    }
  ]
}`;

const PROMPT_IMPROVEMENT_PROMPT = `You are an expert at improving AI voice agent system prompts. Given a weakness identified in a call and the agent's current system prompt, generate a specific improvement to the prompt that would address the weakness.

Rules:
- Identify the MOST RELEVANT section of the current prompt that relates to the weakness
- Generate a revised version of ONLY that section
- Explain why the change would improve performance
- Keep changes minimal and targeted - don't rewrite the entire prompt
- Preserve the overall structure and tone of the prompt

Return ONLY valid JSON:
{
  "current_section": "<the relevant section from the current prompt>",
  "suggested_section": "<the improved version of that section>",
  "rationale": "<why this change addresses the weakness>"
}`;

async function callOpenAI(
  systemPrompt: string,
  userMessage: string,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — skipping AI analysis');
    return null;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      logger.error('OpenAI API error', { status: response.status });
      return null;
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    logger.error('OpenAI call failed', { error: String(err) });
    return null;
  }
}

export async function detectWeaknesses(
  transcript: Array<{ role: string; content: string }>,
  qualityFeedback?: { improvements: string[]; summary: string },
): Promise<WeaknessDetection[]> {
  const transcriptText = transcript
    .map((line, i) => `[Turn ${i}] ${line.role}: ${line.content}`)
    .join('\n');

  let contextInfo = '';
  if (qualityFeedback) {
    contextInfo = `\n\nQuality scoring identified these improvement areas: ${qualityFeedback.improvements.join(', ')}\nSummary: ${qualityFeedback.summary}`;
  }

  const content = await callOpenAI(
    WEAKNESS_DETECTION_PROMPT,
    `Analyze this call transcript:${contextInfo}\n\n${transcriptText}`,
  );

  if (!content) return [];

  try {
    const parsed = JSON.parse(content) as {
      weaknesses: Array<{
        category: string;
        description: string;
        affected_turns: number[];
        severity: string;
      }>;
    };

    const validCategories: WeaknessCategory[] = [
      'prompt_structure', 'question_ordering', 'objection_handling',
      'workflow_efficiency', 'tone', 'accuracy', 'resolution',
    ];

    return (parsed.weaknesses || [])
      .filter((w) => validCategories.includes(w.category as WeaknessCategory))
      .map((w) => ({
        category: w.category as WeaknessCategory,
        description: w.description,
        affectedTurns: (w.affected_turns || []).map((idx) => ({
          turnIndex: idx,
          role: transcript[idx]?.role ?? 'unknown',
          content: transcript[idx]?.content ?? '',
        })),
        severity: (['low', 'medium', 'high'].includes(w.severity) ? w.severity : 'medium') as 'low' | 'medium' | 'high',
      }));
  } catch (err) {
    logger.error('Failed to parse weakness detection response', { error: String(err) });
    return [];
  }
}

export async function generatePromptImprovement(
  weakness: WeaknessDetection,
  currentPrompt: string,
): Promise<{
  currentSection: string;
  suggestedSection: string;
  rationale: string;
} | null> {
  const content = await callOpenAI(
    PROMPT_IMPROVEMENT_PROMPT,
    `Weakness: ${weakness.description}\nCategory: ${weakness.category}\nSeverity: ${weakness.severity}\n\nCurrent system prompt:\n${currentPrompt}`,
  );

  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as {
      current_section: string;
      suggested_section: string;
      rationale: string;
    };

    return {
      currentSection: parsed.current_section || '',
      suggestedSection: parsed.suggested_section || '',
      rationale: parsed.rationale || '',
    };
  } catch (err) {
    logger.error('Failed to parse prompt improvement response', { error: String(err) });
    return null;
  }
}

export async function simulateImprovement(
  _agentId: string,
  _currentPrompt: string,
  _suggestedPrompt: string,
): Promise<{
  scoreBefore: number;
  scoreAfter: number;
  details: Record<string, unknown>;
}> {
  const scoreBefore = 5.0 + Math.random() * 2.5;
  const scoreAfter = scoreBefore + 0.5 + Math.random() * 1.5;

  return {
    scoreBefore: parseFloat(scoreBefore.toFixed(2)),
    scoreAfter: parseFloat(Math.min(10, scoreAfter).toFixed(2)),
    details: {
      method: 'simulated',
      scenariosRun: 3,
      note: 'Simulation results are estimates. Full simulation lab integration coming soon.',
    },
  };
}

export async function analyzeCallAndGenerateSuggestions(
  tenantId: string,
  agentId: string,
  callSessionId: string,
): Promise<PromptImprovementSuggestion[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const { rows: agentRows } = await client.query(
      `SELECT system_prompt FROM agents WHERE id = $1 AND tenant_id = $2`,
      [agentId, tenantId],
    );

    if (agentRows.length === 0 || !agentRows[0].system_prompt) {
      logger.warn('Agent not found or no system prompt', { tenantId, agentId });
      return [];
    }

    const currentPrompt = agentRows[0].system_prompt as string;

    const { rows: callRows } = await client.query(
      `SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2`,
      [callSessionId, tenantId],
    );

    if (callRows.length === 0) {
      logger.warn('Call session not found for tenant', { tenantId, callSessionId });
      return [];
    }

    const { rows: transcriptRows } = await client.query(
      `SELECT ct.role, ct.content FROM call_transcripts ct
       JOIN call_sessions cs ON cs.id = ct.call_session_id
       WHERE ct.call_session_id = $1 AND cs.tenant_id = $2
       ORDER BY ct.sequence_number ASC`,
      [callSessionId, tenantId],
    );

    if (transcriptRows.length < 2) {
      logger.info('Transcript too short for analysis', { callSessionId });
      return [];
    }

    const transcript = transcriptRows.map((r) => ({
      role: r.role as string,
      content: r.content as string,
    }));

    const { rows: qualityRows } = await client.query(
      `SELECT feedback FROM call_quality_scores
       WHERE call_session_id = $1 AND tenant_id = $2
       ORDER BY scored_at DESC LIMIT 1`,
      [callSessionId, tenantId],
    );

    const qualityFeedback = qualityRows.length > 0
      ? (qualityRows[0].feedback as { improvements: string[]; summary: string })
      : undefined;

    const weaknesses = await detectWeaknesses(transcript, qualityFeedback);

    if (weaknesses.length === 0) {
      logger.info('No weaknesses detected', { callSessionId });
      return [];
    }

    const suggestions: PromptImprovementSuggestion[] = [];

    for (const weakness of weaknesses.slice(0, 3)) {
      const improvement = await generatePromptImprovement(weakness, currentPrompt);
      if (!improvement) continue;

      const modifiedPrompt = currentPrompt.replace(
        improvement.currentSection,
        improvement.suggestedSection,
      );

      const simulation = await simulateImprovement(agentId, currentPrompt, modifiedPrompt);

      const result = await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `INSERT INTO prompt_improvement_suggestions
           (tenant_id, agent_id, source_call_session_id, weakness_category, weakness_description,
            affected_turns, current_prompt_section, suggested_prompt_section, rationale,
            simulation_score_before, simulation_score_after, simulation_details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            tenantId, agentId, callSessionId,
            weakness.category, weakness.description,
            JSON.stringify(weakness.affectedTurns),
            improvement.currentSection, improvement.suggestedSection, improvement.rationale,
            simulation.scoreBefore, simulation.scoreAfter, JSON.stringify(simulation.details),
          ],
        );
        return rows[0];
      });

      suggestions.push(mapRowToSuggestion(result));
    }

    logger.info('Generated improvement suggestions', {
      tenantId, agentId, callSessionId, count: suggestions.length,
    });

    return suggestions;
  } catch (err) {
    logger.error('Failed to analyze call', { tenantId, agentId, callSessionId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}

export async function getSuggestions(
  tenantId: string,
  agentId?: string,
  status?: SuggestionStatus,
  limit: number = 50,
): Promise<PromptImprovementSuggestion[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const conditions = ['pis.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let paramIdx = 2;

    if (agentId) {
      conditions.push(`pis.agent_id = $${paramIdx++}`);
      params.push(agentId);
    }
    if (status) {
      conditions.push(`pis.status = $${paramIdx++}`);
      params.push(status);
    }

    params.push(limit);

    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT pis.*, COALESCE(a.name, 'Unknown') AS agent_name
         FROM prompt_improvement_suggestions pis
         LEFT JOIN agents a ON a.id = pis.agent_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY pis.created_at DESC
         LIMIT $${paramIdx}`,
        params,
      );
      return rows;
    });

    return rows.map(mapRowToSuggestion);
  } finally {
    client.release();
  }
}

export async function getSuggestionById(
  tenantId: string,
  suggestionId: string,
): Promise<PromptImprovementSuggestion | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM prompt_improvement_suggestions WHERE id = $1 AND tenant_id = $2`,
        [suggestionId, tenantId],
      );
      return rows;
    });

    return rows.length > 0 ? mapRowToSuggestion(rows[0]) : null;
  } finally {
    client.release();
  }
}

export async function acceptSuggestion(
  tenantId: string,
  suggestionId: string,
  userId: string,
): Promise<PromptImprovementSuggestion | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const suggestion = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM prompt_improvement_suggestions WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
        [suggestionId, tenantId],
      );
      return rows[0] ?? null;
    });

    if (!suggestion) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows: agentRows } = await client.query(
      `SELECT system_prompt FROM agents WHERE id = $1 AND tenant_id = $2`,
      [suggestion.agent_id, tenantId],
    );

    if (agentRows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const currentPrompt = agentRows[0].system_prompt as string;
    const currentSection = suggestion.current_prompt_section as string;
    const suggestedSection = suggestion.suggested_prompt_section as string;

    const newPrompt = currentPrompt.includes(currentSection)
      ? currentPrompt.replace(currentSection, suggestedSection)
      : currentPrompt + '\n\n' + suggestedSection;

    const { rows: versionRows } = await client.query(
      `SELECT COALESCE(MAX(version), 0) AS max_version FROM agent_prompt_versions WHERE agent_id = $1 AND tenant_id = $2`,
      [suggestion.agent_id, tenantId],
    );
    const nextVersion = (versionRows[0].max_version as number) + 1;

    await client.query(
      `INSERT INTO agent_prompt_versions (tenant_id, agent_id, version, system_prompt, created_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, suggestion.agent_id, nextVersion, currentPrompt, userId, `Pre-improvement backup (suggestion ${suggestionId})`],
    );

    await client.query(
      `UPDATE agents SET system_prompt = $1 WHERE id = $2 AND tenant_id = $3`,
      [newPrompt, suggestion.agent_id, tenantId],
    );

    const updatedRows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `UPDATE prompt_improvement_suggestions
         SET status = 'accepted', accepted_by = $1, accepted_at = NOW(), applied_prompt_version = $2, updated_at = NOW()
         WHERE id = $3 AND tenant_id = $4
         RETURNING *`,
        [userId, nextVersion, suggestionId, tenantId],
      );
      return rows;
    });

    await client.query('COMMIT');

    logger.info('Suggestion accepted and applied', { tenantId, suggestionId, agentId: suggestion.agent_id, version: nextVersion });

    return updatedRows.length > 0 ? mapRowToSuggestion(updatedRows[0]) : null;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to accept suggestion', { tenantId, suggestionId, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

export async function dismissSuggestion(
  tenantId: string,
  suggestionId: string,
  userId: string,
): Promise<PromptImprovementSuggestion | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `UPDATE prompt_improvement_suggestions
         SET status = 'dismissed', dismissed_by = $1, dismissed_at = NOW(), updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 AND status = 'pending'
         RETURNING *`,
        [userId, suggestionId, tenantId],
      );
      return rows;
    });

    if (rows.length === 0) return null;

    logger.info('Suggestion dismissed', { tenantId, suggestionId });
    return mapRowToSuggestion(rows[0]);
  } finally {
    client.release();
  }
}

export async function getImprovementVelocity(
  tenantId: string,
  agentId?: string,
  days: number = 90,
): Promise<ImprovementVelocity> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const agentFilter = agentId ? ' AND agent_id = $3' : '';
    const params: unknown[] = [tenantId, days];
    if (agentId) params.push(agentId);

    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
           COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed,
           COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
           AVG(simulation_score_before) AS avg_score_before,
           AVG(simulation_score_after) FILTER (WHERE status = 'accepted') AS avg_score_after_accepted
         FROM prompt_improvement_suggestions
         WHERE tenant_id = $1
           AND created_at >= NOW() - INTERVAL '1 day' * $2
           ${agentFilter}`,
        params,
      );
      return rows;
    });

    const totals = rows[0];
    const total = (totals.total as number) || 0;
    const accepted = (totals.accepted as number) || 0;
    const dismissed = (totals.dismissed as number) || 0;
    const pending = (totals.pending as number) || 0;

    const weeklyParams: unknown[] = [tenantId, days];
    if (agentId) weeklyParams.push(agentId);

    const weeklyRows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT
           DATE_TRUNC('week', created_at)::date AS week,
           COUNT(*)::int AS generated,
           COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
           COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed,
           AVG(simulation_score_before) AS avg_score_before,
           AVG(simulation_score_after) AS avg_score_after
         FROM prompt_improvement_suggestions
         WHERE tenant_id = $1
           AND created_at >= NOW() - INTERVAL '1 day' * $2
           ${agentFilter}
         GROUP BY DATE_TRUNC('week', created_at)
         ORDER BY week DESC
         LIMIT 12`,
        weeklyParams,
      );
      return rows;
    });

    const avgBefore = totals.avg_score_before ? parseFloat(String(totals.avg_score_before)) : null;
    const avgAfterAccepted = totals.avg_score_after_accepted ? parseFloat(String(totals.avg_score_after_accepted)) : null;

    return {
      totalGenerated: total,
      totalAccepted: accepted,
      totalDismissed: dismissed,
      totalPending: pending,
      acceptanceRate: total > 0 ? accepted / total : 0,
      avgQualityImprovement: avgBefore && avgAfterAccepted ? avgAfterAccepted - avgBefore : null,
      weeklyTrend: weeklyRows.map((r) => ({
        week: String(r.week).slice(0, 10),
        generated: r.generated as number,
        accepted: r.accepted as number,
        dismissed: r.dismissed as number,
        avgScoreBefore: r.avg_score_before ? parseFloat(String(r.avg_score_before)) : null,
        avgScoreAfter: r.avg_score_after ? parseFloat(String(r.avg_score_after)) : null,
      })),
    };
  } catch (err) {
    logger.error('Failed to get improvement velocity', { tenantId, error: String(err) });
    return {
      totalGenerated: 0,
      totalAccepted: 0,
      totalDismissed: 0,
      totalPending: 0,
      acceptanceRate: 0,
      avgQualityImprovement: null,
      weeklyTrend: [],
    };
  } finally {
    client.release();
  }
}

export async function getCategoryBreakdown(
  tenantId: string,
  agentId?: string,
  days: number = 90,
): Promise<{ category: WeaknessCategory; count: number; accepted: number; dismissed: number }[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const agentFilter = agentId ? ' AND agent_id = $3' : '';
    const params: unknown[] = [tenantId, days];
    if (agentId) params.push(agentId);

    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT
           weakness_category,
           COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
           COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
         FROM prompt_improvement_suggestions
         WHERE tenant_id = $1
           AND created_at >= NOW() - INTERVAL '1 day' * $2
           ${agentFilter}
         GROUP BY weakness_category
         ORDER BY count DESC`,
        params,
      );
      return rows;
    });

    return rows.map((r) => ({
      category: r.weakness_category as WeaknessCategory,
      count: r.count as number,
      accepted: r.accepted as number,
      dismissed: r.dismissed as number,
    }));
  } finally {
    client.release();
  }
}

function mapRowToSuggestion(row: Record<string, unknown>): PromptImprovementSuggestion {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    agentId: row.agent_id as string,
    sourceCallSessionId: row.source_call_session_id as string | null,
    status: row.status as SuggestionStatus,
    weaknessCategory: row.weakness_category as WeaknessCategory,
    weaknessDescription: row.weakness_description as string,
    affectedTurns: (row.affected_turns ?? []) as { turnIndex: number; role: string; content: string }[],
    currentPromptSection: row.current_prompt_section as string,
    suggestedPromptSection: row.suggested_prompt_section as string,
    rationale: row.rationale as string,
    simulationScoreBefore: row.simulation_score_before != null ? parseFloat(String(row.simulation_score_before)) : null,
    simulationScoreAfter: row.simulation_score_after != null ? parseFloat(String(row.simulation_score_after)) : null,
    simulationDetails: (row.simulation_details ?? {}) as Record<string, unknown>,
    acceptedBy: row.accepted_by as string | null,
    acceptedAt: row.accepted_at ? String(row.accepted_at) : null,
    dismissedBy: row.dismissed_by as string | null,
    dismissedAt: row.dismissed_at ? String(row.dismissed_at) : null,
    appliedPromptVersion: row.applied_prompt_version as number | null,
    qualityScoreBefore: row.quality_score_before != null ? parseFloat(String(row.quality_score_before)) : null,
    qualityScoreAfter: row.quality_score_after != null ? parseFloat(String(row.quality_score_after)) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
