import { getPlatformPool, withTenantContext } from '../db';

export interface CallAnalyticsResult {
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  avgDurationSeconds: number;
  completedCalls: number;
  failedCalls: number;
  escalatedCalls: number;
  automationRate: number;
  totalCostCents: number;
  costPerCallCents: number;
  dailyBreakdown: Array<{
    date: string;
    calls: number;
    avgDuration: number;
    inbound: number;
    outbound: number;
  }>;
}

export interface CampaignAnalyticsResult {
  campaigns: Array<{
    campaignId: string;
    campaignName: string;
    totalContacts: number;
    completedContacts: number;
    pendingContacts: number;
    failedContacts: number;
    optedOutContacts: number;
    voicemailContacts: number;
    noAnswerContacts: number;
    answeredRate: number;
    voicemailRate: number;
    completionRate: number;
    avgDurationSeconds: number;
    costPerContactCents: number;
  }>;
}

export interface AgentAnalyticsResult {
  agents: Array<{
    agentId: string;
    agentName: string;
    totalCalls: number;
    avgDurationSeconds: number;
    completedCalls: number;
    failedCalls: number;
    avgQualityScore: number;
  }>;
}

export interface CostAnalyticsResult {
  totalOpenaiCostCents: number;
  totalTwilioCostCents: number;
  totalCostCents: number;
  totalCalls: number;
  costPerCallCents: number;
  dailyBreakdown: Array<{
    date: string;
    openaiCostCents: number;
    twilioCostCents: number;
    totalCostCents: number;
    calls: number;
  }>;
}

