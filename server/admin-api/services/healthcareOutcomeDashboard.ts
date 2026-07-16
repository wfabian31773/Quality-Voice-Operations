import {
  buildHealthcareOutcomeDashboardProjection,
  type HealthcareOutcomeDashboardProjection,
} from '../../../shared/receptionist/healthcareOutcomeDashboard';

export interface OutcomeDashboardQueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export async function loadHealthcareOutcomeDashboardProjection(
  client: OutcomeDashboardQueryClient,
  tenantId: string,
  callId: string,
): Promise<HealthcareOutcomeDashboardProjection | null> {
  const { rows: callRows } = await client.query(
    `SELECT cs.id, cs.language, cs.lifecycle_state, cs.start_time, cs.end_time, cs.context,
            (SELECT COUNT(*)::int FROM call_transcripts ct
              WHERE ct.tenant_id = cs.tenant_id AND ct.call_session_id = cs.id) AS transcript_count
       FROM call_sessions cs
      WHERE cs.id = $1 AND cs.tenant_id = $2`,
    [callId, tenantId],
  );
  if (callRows.length === 0) return null;

  const { rows: outboxRows } = await client.query(
    `SELECT id, status, last_error, payload, context, created_at, updated_at
       FROM outbox_messages
      WHERE tenant_id = $1 AND call_log_id = $2
        AND payload->>'type' = 'answering_service_ticket'
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, callId],
  );
  const { rows: ticketRows } = await client.query(
    `SELECT t.id, t.ticket_number, t.subject, t.status, t.priority,
            t.assignee_user_id, u.email AS assignee_email, t.created_at, t.updated_at
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_user_id
      WHERE t.tenant_id = $1 AND t.call_id = $2
      ORDER BY t.created_at ASC
      LIMIT 1`,
    [tenantId, callId],
  );
  const { rows: toolRows } = await client.query(
    `SELECT id, tool_name, status, error_message, result, output, invoked_at, completed_at
       FROM tool_invocations
      WHERE tenant_id = $1 AND call_session_id = $2
        AND tool_name IN ('createServiceTicket', 'escalate_to_human')
      ORDER BY invoked_at DESC
      LIMIT 1`,
    [tenantId, callId],
  );
  const { rows: escalationRows } = await client.query(
    `SELECT et.id, et.reason, et.priority, et.status, et.assigned_to, et.tool_name,
            et.metadata, et.created_at, u.email AS assigned_to_email
       FROM escalation_tasks et
       LEFT JOIN users u ON u.id = et.assigned_to
      WHERE et.tenant_id = $1 AND et.call_session_id = $2
      ORDER BY et.created_at DESC
      LIMIT 1`,
    [tenantId, callId],
  );

  return buildHealthcareOutcomeDashboardProjection({
    call: callRows[0],
    outbox: outboxRows[0] ?? null,
    ticket: ticketRows[0] ?? null,
    tool: toolRows[0] ?? null,
    escalation: escalationRows[0] ?? null,
  });
}
