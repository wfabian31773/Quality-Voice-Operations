import { withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('EXPERIMENT_MANAGER');

export interface Experiment {
  id: string;
  experimentName: string;
  experimentType: string;
  state: string;
  hypothesis: string | null;
  description: string | null;
  pilotTenantIds: string[];
  config: Record<string, unknown>;
  successCriteria: Record<string, unknown>;
  results: Record<string, unknown>;
  opportunityId: string | null;
  startedAt: string | null;
  concludedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function createExperiment(data: {
  experimentName: string;
  experimentType: string;
  hypothesis?: string;
  description?: string;
  pilotTenantIds?: string[];
  config?: Record<string, unknown>;
  successCriteria?: Record<string, unknown>;
  opportunityId?: string;
  createdBy?: string;
}): Promise<Experiment> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO experiment_results (
         experiment_name, experiment_type, hypothesis, description,
         pilot_tenant_ids, config, success_criteria, opportunity_id, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        data.experimentName,
        data.experimentType,
        data.hypothesis || null,
        data.description || null,
        JSON.stringify(data.pilotTenantIds ?? []),
        JSON.stringify(data.config ?? {}),
        JSON.stringify(data.successCriteria ?? {}),
        data.opportunityId || null,
        data.createdBy || null,
      ],
    );

    await client.query(
      `INSERT INTO evolution_audit_log (entity_type, entity_id, action, new_value, performed_by)
       VALUES ('experiment', $1, 'created', $2, $3)`,
      [rows[0].id, JSON.stringify({ name: data.experimentName, type: data.experimentType }), data.createdBy || null],
    );

    logger.info('Experiment created', { id: rows[0].id, name: data.experimentName });
    return mapExperimentRow(rows[0]);
  });
}

