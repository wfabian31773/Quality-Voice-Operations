import { withPrivilegedClient } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('SIGNAL_COLLECTOR');

type DbClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> };

const SIGNAL_UPSERT_SQL = `INSERT INTO evolution_signals (source, signal_type, title, description, tenant_id, strength, raw_data, period_start, period_end)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (source, signal_type, COALESCE(tenant_id, '__global__'), COALESCE(period_start, '1970-01-01'::timestamptz), md5(title))
  DO UPDATE SET description = EXCLUDED.description,
    strength = EXCLUDED.strength, raw_data = EXCLUDED.raw_data`;

async function upsertSignal(
  client: DbClient,
  source: string, signalType: string, title: string, description: string,
  tenantId: string | null, strength: number, rawData: Record<string, unknown>,
  periodStart: Date, periodEnd: Date,
): Promise<void> {
  await client.query(SIGNAL_UPSERT_SQL, [
    source, signalType, title, description, tenantId, strength,
    JSON.stringify(rawData), periodStart, periodEnd,
  ]);
}

export interface EvolutionSignal {
  id: string;
  source: string;
  signalType: string;
  title: string;
  description: string | null;
  tenantId: string | null;
  strength: number;
  rawData: Record<string, unknown>;
  metadata: Record<string, unknown>;
  collectedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
}

