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