export async function updateExperimentState(
  id: string,
  state: string,
  userId?: string,
  results?: Record<string, unknown>,
): Promise<Experiment | null> {
  const validStates = ['draft', 'active', 'paused', 'concluded', 'cancelled'];
  if (!validStates.includes(state)) {
    throw new Error(`Invalid experiment state: ${state}`);
  }

  return withPrivilegedClient(async (client) => {
    const { rows: oldRows } = await client.query(
      `SELECT * FROM experiment_results WHERE id = $1`,
      [id],
    );
    if (oldRows.length === 0) return null;

    const updates: string[] = [`state = $1`, `updated_at = NOW()`];
    const params: unknown[] = [state];
    let idx = 2;

    if (state === 'active' && !oldRows[0].started_at) {
      updates.push(`started_at = NOW()`);
    }
    if (state === 'concluded' || state === 'cancelled') {
      updates.push(`concluded_at = NOW()`);
    }
    if (results) {
      updates.push(`results = $${idx++}`);
      params.push(JSON.stringify(results));
    }

    params.push(id);

    const { rows } = await client.query(
      `UPDATE experiment_results SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );

    await client.query(
      `INSERT INTO evolution_audit_log (entity_type, entity_id, action, old_value, new_value, performed_by)
       VALUES ('experiment', $1, 'state_change', $2, $3, $4)`,
      [
        id,
        JSON.stringify({ state: oldRows[0].state }),
        JSON.stringify({ state, results: results ?? null }),
        userId || null,
      ],
    );

    if (state === 'concluded' && oldRows[0].opportunity_id) {
      await rescoreOpportunity(client, String(oldRows[0].opportunity_id), results);
    }

    logger.info('Experiment state updated', { id, newState: state });
    return rows[0] ? mapExperimentRow(rows[0]) : null;
  });
}

async function rescoreOpportunity(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  opportunityId: string,
  results?: Record<string, unknown>,
): Promise<void> {
  if (!results) return;

  const successRate = typeof results.successRate === 'number' ? results.successRate : null;
  if (successRate === null) return;

  const scoreBoost = successRate > 0.7 ? 1.5 : successRate > 0.5 ? 0.5 : -1.0;

  await client.query(
    `UPDATE evolution_opportunities SET
       composite_score = GREATEST(0, LEAST(10, composite_score + $1)),
       metadata = jsonb_set(COALESCE(metadata, '{}'), '{experimentResult}', $2),
       updated_at = NOW()
     WHERE id = $3`,
    [scoreBoost, JSON.stringify({ successRate, scoreBoost }), opportunityId],
  );

  logger.info('Opportunity re-scored after experiment', { opportunityId, scoreBoost });
}

export async function getExperiments(options: {
  state?: string;
  type?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ experiments: Experiment[]; total: number }> {
  return withPrivilegedClient(async (client) => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options.state) {
      conditions.push(`state = $${idx++}`);
      params.push(options.state);
    }
    if (options.type) {
      conditions.push(`experiment_type = $${idx++}`);
      params.push(options.type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM experiment_results ${where}`,
      params,
    );

    const { rows } = await client.query(
      `SELECT * FROM experiment_results ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return {
      experiments: rows.map(mapExperimentRow),
      total: parseInt(String(countRows[0]?.total ?? 0), 10),
    };
  });
}

export async function getExperimentById(id: string): Promise<Experiment | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM experiment_results WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapExperimentRow(rows[0]) : null;
  });
}

export async function updateExperiment(
  id: string,
  data: Partial<{
    experimentName: string;
    hypothesis: string;
    description: string;
    pilotTenantIds: string[];
    config: Record<string, unknown>;
    successCriteria: Record<string, unknown>;
  }>,
  userId?: string,
): Promise<Experiment | null> {
  return withPrivilegedClient(async (client) => {
    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (data.experimentName !== undefined) {
      updates.push(`experiment_name = $${idx++}`);
      params.push(data.experimentName);
    }
    if (data.hypothesis !== undefined) {
      updates.push(`hypothesis = $${idx++}`);
      params.push(data.hypothesis);
    }
    if (data.description !== undefined) {
      updates.push(`description = $${idx++}`);
      params.push(data.description);
    }
    if (data.pilotTenantIds !== undefined) {
      updates.push(`pilot_tenant_ids = $${idx++}`);
      params.push(JSON.stringify(data.pilotTenantIds));
    }
    if (data.config !== undefined) {
      updates.push(`config = $${idx++}`);
      params.push(JSON.stringify(data.config));
    }
    if (data.successCriteria !== undefined) {
      updates.push(`success_criteria = $${idx++}`);
      params.push(JSON.stringify(data.successCriteria));
    }

    if (updates.length === 0) return getExperimentById(id);

    updates.push('updated_at = NOW()');
    params.push(id);

    const { rows } = await client.query(
      `UPDATE experiment_results SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );

    if (rows[0]) {
      await client.query(
        `INSERT INTO evolution_audit_log (entity_type, entity_id, action, new_value, performed_by)
         VALUES ('experiment', $1, 'updated', $2, $3)`,
        [id, JSON.stringify(data), userId || null],
      );
    }

    return rows[0] ? mapExperimentRow(rows[0]) : null;
  });
}

function mapExperimentRow(row: Record<string, unknown>): Experiment {
  return {
    id: String(row.id),
    experimentName: String(row.experiment_name),
    experimentType: String(row.experiment_type),
    state: String(row.state),
    hypothesis: row.hypothesis ? String(row.hypothesis) : null,
    description: row.description ? String(row.description) : null,
    pilotTenantIds: (row.pilot_tenant_ids as string[]) ?? [],
    config: (row.config as Record<string, unknown>) ?? {},
    successCriteria: (row.success_criteria as Record<string, unknown>) ?? {},
    results: (row.results as Record<string, unknown>) ?? {},
    opportunityId: row.opportunity_id ? String(row.opportunity_id) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    concludedAt: row.concluded_at ? String(row.concluded_at) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