async function collectCallQualitySignals(periodStart: Date, periodEnd: Date): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT
         cs.tenant_id,
         COUNT(*)::int AS total_calls,
         COUNT(*) FILTER (WHERE cs.lifecycle_state = 'CALL_FAILED')::int AS failed_calls,
         COUNT(*) FILTER (WHERE cs.lifecycle_state = 'ESCALATED' OR cs.escalation_target IS NOT NULL)::int AS escalated_calls,
         COALESCE(AVG(cs.duration_seconds) FILTER (WHERE cs.duration_seconds > 0), 0)::float AS avg_duration,
         COALESCE(AVG(cqs.score), 0)::float AS avg_quality
       FROM call_sessions cs
       LEFT JOIN call_quality_scores cqs ON cqs.call_session_id = cs.id AND cqs.tenant_id = cs.tenant_id
       WHERE cs.created_at >= $1 AND cs.created_at < $2
       GROUP BY cs.tenant_id
       HAVING COUNT(*) >= 5`,
      [periodStart, periodEnd],
    );

    for (const row of rows) {
      const totalCalls = parseInt(String(row.total_calls), 10) || 0;
      const failedCalls = parseInt(String(row.failed_calls), 10) || 0;
      const escalatedCalls = parseInt(String(row.escalated_calls), 10) || 0;
      const avgQuality = parseFloat(String(row.avg_quality)) || 0;
      const failRate = totalCalls > 0 ? failedCalls / totalCalls : 0;
      const escalationRate = totalCalls > 0 ? escalatedCalls / totalCalls : 0;

      if (failRate > 0.1) {
        await upsertSignal(client, 'call_analytics', 'high_failure_rate',
          `High call failure rate: ${(failRate * 100).toFixed(1)}%`,
          `Tenant has ${failedCalls} failed calls out of ${totalCalls} total`,
          String(row.tenant_id), Math.min(failRate * 5, 5),
          { failRate, totalCalls, failedCalls }, periodStart, periodEnd);
      }

      if (escalationRate > 0.15) {
        await upsertSignal(client, 'call_analytics', 'high_escalation_rate',
          `High escalation rate: ${(escalationRate * 100).toFixed(1)}%`,
          `Tenant has ${escalatedCalls} escalated calls suggesting agent capability gaps`,
          String(row.tenant_id), Math.min(escalationRate * 4, 5),
          { escalationRate, totalCalls, escalatedCalls }, periodStart, periodEnd);
      }

      if (avgQuality > 0 && avgQuality < 5) {
        await upsertSignal(client, 'call_analytics', 'low_quality_score',
          `Low average quality score: ${avgQuality.toFixed(1)}`,
          `Quality scores indicate room for improvement in AI agent performance`,
          String(row.tenant_id), Math.max(1, 5 - avgQuality),
          { avgQuality, totalCalls }, periodStart, periodEnd);
      }
    }

    logger.info('Collected call quality signals', { tenantCount: rows.length });
  });
}

async function collectMarketplaceSignals(periodStart: Date, periodEnd: Date): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows: installEvents } = await client.query(
      `SELECT
         tr.slug AS template_slug,
         tr.display_name AS template_name,
         COUNT(*) FILTER (WHERE tie.event_type = 'installed')::int AS installs,
         COUNT(*) FILTER (WHERE tie.event_type = 'uninstalled')::int AS uninstalls,
         COUNT(DISTINCT tie.tenant_id)::int AS unique_tenants
       FROM template_install_events tie
       JOIN template_registry tr ON tr.id = tie.template_id
       WHERE tie.created_at >= $1 AND tie.created_at < $2
       GROUP BY tr.slug, tr.display_name
       HAVING COUNT(*) >= 2`,
      [periodStart, periodEnd],
    );

    for (const row of installEvents) {
      const installs = parseInt(String(row.installs), 10) || 0;
      const uninstalls = parseInt(String(row.uninstalls), 10) || 0;
      const uniqueTenants = parseInt(String(row.unique_tenants), 10) || 0;
      const uninstallRate = installs > 0 ? uninstalls / installs : 0;

      if (uninstallRate > 0.3) {
        await upsertSignal(client, 'marketplace', 'high_uninstall_rate',
          `High uninstall rate for "${String(row.template_name)}": ${(uninstallRate * 100).toFixed(0)}%`,
          `Template ${String(row.template_slug)} has ${uninstalls} uninstalls out of ${installs} installs`,
          null, Math.min(uninstallRate * 4, 5),
          { templateSlug: String(row.template_slug), installs, uninstalls, uniqueTenants },
          periodStart, periodEnd);
      }

      if (installs >= 5) {
        await upsertSignal(client, 'marketplace', 'popular_template',
          `Popular template: "${String(row.template_name)}" with ${installs} installs`,
          `Strong demand signal for ${String(row.template_slug)} across ${uniqueTenants} tenants`,
          null, Math.min(installs / 3, 5),
          { templateSlug: String(row.template_slug), installs, uniqueTenants },
          periodStart, periodEnd);
      }
    }

    logger.info('Collected marketplace signals', { eventCount: installEvents.length });
  });
}

async function collectUsageMetricSignals(periodStart: Date, periodEnd: Date): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT
         t.id AS tenant_id,
         t.name AS tenant_name,
         t.plan,
         COALESCE(SUM(um.quantity) FILTER (WHERE um.metric_type = 'ai_minutes'), 0)::float AS ai_minutes,
         COALESCE(SUM(um.quantity) FILTER (WHERE um.metric_type IN ('calls_inbound', 'calls_outbound')), 0)::int AS call_count,
         COALESCE(SUM(um.quantity) FILTER (WHERE um.metric_type = 'tool_executions'), 0)::int AS tool_executions
       FROM tenants t
       LEFT JOIN usage_metrics um ON um.tenant_id = t.id AND um.period_start >= $1 AND um.period_start < $2
       WHERE t.status = 'active'
       GROUP BY t.id, t.name, t.plan`,
      [periodStart, periodEnd],
    );

    for (const row of rows) {
      const callCount = parseInt(String(row.call_count), 10) || 0;
      const aiMinutes = parseFloat(String(row.ai_minutes)) || 0;
      const toolExecs = parseInt(String(row.tool_executions), 10) || 0;
      if (callCount === 0 && aiMinutes === 0) {
        await upsertSignal(client, 'usage_metrics', 'inactive_tenant',
          `Inactive tenant: ${row.tenant_name}`,
          `No calls or AI usage detected in the analysis period`,
          String(row.tenant_id), 3.0,
          { plan: row.plan, aiMinutes, callCount }, periodStart, periodEnd);
      }

      if (toolExecs > 100) {
        await upsertSignal(client, 'usage_metrics', 'heavy_tool_usage',
          `Heavy tool usage: ${toolExecs} executions by ${String(row.tenant_name)}`,
          `High tool execution count suggests power user patterns`,
          String(row.tenant_id), Math.min(toolExecs / 50, 5),
          { toolExecutions: toolExecs, callCount }, periodStart, periodEnd);
      }
    }

    logger.info('Collected usage metric signals', { tenantCount: rows.length });
  });
}

