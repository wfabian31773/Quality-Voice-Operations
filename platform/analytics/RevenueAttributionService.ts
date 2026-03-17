import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('REVENUE_ATTRIBUTION');

export interface RevenueAttributionResult {
  totalRevenueCents: number;
  totalAppointmentsBooked: number;
  avgTicketValueCents: number;
  revenueByAgent: Array<{
    agentId: string;
    agentName: string;
    appointmentsBooked: number;
    revenueCents: number;
    callsHandled: number;
    bookingRate: number;
  }>;
  missedRevenueCents: number;
  missedOpportunities: number;
  missedCallsPrevented: number;
  dailyRevenue: Array<{
    date: string;
    revenueCents: number;
    appointmentsBooked: number;
  }>;
}

export async function getRevenueAttribution(
  tenantId: string,
  from: Date,
  to: Date,
  avgTicketValueCents: number = 15000,
): Promise<RevenueAttributionResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: agentRows } = await client.query(
      `SELECT
         a.id AS agent_id,
         a.name AS agent_name,
         COUNT(cs.id)::int AS calls_handled,
         COUNT(cs.id) FILTER (
           WHERE cs.context->>'callOutcome' IS NOT NULL
             AND (cs.context->'callOutcome'->>'disposition') = 'resolved'
         )::int AS appointments_booked
       FROM agents a
       LEFT JOIN call_sessions cs ON cs.agent_id = a.id
         AND cs.tenant_id = $1
         AND cs.created_at >= $2
         AND cs.created_at < $3
       WHERE a.tenant_id = $1
       GROUP BY a.id, a.name
       ORDER BY appointments_booked DESC`,
      [tenantId, from, to],
    );

    const { rows: missedRows } = await client.query(
      `SELECT
         COUNT(*)::int AS missed_opportunities
       FROM call_sessions cs
       WHERE cs.tenant_id = $1
         AND cs.created_at >= $2
         AND cs.created_at < $3
         AND cs.lifecycle_state IN ('CALL_COMPLETED', 'CALL_FAILED', 'ESCALATED')
         AND (
           cs.context->>'callOutcome' IS NULL
           OR (cs.context->'callOutcome'->>'disposition') IN ('follow_up_needed', 'escalated', 'callback_requested')
         )
         AND cs.duration_seconds > 30`,
      [tenantId, from, to],
    );

    const { rows: preventedRows } = await client.query(
      `SELECT
         COUNT(*)::int AS prevented
       FROM call_sessions cs
       WHERE cs.tenant_id = $1
         AND cs.created_at >= $2
         AND cs.created_at < $3
         AND cs.direction = 'inbound'
         AND cs.lifecycle_state = 'CALL_COMPLETED'
         AND cs.context->>'callOutcome' IS NOT NULL`,
      [tenantId, from, to],
    );

    const { rows: dailyRows } = await client.query(
      `SELECT
         DATE(cs.created_at) AS day,
         COUNT(cs.id) FILTER (
           WHERE cs.context->>'callOutcome' IS NOT NULL
             AND (cs.context->'callOutcome'->>'disposition') = 'resolved'
         )::int AS appointments_booked
       FROM call_sessions cs
       WHERE cs.tenant_id = $1
         AND cs.created_at >= $2
         AND cs.created_at < $3
       GROUP BY DATE(cs.created_at)
       ORDER BY day`,
      [tenantId, from, to],
    );

    await client.query('COMMIT');

    const revenueByAgent = agentRows.map((r) => {
      const booked = (r.appointments_booked as number) ?? 0;
      const handled = (r.calls_handled as number) ?? 0;
      return {
        agentId: r.agent_id as string,
        agentName: r.agent_name as string,
        appointmentsBooked: booked,
        revenueCents: booked * avgTicketValueCents,
        callsHandled: handled,
        bookingRate: handled > 0 ? booked / handled : 0,
      };
    });

    const totalAppointmentsBooked = revenueByAgent.reduce((sum, a) => sum + a.appointmentsBooked, 0);
    const totalRevenueCents = totalAppointmentsBooked * avgTicketValueCents;
    const missedOpportunities = (missedRows[0]?.missed_opportunities as number) ?? 0;
    const missedRevenueCents = missedOpportunities * avgTicketValueCents;
    const missedCallsPrevented = (preventedRows[0]?.prevented as number) ?? 0;

    const dailyRevenue = dailyRows.map((r) => {
      const booked = (r.appointments_booked as number) ?? 0;
      return {
        date: String(r.day).slice(0, 10),
        revenueCents: booked * avgTicketValueCents,
        appointmentsBooked: booked,
      };
    });

    return {
      totalRevenueCents,
      totalAppointmentsBooked,
      avgTicketValueCents,
      revenueByAgent,
      missedRevenueCents,
      missedOpportunities,
      missedCallsPrevented,
      dailyRevenue,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get revenue attribution', { tenantId, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}