export async function getCallAnalytics(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<CallAnalyticsResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: summary } = await client.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound_calls,
         COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound_calls,
         COALESCE(AVG(duration_seconds), 0) AS avg_duration,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed_calls,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_FAILED')::int AS failed_calls,
         COUNT(*) FILTER (WHERE lifecycle_state = 'ESCALATED')::int AS escalated_calls,
         COALESCE(SUM(total_cost_cents), 0)::int AS total_cost_cents
       FROM call_sessions
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3`,
      [tenantId, from, to],
    );

    const { rows: daily } = await client.query(
      `SELECT
         DATE(created_at) AS day,
         COUNT(*)::int AS calls,
         COALESCE(AVG(duration_seconds), 0) AS avg_duration,
         COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound,
         COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound
       FROM call_sessions
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
       GROUP BY DATE(created_at)
       ORDER BY day`,
      [tenantId, from, to],
    );

    await client.query('COMMIT');

    const s = summary[0];
    const totalCalls = (s?.total_calls as number) ?? 0;
    const escalatedCalls = (s?.escalated_calls as number) ?? 0;
    const automationRate =
      totalCalls > 0 ? (totalCalls - escalatedCalls) / totalCalls : 0;
    const totalCostCents = (s?.total_cost_cents as number) ?? 0;

    return {
      totalCalls,
      inboundCalls: (s?.inbound_calls as number) ?? 0,
      outboundCalls: (s?.outbound_calls as number) ?? 0,
      avgDurationSeconds: parseFloat(String(s?.avg_duration ?? 0)),
      completedCalls: (s?.completed_calls as number) ?? 0,
      failedCalls: (s?.failed_calls as number) ?? 0,
      escalatedCalls,
      automationRate,
      totalCostCents,
      costPerCallCents: totalCalls > 0 ? Math.round(totalCostCents / totalCalls) : 0,
      dailyBreakdown: daily.map((r) => ({
        date: String(r.day).slice(0, 10),
        calls: r.calls as number,
        avgDuration: parseFloat(String(r.avg_duration)),
        inbound: r.inbound as number,
        outbound: r.outbound as number,
      })),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getCampaignAnalytics(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<CampaignAnalyticsResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT
         c.id AS campaign_id,
         c.name AS campaign_name,
         COUNT(cc.id)::int AS total_contacts,
         COUNT(cc.id) FILTER (WHERE cc.status = 'completed' AND cc.updated_at >= $2 AND cc.updated_at < $3)::int AS completed_contacts,
         COUNT(cc.id) FILTER (WHERE cc.status = 'pending')::int AS pending_contacts,
         COUNT(cc.id) FILTER (WHERE (cc.status = 'failed' OR cc.status = 'no_answer') AND cc.updated_at >= $2 AND cc.updated_at < $3)::int AS failed_contacts,
         COUNT(cc.id) FILTER (WHERE cc.status = 'opted_out' AND cc.updated_at >= $2 AND cc.updated_at < $3)::int AS opted_out_contacts,
         COUNT(cc.id) FILTER (WHERE cc.status = 'voicemail' AND cc.updated_at >= $2 AND cc.updated_at < $3)::int AS voicemail_contacts,
         COUNT(cc.id) FILTER (WHERE cc.status = 'no_answer' AND cc.updated_at >= $2 AND cc.updated_at < $3)::int AS no_answer_contacts,
         COUNT(cc.id) FILTER (WHERE cc.outcome = 'human_answered' AND cc.updated_at >= $2 AND cc.updated_at < $3)::int AS answered_contacts
       FROM campaigns c
       JOIN campaign_contacts cc ON cc.campaign_id = c.id
       WHERE c.tenant_id = $1
         AND cc.updated_at >= $2
         AND cc.updated_at < $3
       GROUP BY c.id, c.name
       ORDER BY c.name`,
      [tenantId, from, to],
    );

    const campaignIds = rows.map((r) => r.campaign_id as string);

    const durationByCampaign = new Map<string, number>();
    const costByCampaign = new Map<string, { totalCost: number; contactCount: number }>();

    if (campaignIds.length > 0) {
      const { rows: durationRows } = await client.query(
        `SELECT
           cc.campaign_id,
           COALESCE(AVG(cca.duration_seconds), 0) AS avg_dur
         FROM campaign_contact_attempts cca
         JOIN campaign_contacts cc ON cc.id = cca.campaign_contact_id
         WHERE cc.campaign_id = ANY($1)
           AND cca.attempted_at >= $2
           AND cca.attempted_at < $3
         GROUP BY cc.campaign_id`,
        [campaignIds, from, to],
      );
      for (const r of durationRows) {
        durationByCampaign.set(r.campaign_id as string, parseFloat(String(r.avg_dur)));
      }

      const { rows: costRows } = await client.query(
        `SELECT
           cs.context->>'campaignId' AS campaign_id,
           COALESCE(SUM(cs.total_cost_cents), 0)::int AS total_cost
         FROM call_sessions cs
         WHERE cs.tenant_id = $1
           AND cs.context->>'campaignId' = ANY($2)
           AND cs.created_at >= $3
           AND cs.created_at < $4
         GROUP BY cs.context->>'campaignId'`,
        [tenantId, campaignIds, from, to],
      );
      for (const r of costRows) {
        const cid = r.campaign_id as string;
        costByCampaign.set(cid, {
          totalCost: (r.total_cost as number) ?? 0,
          contactCount: 0,
        });
      }
    }

    await client.query('COMMIT');

    return {
      campaigns: rows.map((r) => {
        const total = (r.total_contacts as number) ?? 0;
        const completed = (r.completed_contacts as number) ?? 0;
        const answered = (r.answered_contacts as number) ?? 0;
        const voicemail = (r.voicemail_contacts as number) ?? 0;
        const failed = (r.failed_contacts as number) ?? 0;
        const contacted = completed + voicemail + failed;
        const campaignId = r.campaign_id as string;
        const costData = costByCampaign.get(campaignId);
        const costPerContact = total > 0 && costData
          ? Math.round(costData.totalCost / total)
          : 0;

        return {
          campaignId,
          campaignName: r.campaign_name as string,
          totalContacts: total,
          completedContacts: completed,
          pendingContacts: (r.pending_contacts as number) ?? 0,
          failedContacts: failed,
          optedOutContacts: (r.opted_out_contacts as number) ?? 0,
          voicemailContacts: voicemail,
          noAnswerContacts: (r.no_answer_contacts as number) ?? 0,
          answeredRate: contacted > 0 ? answered / contacted : 0,
          voicemailRate: contacted > 0 ? voicemail / contacted : 0,
          completionRate: total > 0 ? completed / total : 0,
          avgDurationSeconds: durationByCampaign.get(campaignId) ?? 0,
          costPerContactCents: costPerContact,
        };
      }),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getAgentAnalytics(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<AgentAnalyticsResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT
         a.id AS agent_id,
         a.name AS agent_name,
         COUNT(cs.id)::int AS total_calls,
         COALESCE(AVG(cs.duration_seconds), 0) AS avg_duration,
         COUNT(cs.id) FILTER (WHERE cs.lifecycle_state = 'CALL_COMPLETED')::int AS completed_calls,
         COUNT(cs.id) FILTER (WHERE cs.lifecycle_state = 'CALL_FAILED')::int AS failed_calls
       FROM agents a
       LEFT JOIN call_sessions cs ON cs.agent_id = a.id
         AND cs.created_at >= $2
         AND cs.created_at < $3
       WHERE a.tenant_id = $1
       GROUP BY a.id, a.name
       ORDER BY total_calls DESC`,
      [tenantId, from, to],
    );

    const agentIds = rows.map((r) => r.agent_id as string);
    const qualityByAgent = new Map<string, number>();

    if (agentIds.length > 0) {
      const { rows: qualityRows } = await client.query(
        `SELECT
           cs.agent_id,
           COALESCE(AVG(cqs.score), 0) AS avg_score
         FROM call_quality_scores cqs
         JOIN call_sessions cs ON cs.id = cqs.call_session_id AND cs.tenant_id = cqs.tenant_id
         WHERE cqs.tenant_id = $1
           AND cs.agent_id = ANY($2)
           AND cqs.scored_at >= $3
           AND cqs.scored_at < $4
         GROUP BY cs.agent_id`,
        [tenantId, agentIds, from, to],
      );
      for (const qr of qualityRows) {
        qualityByAgent.set(qr.agent_id as string, parseFloat(String(qr.avg_score ?? 0)));
      }
    }

    await client.query('COMMIT');

    return {
      agents: rows.map((r) => ({
        agentId: r.agent_id as string,
        agentName: r.agent_name as string,
        totalCalls: (r.total_calls as number) ?? 0,
        avgDurationSeconds: parseFloat(String(r.avg_duration ?? 0)),
        completedCalls: (r.completed_calls as number) ?? 0,
        failedCalls: (r.failed_calls as number) ?? 0,
        avgQualityScore: qualityByAgent.get(r.agent_id as string) ?? 0,
      })),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getCostAnalytics(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<CostAnalyticsResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: aiRows } = await client.query(
      `SELECT
         DATE(period_start) AS day,
         COALESCE(SUM(total_cost_cents), 0)::int AS cost_cents
       FROM usage_metrics
       WHERE tenant_id = $1
         AND metric_type = 'ai_minutes'
         AND period_start >= $2
         AND period_start < $3
       GROUP BY DATE(period_start)
       ORDER BY day`,
      [tenantId, from, to],
    );

    const { rows: telRows } = await client.query(
      `SELECT
         DATE(period_start) AS day,
         COALESCE(SUM(total_cost_cents), 0)::int AS cost_cents
       FROM usage_metrics
       WHERE tenant_id = $1
         AND metric_type IN ('calls_inbound', 'calls_outbound')
         AND period_start >= $2
         AND period_start < $3
       GROUP BY DATE(period_start)
       ORDER BY day`,
      [tenantId, from, to],
    );

    const { rows: callCountRows } = await client.query(
      `SELECT
         DATE(created_at) AS day,
         COUNT(*)::int AS calls
       FROM call_sessions
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3
       GROUP BY DATE(created_at)
       ORDER BY day`,
      [tenantId, from, to],
    );

    await client.query('COMMIT');

    const aiByDay = new Map(aiRows.map((r) => [String(r.day).slice(0, 10), (r.cost_cents as number) ?? 0]));
    const telByDay = new Map(telRows.map((r) => [String(r.day).slice(0, 10), (r.cost_cents as number) ?? 0]));
    const callsByDay = new Map(callCountRows.map((r) => [String(r.day).slice(0, 10), (r.calls as number) ?? 0]));

    const allDays = new Set([...aiByDay.keys(), ...telByDay.keys(), ...callsByDay.keys()]);
    const sortedDays = [...allDays].sort();

    let totalOpenai = 0;
    let totalTwilio = 0;
    let totalCalls = 0;

    const dailyBreakdown = sortedDays.map((day) => {
      const ai = aiByDay.get(day) ?? 0;
      const tel = telByDay.get(day) ?? 0;
      const calls = callsByDay.get(day) ?? 0;
      totalOpenai += ai;
      totalTwilio += tel;
      totalCalls += calls;
      return {
        date: day,
        openaiCostCents: ai,
        twilioCostCents: tel,
        totalCostCents: ai + tel,
        calls,
      };
    });

    const totalCost = totalOpenai + totalTwilio;

    return {
      totalOpenaiCostCents: totalOpenai,
      totalTwilioCostCents: totalTwilio,
      totalCostCents: totalCost,
      totalCalls,
      costPerCallCents: totalCalls > 0 ? Math.round(totalCost / totalCalls) : 0,
      dailyBreakdown,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