async function collectChurnSignals(periodStart: Date, periodEnd: Date): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT
         t.id AS tenant_id,
         t.name AS tenant_name,
         t.plan,
         t.created_at AS tenant_created,
         (SELECT MAX(cs.created_at) FROM call_sessions cs WHERE cs.tenant_id = t.id) AS last_call_at,
         (SELECT COUNT(*)::int FROM call_sessions cs WHERE cs.tenant_id = t.id AND cs.created_at >= NOW() - INTERVAL '30 days') AS calls_last_30d,
         (SELECT COUNT(*)::int FROM call_sessions cs WHERE cs.tenant_id = t.id AND cs.created_at >= NOW() - INTERVAL '60 days' AND cs.created_at < NOW() - INTERVAL '30 days') AS calls_prev_30d
       FROM tenants t
       WHERE t.status = 'active'
         AND t.created_at < NOW() - INTERVAL '14 days'`,
      [],
    );

    for (const row of rows) {
      const callsLast30d = parseInt(String(row.calls_last_30d), 10) || 0;
      const callsPrev30d = parseInt(String(row.calls_prev_30d), 10) || 0;
      const decline = callsPrev30d > 0 ? (callsPrev30d - callsLast30d) / callsPrev30d : 0;

      if (decline > 0.5 && callsPrev30d >= 5) {
        await upsertSignal(client, 'churn', 'usage_decline',
          `Usage decline: ${(decline * 100).toFixed(0)}% drop for ${String(row.tenant_name)}`,
          `Call volume dropped from ${callsPrev30d} to ${callsLast30d} in the last 30 days`,
          String(row.tenant_id), Math.min(decline * 5, 5),
          { decline, callsLast30d, callsPrev30d, plan: row.plan }, periodStart, periodEnd);
      }

      if (!row.last_call_at && row.tenant_created) {
        const daysSinceCreated = (Date.now() - new Date(String(row.tenant_created)).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceCreated > 7) {
          await upsertSignal(client, 'churn', 'never_activated',
            `Never activated: ${row.tenant_name} (${Math.round(daysSinceCreated)} days old)`,
            `Tenant created ${Math.round(daysSinceCreated)} days ago but has never made a call`,
            String(row.tenant_id), Math.min(daysSinceCreated / 7, 5),
            { daysSinceCreated: Math.round(daysSinceCreated), plan: row.plan }, periodStart, periodEnd);
        }
      }
    }

    logger.info('Collected churn signals', { tenantCount: rows.length });
  });
}

async function collectVerticalDemandSignals(periodStart: Date, periodEnd: Date): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT
         COALESCE(a.type, 'general') AS vertical,
         COUNT(DISTINCT a.tenant_id)::int AS tenant_count,
         COUNT(cs.id)::int AS total_calls,
         COUNT(cs.id) FILTER (WHERE cs.lifecycle_state = 'CALL_COMPLETED')::int AS completed_calls,
         COALESCE(AVG(cs.duration_seconds) FILTER (WHERE cs.duration_seconds > 0), 0)::float AS avg_duration
       FROM agents a
       LEFT JOIN call_sessions cs ON cs.agent_id = a.id AND cs.tenant_id = a.tenant_id
         AND cs.created_at >= $1 AND cs.created_at < $2
       WHERE a.status = 'active'
       GROUP BY COALESCE(a.type, 'general')
       HAVING COUNT(DISTINCT a.tenant_id) >= 2`,
      [periodStart, periodEnd],
    );

    for (const row of rows) {
      const vTenantCount = parseInt(String(row.tenant_count), 10) || 0;
      const vTotalCalls = parseInt(String(row.total_calls), 10) || 0;
      const vCompletedCalls = parseInt(String(row.completed_calls), 10) || 0;
      const vAvgDuration = parseFloat(String(row.avg_duration)) || 0;
      await upsertSignal(client, 'usage_metrics', 'vertical_demand',
        `Vertical demand: ${String(row.vertical)} (${vTenantCount} tenants, ${vTotalCalls} calls)`,
        `${String(row.vertical)} vertical has ${vTenantCount} active tenants generating ${vTotalCalls} calls`,
        null, Math.min(vTenantCount + vTotalCalls / 50, 5),
        { vertical: String(row.vertical), tenantCount: vTenantCount, totalCalls: vTotalCalls, completedCalls: vCompletedCalls, avgDuration: Math.round(vAvgDuration) },
        periodStart, periodEnd);
    }

    logger.info('Collected vertical demand signals', { verticalCount: rows.length });
  });
}

