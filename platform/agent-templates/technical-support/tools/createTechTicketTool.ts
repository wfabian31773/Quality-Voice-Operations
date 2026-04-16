import { createLogger } from '../../../core/logger';
import { getPlatformPool } from '../../../db';
import type { TenantId } from '../../../core/types';

const logger = createLogger('TECH_SUPPORT_TICKET');

export interface CreateTechTicketInput {
  customerFirstName: string;
  customerLastName: string;
  customerPhone: string;
  accountNumber?: string;
  issueDescription: string;
  diagnosticsSummary?: string;
  stepsAttempted?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  escalationTier: 'tier_2' | 'tier_3';
  additionalNotes?: string;
}

export interface CreateTechTicketDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

const severityToPriority: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  critical: 'urgent',
};

export async function createTechTicket(
  input: CreateTechTicketInput,
  deps: CreateTechTicketDeps,
): Promise<{ success: boolean; message: string; ticketId?: string }> {
  const pool = getPlatformPool();
  const priority = severityToPriority[input.severity] || 'medium';
  const contactName = `${input.customerFirstName} ${input.customerLastName}`;
  const description = [
    input.issueDescription,
    input.diagnosticsSummary ? `\n\nDiagnostics:\n${input.diagnosticsSummary}` : '',
    input.stepsAttempted ? `\n\nSteps Attempted:\n${input.stepsAttempted}` : '',
    input.accountNumber ? `\n\nAccount: ${input.accountNumber}` : '',
    input.additionalNotes ? `\n\nNotes:\n${input.additionalNotes}` : '',
  ].join('');

  try {
    const { rows } = await pool.query(
      `INSERT INTO tickets (tenant_id, call_id, subject, description, status, priority, source, department, contact_name, contact_phone, tags, notes)
       VALUES ($1, $2, $3, $4, 'open', $5, 'phone', 'technical_support', $6, $7, $8, $9)
       RETURNING id, ticket_number`,
      [
        deps.tenantId,
        deps.callSessionId || null,
        `Technical Support: ${input.issueDescription.substring(0, 100)}`,
        description,
        priority,
        contactName,
        input.customerPhone,
        [input.escalationTier, input.severity, 'tech-support'],
        `Escalation: ${input.escalationTier.replace('_', ' ')}`,
      ],
    );

    const ticket = rows[0];
    const ticketRef = `#${ticket.ticket_number}`;

    await pool.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
       VALUES ($1, $2, NULL, 'created', $3)`,
      [deps.tenantId, ticket.id, `Technical support ticket created via phone call`],
    );

    const { rows: policies } = await pool.query(
      `SELECT * FROM ticket_sla_policies WHERE tenant_id = $1 AND is_active = true AND priority = $2 ORDER BY created_at ASC LIMIT 1`,
      [deps.tenantId, priority],
    );

    if (policies.length > 0) {
      const policy = policies[0];
      await pool.query(
        `INSERT INTO ticket_sla_instances (tenant_id, ticket_id, policy_id, response_due_at, resolution_due_at)
         VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval, NOW() + ($5 || ' minutes')::interval)`,
        [deps.tenantId, ticket.id, policy.id, String(policy.first_response_minutes), String(policy.resolution_minutes)],
      );
    }

    logger.info('Tech support ticket created', {
      tenantId: deps.tenantId,
      ticketId: ticket.id,
      ticketNumber: ticket.ticket_number,
      severity: input.severity,
      escalationTier: input.escalationTier,
    });

    return {
      success: true,
      message: `Your technical support ticket ${ticketRef} has been created and escalated to ${input.escalationTier.replace('_', ' ')}. A specialist will contact you at ${input.customerPhone} within ${input.severity === 'critical' ? '1 hour' : '24 hours'}.`,
      ticketId: ticket.id,
    };
  } catch (err) {
    logger.error('Failed to create tech support ticket', { tenantId: deps.tenantId, error: String(err) });
    return {
      success: false,
      message: 'We were unable to create your support ticket at this time. Please try again or contact us directly.',
    };
  }
}
