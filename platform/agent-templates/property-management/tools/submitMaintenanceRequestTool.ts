import { createLogger } from '../../../core/logger';
import { getPlatformPool } from '../../../db';
import type { TenantId } from '../../../core/types';

const logger = createLogger('MAINTENANCE_REQUEST');

export interface SubmitMaintenanceRequestInput {
  tenantName: string;
  unitAddress: string;
  issueDescription: string;
  urgency: 'low' | 'medium' | 'high' | 'emergency';
  contactPhone: string;
  preferredAccessTime?: string;
  additionalNotes?: string;
}

export interface SubmitMaintenanceRequestDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

const urgencyToPriority: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  emergency: 'urgent',
};

export async function submitMaintenanceRequest(
  input: SubmitMaintenanceRequestInput,
  deps: SubmitMaintenanceRequestDeps,
): Promise<{ success: boolean; message: string; requestId?: string }> {
  const pool = getPlatformPool();
  const priority = urgencyToPriority[input.urgency] || 'medium';
  const description = [
    `Unit: ${input.unitAddress}`,
    `\nIssue: ${input.issueDescription}`,
    input.preferredAccessTime ? `\nPreferred Access: ${input.preferredAccessTime}` : '',
    input.additionalNotes ? `\nNotes: ${input.additionalNotes}` : '',
  ].join('');

  try {
    const { rows } = await pool.query(
      `INSERT INTO tickets (tenant_id, call_id, subject, description, status, priority, source, department, contact_name, contact_phone, tags)
       VALUES ($1, $2, $3, $4, 'open', $5, 'phone', 'maintenance', $6, $7, $8)
       RETURNING id, ticket_number`,
      [
        deps.tenantId,
        deps.callSessionId || null,
        `Maintenance: ${input.issueDescription.substring(0, 100)}`,
        description,
        priority,
        input.tenantName,
        input.contactPhone,
        [input.urgency, 'maintenance', 'property'],
      ],
    );

    const ticket = rows[0];
    const requestId = `MNT-${ticket.ticket_number}`;

    await pool.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
       VALUES ($1, $2, NULL, 'created', $3)`,
      [deps.tenantId, ticket.id, `Maintenance request submitted via phone call`],
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

    logger.info('Maintenance request ticket created', {
      tenantId: deps.tenantId,
      ticketId: ticket.id,
      ticketNumber: ticket.ticket_number,
      urgency: input.urgency,
    });

    return {
      success: true,
      message: `Your maintenance request has been submitted with ID ${requestId}. ${input.urgency === 'emergency' ? 'Our emergency maintenance team has been notified and will respond shortly.' : 'Our maintenance team will contact you to schedule the repair.'}`,
      requestId,
    };
  } catch (err) {
    logger.error('Failed to create maintenance request ticket', { tenantId: deps.tenantId, error: String(err) });
    return {
      success: false,
      message: 'We were unable to submit your maintenance request at this time. Please try again or contact the office directly.',
    };
  }
}