async function collectOnboardingSignals(periodStart: Date, periodEnd: Date): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT
         t.id AS tenant_id,
         t.name AS tenant_name,
         t.plan,
         t.created_at AS tenant_created,
         (SELECT COUNT(*)::int FROM agents a WHERE a.tenant_id = t.id) AS agent_count,
         (SELECT COUNT(*)::int FROM call_sessions cs WHERE cs.tenant_id = t.id) AS call_count
       FROM tenants t
       WHERE t.status = 'active'
         AND t.created_at >= $1 AND t.created_at < $2`,
      [periodStart, periodEnd],
    );

    for (const row of rows) {
      const agentCount = parseInt(String(row.agent_count), 10) || 0;
      const callCount = parseInt(String(row.call_count), 10) || 0;

      if (agentCount === 0) {
        await upsertSignal(client, 'onboarding', 'no_agents_created',
          `Onboarding drop-off: ${row.tenant_name} created no agents`,
          `Tenant signed up but has not created any agents yet`,
          String(row.tenant_id), 4.0,
          { plan: row.plan, agentCount, callCount }, periodStart, periodEnd);
      } else if (callCount === 0) {
        await upsertSignal(client, 'onboarding', 'no_calls_made',
          `Onboarding gap: ${row.tenant_name} has agents but no calls`,
          `Tenant created ${agentCount} agents but never made a call`,
          String(row.tenant_id), 3.5,
          { plan: row.plan, agentCount, callCount }, periodStart, periodEnd);
      }
    }

    logger.info('Collected onboarding signals', { newTenantCount: rows.length });
  });
}

async function collectDemoBehaviorSignals(periodStart: Date, periodEnd: Date): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT
         cs.tenant_id,
         t.name AS tenant_name,
         COUNT(*)::int AS early_calls,
         COALESCE(AVG(cs.duration_seconds) FILTER (WHERE cs.duration_seconds > 0), 0)::float AS avg_duration,
         COUNT(*) FILTER (WHERE cs.lifecycle_state = 'CALL_COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE cs.lifecycle_state = 'CALL_FAILED')::int AS failed
       FROM call_sessions cs
       JOIN tenants t ON t.id = cs.tenant_id
       WHERE cs.created_at >= $1 AND cs.created_at < $2
         AND t.created_at >= $1 - INTERVAL '14 days'
       GROUP BY cs.tenant_id, t.name
       HAVING COUNT(*) >= 2`,
      [periodStart, periodEnd],
    );

    for (const row of rows) {
      const earlyCalls = parseInt(String(row.early_calls), 10) || 0;
      const avgDuration = parseFloat(String(row.avg_duration)) || 0;
      const failed = parseInt(String(row.failed), 10) || 0;
      const failRate = earlyCalls > 0 ? failed / earlyCalls : 0;

      if (failRate > 0.3) {
        await upsertSignal(client, 'onboarding', 'early_call_failure_rate',
          `High early call failure rate for ${row.tenant_name}: ${(failRate * 100).toFixed(0)}%`,
          `${failed} of ${earlyCalls} early calls failed for new tenant, indicating onboarding issues`,
          String(row.tenant_id), Math.min(failRate * 5, 5),
          { earlyCalls, failed, failRate, avgDuration }, periodStart, periodEnd);
      }

      if (avgDuration > 0 && avgDuration < 15) {
        await upsertSignal(client, 'onboarding', 'short_early_calls',
          `Short early calls for ${row.tenant_name}: avg ${avgDuration.toFixed(0)}s`,
          `New tenant calls are very short, suggesting demo/trial engagement issues`,
          String(row.tenant_id), 3.0,
          { earlyCalls, avgDuration }, periodStart, periodEnd);
      }
    }

    logger.info('Collected demo/early behavior signals', { tenantCount: rows.length });
  });
}

