import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type {
  WorkforceTeam,
  WorkforceMember,
  WorkforceRoutingRule,
  WorkforceRoutingHistoryEntry,
  WorkforceMetrics,
} from './types';

const logger = createLogger('WORKFORCE_ROUTING');

export class WorkforceRoutingService {
  async findTeamForAgent(tenantId: string, agentId: string): Promise<WorkforceTeam | null> {
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT t.* FROM workforce_teams t
           JOIN workforce_members m ON m.team_id = t.id
           WHERE m.agent_id = $1 AND t.status = 'active' AND m.status = 'active'
           LIMIT 1`,
          [agentId],
        );
        await client.query('COMMIT');
        return rows.length > 0 ? (rows[0] as unknown as WorkforceTeam) : null;
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to find team for agent', { tenantId, agentId, error: String(err) });
      return null;
    } finally {
      client.release();
    }
  }

  async getTeamMembers(tenantId: string, teamId: string): Promise<WorkforceMember[]> {
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT wm.*, a.name as agent_name, a.type as agent_type
           FROM workforce_members wm
           JOIN agents a ON a.id = wm.agent_id
           WHERE wm.team_id = $1 AND wm.status = 'active'
           ORDER BY wm.is_receptionist DESC, wm.priority ASC`,
          [teamId],
        );
        await client.query('COMMIT');
        return rows as unknown as WorkforceMember[];
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to get team members', { tenantId, teamId, error: String(err) });
      return [];
    } finally {
      client.release();
    }
  }

  async getRoutingRules(tenantId: string, teamId: string): Promise<WorkforceRoutingRule[]> {
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT rr.*,
                  ta.name as target_agent_name, tm.role as target_role,
                  fa.name as fallback_agent_name
           FROM workforce_routing_rules rr
           JOIN workforce_members tm ON tm.id = rr.target_member_id
           JOIN agents ta ON ta.id = tm.agent_id
           LEFT JOIN workforce_members fm ON fm.id = rr.fallback_member_id
           LEFT JOIN agents fa ON fa.id = fm.agent_id
           WHERE rr.team_id = $1 AND rr.status = 'active'
           ORDER BY rr.priority ASC`,
          [teamId],
        );
        await client.query('COMMIT');
        return rows as unknown as WorkforceRoutingRule[];
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to get routing rules', { tenantId, teamId, error: String(err) });
      return [];
    } finally {
      client.release();
    }
  }

  private static readonly INTENT_SYNONYMS: Record<string, string[]> = {
    scheduling: ['schedule', 'schedule_appointment', 'appointment', 'book', 'booking', 'reschedule', 'cancel_appointment'],
    billing: ['billing_inquiry', 'payment', 'invoice', 'charge', 'refund', 'account_balance', 'bill'],
    triage: ['medical_triage', 'urgent', 'emergency', 'symptom', 'health_concern', 'medical'],
    intake: ['new_patient', 'registration', 'new_customer', 'onboarding', 'sign_up', 'signup'],
    support: ['customer_support', 'help', 'assistance', 'issue', 'problem', 'complaint', 'technical_support'],
    dispatch: ['dispatching', 'send_technician', 'service_call', 'field_service', 'emergency_dispatch'],
    consultation: ['consult', 'legal_consultation', 'advice', 'legal_advice', 'attorney'],
    general: ['general_inquiry', 'information', 'info', 'question', 'other'],
  };

  private normalizeIntent(intent: string): string {
    const normalized = intent.toLowerCase().trim().replace(/[\s-]+/g, '_');
    for (const [canonical, synonyms] of Object.entries(WorkforceRoutingService.INTENT_SYNONYMS)) {
      if (canonical === normalized || synonyms.includes(normalized)) {
        return canonical;
      }
    }
    return normalized;
  }

  private matchIntent(ruleIntent: string, requestIntent: string): boolean {
    if (ruleIntent === requestIntent) return true;
    const normalizedRule = this.normalizeIntent(ruleIntent);
    const normalizedRequest = this.normalizeIntent(requestIntent);
    return normalizedRule === normalizedRequest;
  }

  async resolveTargetAgent(
    tenantId: string,
    teamId: string,
    intent: string,
  ): Promise<{ member: WorkforceMember; rule: WorkforceRoutingRule } | null> {
    const rules = await this.getRoutingRules(tenantId, teamId);
    const members = await this.getTeamMembers(tenantId, teamId);

    const matchingRule = rules.find((r) => this.matchIntent(r.intent, intent));
    if (!matchingRule) {
      logger.info('No routing rule found for intent', { tenantId, teamId, intent, normalizedIntent: this.normalizeIntent(intent) });
      return null;
    }

    const targetMember = members.find((m) => m.id === matchingRule.target_member_id);
    if (targetMember && targetMember.status === 'active') {
      return { member: targetMember, rule: matchingRule };
    }

    if (matchingRule.fallback_member_id) {
      const fallbackMember = members.find((m) => m.id === matchingRule.fallback_member_id);
      if (fallbackMember && fallbackMember.status === 'active') {
        logger.info('Using fallback agent for routing', { tenantId, teamId, intent });
        return { member: fallbackMember, rule: matchingRule };
      }
    }

    logger.warn('No available agent for routing', { tenantId, teamId, intent });
    return null;
  }

  async getReceptionist(tenantId: string, teamId: string): Promise<WorkforceMember | null> {
    const members = await this.getTeamMembers(tenantId, teamId);
    return members.find((m) => m.is_receptionist) ?? null;
  }

  async recordHandoff(
    tenantId: string,
    entry: Omit<WorkforceRoutingHistoryEntry, 'id' | 'created_at' | 'from_agent_name' | 'to_agent_name'>,
  ): Promise<void> {
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await withTenantContext(client, tenantId, async () => {
        await client.query(
          `INSERT INTO workforce_routing_history
           (team_id, tenant_id, call_session_id, from_agent_id, to_agent_id, intent, routing_rule_id, reason, context_summary, duration_ms, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            entry.team_id,
            entry.tenant_id,
            entry.call_session_id,
            entry.from_agent_id,
            entry.to_agent_id,
            entry.intent,
            entry.routing_rule_id,
            entry.reason,
            entry.context_summary,
            entry.duration_ms,
            entry.outcome,
          ],
        );
        await client.query('COMMIT');
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to record handoff', { tenantId, error: String(err) });
    } finally {
      client.release();
    }
  }

  async getTeamMetrics(tenantId: string, teamId: string): Promise<WorkforceMetrics> {
    const pool = getPlatformPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      return await withTenantContext(client, tenantId, async () => {
        const { rows: totals } = await client.query(
          `SELECT
             COUNT(*)::int as total,
             COUNT(*) FILTER (WHERE outcome = 'success')::int as successful,
             COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0)::int as avg_duration_ms
           FROM workforce_routing_history
           WHERE team_id = $1`,
          [teamId],
        );

        const { rows: byIntent } = await client.query(
          `SELECT intent, COUNT(*)::int as count
           FROM workforce_routing_history
           WHERE team_id = $1 AND intent IS NOT NULL
           GROUP BY intent
           ORDER BY count DESC`,
          [teamId],
        );

        const { rows: byAgent } = await client.query(
          `SELECT rh.to_agent_id as agent_id, a.name as agent_name, COUNT(*)::int as count
           FROM workforce_routing_history rh
           JOIN agents a ON a.id = rh.to_agent_id
           WHERE rh.team_id = $1
           GROUP BY rh.to_agent_id, a.name
           ORDER BY count DESC`,
          [teamId],
        );

        const { rows: activeCalls } = await client.query(
          `SELECT wm.agent_id, a.name as agent_name, COUNT(cs.id)::int as active_calls
           FROM workforce_members wm
           JOIN agents a ON a.id = wm.agent_id
           LEFT JOIN call_sessions cs ON cs.agent_id = wm.agent_id
             AND cs.lifecycle_state IN ('RINGING', 'ACTIVE_CONVERSATION', 'HANDOFF')
           WHERE wm.team_id = $1 AND wm.status = 'active'
           GROUP BY wm.agent_id, a.name
           ORDER BY active_calls DESC`,
          [teamId],
        );

        const { rows: recent } = await client.query(
          `SELECT rh.*,
                  fa.name as from_agent_name,
                  ta.name as to_agent_name
           FROM workforce_routing_history rh
           JOIN agents fa ON fa.id = rh.from_agent_id
           JOIN agents ta ON ta.id = rh.to_agent_id
           WHERE rh.team_id = $1
           ORDER BY rh.created_at DESC
           LIMIT 20`,
          [teamId],
        );

        await client.query('COMMIT');

        const intentMap: Record<string, number> = {};
        for (const row of byIntent) {
          intentMap[row.intent as string] = row.count as number;
        }

        return {
          teamId,
          totalHandoffs: (totals[0]?.total as number) ?? 0,
          successfulHandoffs: (totals[0]?.successful as number) ?? 0,
          avgHandoffDurationMs: (totals[0]?.avg_duration_ms as number) ?? 0,
          handoffsByIntent: intentMap,
          handoffsByAgent: byAgent.map((row) => ({
            agentId: row.agent_id as string,
            agentName: row.agent_name as string,
            count: row.count as number,
          })),
          activeCallsByAgent: activeCalls.map((row) => ({
            agentId: row.agent_id as string,
            agentName: row.agent_name as string,
            activeCalls: row.active_calls as number,
          })),
          recentHandoffs: recent as unknown as WorkforceRoutingHistoryEntry[],
        };
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to get team metrics', { tenantId, teamId, error: String(err) });
      return {
        teamId,
        totalHandoffs: 0,
        successfulHandoffs: 0,
        avgHandoffDurationMs: 0,
        handoffsByIntent: {},
        handoffsByAgent: [],
        activeCallsByAgent: [],
        recentHandoffs: [],
      };
    } finally {
      client.release();
    }
  }
}
