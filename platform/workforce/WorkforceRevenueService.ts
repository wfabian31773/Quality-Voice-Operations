import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { getRevenueAttribution, type RevenueAttributionResult } from '../analytics/RevenueAttributionService';
import type { WorkforceRevenueMetrics } from './types';

const logger = createLogger('WORKFORCE_REVENUE');

function mapRevenueRow(row: Record<string, unknown>): WorkforceRevenueMetrics {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    teamId: row.team_id as string,
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    callsHandled: (row.calls_handled as number) ?? 0,
    bookingsGenerated: (row.bookings_generated as number) ?? 0,
    missedCallsRecovered: (row.missed_calls_recovered as number) ?? 0,
    estimatedRevenueCents: (row.estimated_revenue_cents as number) ?? 0,
    missedRevenueCents: (row.missed_revenue_cents as number) ?? 0,
    avgTicketValueCents: (row.avg_ticket_value_cents as number) ?? 15000,
    agentBreakdown: Array.isArray(row.agent_breakdown) ? row.agent_breakdown as WorkforceRevenueMetrics['agentBreakdown'] : [],
    dailyBreakdown: Array.isArray(row.daily_breakdown) ? row.daily_breakdown as WorkforceRevenueMetrics['dailyBreakdown'] : [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class WorkforceRevenueService {
  async calculateMetrics(
    tenantId: string,
    teamId: string,
    from: Date,
    to: Date,
    avgTicketValueCents = 15000,
  ): Promise<WorkforceRevenueMetrics> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {});

      const { rows: members } = await client.query(
        `SELECT wm.agent_id, a.name as agent_name
         FROM workforce_members wm
         JOIN agents a ON a.id = wm.agent_id
         WHERE wm.team_id = $1 AND wm.status = 'active'`,
        [teamId],
      );

      const agentIds = members.map((m) => m.agent_id as string);
      if (agentIds.length === 0) {
        await client.query('COMMIT');
        const empty: WorkforceRevenueMetrics = {
          id: '', tenantId, teamId,
          periodStart: from.toISOString(), periodEnd: to.toISOString(),
          callsHandled: 0, bookingsGenerated: 0, missedCallsRecovered: 0,
          estimatedRevenueCents: 0, missedRevenueCents: 0, avgTicketValueCents,
          agentBreakdown: [], dailyBreakdown: [],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        return empty;
      }

      const { rows: agentStats } = await client.query(
        `SELECT
           cs.agent_id,
           COUNT(*)::int AS calls_handled,
           COUNT(*) FILTER (
             WHERE cs.context->>'callOutcome' IS NOT NULL
               AND (cs.context->'callOutcome'->>'disposition') = 'resolved'
           )::int AS bookings_generated
         FROM call_sessions cs
         WHERE cs.agent_id = ANY($1)
           AND cs.tenant_id = $2
           AND cs.created_at >= $3
           AND cs.created_at < $4
         GROUP BY cs.agent_id`,
        [agentIds, tenantId, from, to],
      );

      const { rows: missedRecovery } = await client.query(
        `SELECT COUNT(*)::int AS recovered
         FROM call_sessions cs
         WHERE cs.agent_id = ANY($1)
           AND cs.tenant_id = $2
           AND cs.created_at >= $3
           AND cs.created_at < $4
           AND cs.direction = 'inbound'
           AND cs.lifecycle_state = 'CALL_COMPLETED'
           AND cs.context->>'callOutcome' IS NOT NULL`,
        [agentIds, tenantId, from, to],
      );

      const { rows: missedOpps } = await client.query(
        `SELECT COUNT(*)::int AS missed
         FROM call_sessions cs
         WHERE cs.agent_id = ANY($1)
           AND cs.tenant_id = $2
           AND cs.created_at >= $3
           AND cs.created_at < $4
           AND cs.lifecycle_state IN ('CALL_FAILED', 'ESCALATED')
           AND cs.duration_seconds > 30`,
        [agentIds, tenantId, from, to],
      );

      const { rows: dailyRows } = await client.query(
        `SELECT
           DATE(cs.created_at) AS day,
           COUNT(*)::int AS calls_handled,
           COUNT(*) FILTER (
             WHERE cs.context->>'callOutcome' IS NOT NULL
               AND (cs.context->'callOutcome'->>'disposition') = 'resolved'
           )::int AS bookings_generated
         FROM call_sessions cs
         WHERE cs.agent_id = ANY($1)
           AND cs.tenant_id = $2
           AND cs.created_at >= $3
           AND cs.created_at < $4
         GROUP BY DATE(cs.created_at)
         ORDER BY day`,
        [agentIds, tenantId, from, to],
      );

      await client.query('COMMIT');

      const agentNameMap = new Map(members.map((m) => [m.agent_id as string, m.agent_name as string]));

      const agentBreakdown = agentStats.map((r) => {
        const booked = (r.bookings_generated as number) ?? 0;
        return {
          agentId: r.agent_id as string,
          agentName: agentNameMap.get(r.agent_id as string) ?? 'Unknown',
          callsHandled: (r.calls_handled as number) ?? 0,
          bookingsGenerated: booked,
          revenueCents: booked * avgTicketValueCents,
        };
      });

      const dailyBreakdown = dailyRows.map((r) => {
        const booked = (r.bookings_generated as number) ?? 0;
        return {
          date: String(r.day).slice(0, 10),
          callsHandled: (r.calls_handled as number) ?? 0,
          bookingsGenerated: booked,
          revenueCents: booked * avgTicketValueCents,
        };
      });

      const totalCallsHandled = agentBreakdown.reduce((s, a) => s + a.callsHandled, 0);
      const totalBookings = agentBreakdown.reduce((s, a) => s + a.bookingsGenerated, 0);
      const missedCallsRecovered = (missedRecovery[0]?.recovered as number) ?? 0;
      const missedCount = (missedOpps[0]?.missed as number) ?? 0;

      const metricsData = {
        tenantId,
        teamId,
        periodStart: from.toISOString(),
        periodEnd: to.toISOString(),
        callsHandled: totalCallsHandled,
        bookingsGenerated: totalBookings,
        missedCallsRecovered,
        estimatedRevenueCents: totalBookings * avgTicketValueCents,
        missedRevenueCents: missedCount * avgTicketValueCents,
        avgTicketValueCents,
        agentBreakdown,
        dailyBreakdown,
      };

      const upsertClient = await pool.connect();
      let persistedMetrics: WorkforceRevenueMetrics | null = null;
      try {
        await upsertClient.query('BEGIN');
        persistedMetrics = await withTenantContext(upsertClient, tenantId, async () => {
          const { rows } = await upsertClient.query(
            `INSERT INTO workforce_revenue_metrics
             (tenant_id, team_id, period_start, period_end, calls_handled, bookings_generated,
              missed_calls_recovered, estimated_revenue_cents, missed_revenue_cents,
              avg_ticket_value_cents, agent_breakdown, daily_breakdown)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (team_id, period_start, period_end)
             DO UPDATE SET
               calls_handled = EXCLUDED.calls_handled,
               bookings_generated = EXCLUDED.bookings_generated,
               missed_calls_recovered = EXCLUDED.missed_calls_recovered,
               estimated_revenue_cents = EXCLUDED.estimated_revenue_cents,
               missed_revenue_cents = EXCLUDED.missed_revenue_cents,
               agent_breakdown = EXCLUDED.agent_breakdown,
               daily_breakdown = EXCLUDED.daily_breakdown,
               updated_at = NOW()
             RETURNING *`,
            [
              tenantId, teamId, from, to,
              metricsData.callsHandled, metricsData.bookingsGenerated,
              metricsData.missedCallsRecovered, metricsData.estimatedRevenueCents,
              metricsData.missedRevenueCents, avgTicketValueCents,
              JSON.stringify(agentBreakdown), JSON.stringify(dailyBreakdown),
            ],
          );
          await upsertClient.query('COMMIT');

          return rows[0] ? mapRevenueRow(rows[0]) : null;
        });
      } catch (err) {
        await upsertClient.query('ROLLBACK');
        throw err;
      } finally {
        upsertClient.release();
      }

      logger.info('Workforce revenue metrics calculated', { tenantId, teamId, totalBookings, totalCallsHandled });

      if (persistedMetrics) {
        return persistedMetrics;
      }

      return {
        id: '',
        ...metricsData,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('Failed to calculate workforce revenue metrics', { tenantId, teamId, error: String(err) });
      throw err;
    } finally {
      client.release();
    }
  }

  async getLatestMetrics(
    tenantId: string,
    teamId: string,
  ): Promise<WorkforceRevenueMetrics | null> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      return await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT * FROM workforce_revenue_metrics
           WHERE tenant_id = $1 AND team_id = $2
           ORDER BY period_end DESC
           LIMIT 1`,
          [tenantId, teamId],
        );
        return rows[0] ? mapRevenueRow(rows[0]) : null;
      });
    } finally {
      client.release();
    }
  }

  async getMetricsHistory(
    tenantId: string,
    teamId: string,
    limit = 12,
  ): Promise<WorkforceRevenueMetrics[]> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      return await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT * FROM workforce_revenue_metrics
           WHERE tenant_id = $1 AND team_id = $2
           ORDER BY period_end DESC
           LIMIT $3`,
          [tenantId, teamId, limit],
        );
        return rows.map(mapRevenueRow);
      });
    } finally {
      client.release();
    }
  }

  async getAttributionForTeam(
    tenantId: string,
    teamId: string,
    from: Date,
    to: Date,
    avgTicketValueCents = 15000,
  ): Promise<RevenueAttributionResult> {
    return getRevenueAttribution(tenantId, from, to, avgTicketValueCents);
  }
}