async function collectSupportPatternSignals(periodStart: Date, periodEnd: Date): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT
         cs.tenant_id,
         t.name AS tenant_name,
         COUNT(*) FILTER (WHERE cs.escalation_reason IS NOT NULL)::int AS escalation_count,
         COUNT(*) FILTER (WHERE cs.lifecycle_state = 'CALL_FAILED')::int AS error_count,
         COUNT(*)::int AS total_calls,
         array_agg(DISTINCT cs.escalation_reason) FILTER (WHERE cs.escalation_reason IS NOT NULL) AS escalation_reasons
       FROM call_sessions cs
       JOIN tenants t ON t.id = cs.tenant_id
       WHERE cs.created_at >= $1 AND cs.created_at < $2
       GROUP BY cs.tenant_id, t.name
       HAVING COUNT(*) FILTER (WHERE cs.escalation_reason IS NOT NULL) >= 3
          OR COUNT(*) FILTER (WHERE cs.lifecycle_state = 'CALL_FAILED') >= 5`,
      [periodStart, periodEnd],
    );

    for (const row of rows) {
      const escalationCount = parseInt(String(row.escalation_count), 10) || 0;
      const errorCount = parseInt(String(row.error_count), 10) || 0;
      const totalCalls = parseInt(String(row.total_calls), 10) || 0;
      const reasons = Array.isArray(row.escalation_reasons) ? row.escalation_reasons.filter(Boolean) : [];

      if (escalationCount >= 3) {
        await upsertSignal(client, 'support_patterns', 'frequent_escalations',
          `Frequent escalations: ${row.tenant_name} (${escalationCount} in period)`,
          `Common reasons: ${reasons.slice(0, 3).join(', ') || 'unspecified'}`,
          String(row.tenant_id), Math.min(escalationCount / 2, 5),
          { escalationCount, totalCalls, reasons: reasons.slice(0, 5) }, periodStart, periodEnd);
      }

      if (errorCount >= 5) {
        await upsertSignal(client, 'support_patterns', 'high_error_rate',
          `High error rate: ${row.tenant_name} (${errorCount} failures)`,
          `${errorCount} call failures out of ${totalCalls} total calls`,
          String(row.tenant_id), Math.min(errorCount / 3, 5),
          { errorCount, totalCalls }, periodStart, periodEnd);
      }
    }

    logger.info('Collected support pattern signals', { tenantCount: rows.length });
  });
}

async function collectFeatureRequestSignals(periodStart: Date, periodEnd: Date): Promise<void> {
  await withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT
         signal_type,
         COUNT(*)::int AS occurrence_count,
         COUNT(DISTINCT tenant_id)::int AS unique_tenants,
         array_agg(DISTINCT tenant_id) FILTER (WHERE tenant_id IS NOT NULL) AS tenant_ids
       FROM evolution_signals
       WHERE source IN ('usage_metrics', 'call_analytics', 'marketplace')
         AND collected_at >= $1 AND collected_at < $2
       GROUP BY signal_type
       HAVING COUNT(*) >= 3
       ORDER BY occurrence_count DESC`,
      [periodStart, periodEnd],
    );

    for (const row of rows) {
      const occurrences = parseInt(String(row.occurrence_count), 10) || 0;
      const uniqueTenants = parseInt(String(row.unique_tenants), 10) || 0;

      if (uniqueTenants >= 2) {
        await upsertSignal(client, 'feature_request', 'cross_tenant_pattern',
          `Cross-tenant pattern: ${row.signal_type} (${uniqueTenants} tenants)`,
          `Signal type "${row.signal_type}" appears across ${uniqueTenants} tenants, suggesting common need`,
          null, Math.min(uniqueTenants * 1.5, 5),
          { signalType: row.signal_type, occurrences, uniqueTenants }, periodStart, periodEnd);
      }
    }

    logger.info('Collected feature request signals', { patternCount: rows.length });
  });
}

