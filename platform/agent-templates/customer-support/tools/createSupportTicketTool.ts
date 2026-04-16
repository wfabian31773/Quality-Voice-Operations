import { createLogger } from '../../../core/logger';
import { getPlatformPool } from '../../../db';
import type { TenantId } from '../../../core/types';

const logger = createLogger('CUSTOMER_SUPPORT_TICKET');

export interface CreateSupportTicketInput {
  customerFirstName: string;
  customerLastName: string;
  customerPhone: string;
  customerEmail?: string;
  accountNumber?: string;
  issueCategory: string;
  issueDescription: string;
  priority?: string;
  additionalNotes?: string;
}

export interface CreateSupportTicketDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

export async function createSupportTicket(
  input: CreateSupportTicketInput,
  deps: CreateSupportTicketDeps,
): Promise<{ success: boolean; message: string; ticketId?: string }> {
  const pool = getPlatformPool();
  const priority = input.priority || 'medium';
  const contactName = `${input.customerFirstName} ${input.customerLastName}`;
  const description = [
    input.issueDescription,
    input.accountNumber ? `\n\nAccount: ${input.accountNumber}` : '',
    input.additionalNotes ? `\n\nAdditional Notes:\n${input.additionalNotes}` : '',
  ].join('');

  try {
    const { rows } = await pool.query(
      `INSERT INTO tickets (tenant_id, call_id, subject, description, status, priority, source, department, contact_name, contact_phone, contact_email, tags)
       VALUES ($1, $2, $3, $4, 'open', $5, 'phone', 'customer_support', $6, $7, $8, $9)
       RETURNING id, ticket_number`,
      [
        deps.tenantId,
        deps.callSessionId || null,
        `${input.issueCategory}: ${input.issueDescription.substring(0, 80)}`,
        description,
        priority,
        contactName,
        input.customerPhone,
        input.customerEmail || '',
        [input.issueCategory, 'customer-support'],
      ],
    );

    const ticket = rows[0];
    const ticketRef = `#${ticket.ticket_number}`;

    await pool.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
       VALUES ($1, $2, NULL, 'created', $3)`,
      [deps.tenantId, ticket.id, `Customer support ticket created via phone call`],
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

    logger.info('Customer support ticket created', {
      tenantId: deps.tenantId,
      ticketId: ticket.id,
      ticketNumber: ticket.ticket_number,
      category: input.issueCategory,
      priority,
    });

    return {
      success: true,
      message: `Your support ticket has been created with reference number ${ticketRef}. A team member will follow up with you at ${input.customerPhone} within 24 hours.`,
      ticketId: ticket.id,
    };
  } catch (err) {
    logger.error('Failed to create customer support ticket', { tenantId: deps.tenantId, error: String(err) });
    return {
      success: false,
      message: 'We were unable to create your support ticket at this time. Please try again or contact us directly.',
    };
  }
}