function getStableWeekBucket(): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const startOfWeek = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOfWeek));
  startOfWeek.setUTCHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { periodStart: startOfWeek, periodEnd: endOfWeek };
}

export async function runSignalCollection(): Promise<number> {
  const { periodStart, periodEnd } = getStableWeekBucket();

  logger.info('Starting signal collection', { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() });

  let totalSignals = 0;

  try {
    await collectCallQualitySignals(periodStart, periodEnd);
    await collectMarketplaceSignals(periodStart, periodEnd);
    await collectUsageMetricSignals(periodStart, periodEnd);
    await collectChurnSignals(periodStart, periodEnd);
    await collectVerticalDemandSignals(periodStart, periodEnd);
    await collectOnboardingSignals(periodStart, periodEnd);
    await collectDemoBehaviorSignals(periodStart, periodEnd);
    await collectSupportPatternSignals(periodStart, periodEnd);
    await collectFeatureRequestSignals(periodStart, periodEnd);

    const result = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS count FROM evolution_signals WHERE collected_at >= $1`,
        [periodStart],
      );
      return parseInt(String(rows[0]?.count ?? 0), 10);
    });

    totalSignals = result;
    logger.info('Signal collection completed', { totalSignals });
  } catch (err) {
    logger.error('Signal collection failed', { error: String(err) });
    throw err;
  }

  return totalSignals;
}

export async function getSignals(options: {
  source?: string;
  signalType?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ signals: EvolutionSignal[]; total: number }> {
  return withPrivilegedClient(async (client) => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options.source) {
      conditions.push(`source = $${idx++}`);
      params.push(options.source);
    }
    if (options.signalType) {
      conditions.push(`signal_type = $${idx++}`);
      params.push(options.signalType);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM evolution_signals ${where}`,
      params,
    );

    const { rows } = await client.query(
      `SELECT * FROM evolution_signals ${where} ORDER BY collected_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return {
      signals: rows.map(mapSignalRow),
      total: parseInt(String(countRows[0]?.total ?? 0), 10),
    };
  });
}

function mapSignalRow(row: Record<string, unknown>): EvolutionSignal {
  return {
    id: String(row.id),
    source: String(row.source),
    signalType: String(row.signal_type),
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    tenantId: row.tenant_id ? String(row.tenant_id) : null,
    strength: parseFloat(String(row.strength)) || 0,
    rawData: (row.raw_data as Record<string, unknown>) ?? {},
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    collectedAt: String(row.collected_at),
    periodStart: row.period_start ? String(row.period_start) : null,
    periodEnd: row.period_end ? String(row.period_end) : null,
  };
}
