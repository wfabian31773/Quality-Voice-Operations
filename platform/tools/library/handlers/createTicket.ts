import { createLogger } from '../../../core/logger';
import { getPlatformPool, withTenantContext } from '../../../db';
import type { ToolContext, ToolDefinition } from '../../registry/types';
import { getToolLibraryEntry } from '../catalog';

const logger = createLogger('TOOL_CREATE_TICKET');

export async function executeCreateTicket(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{ success: boolean; message: string; ticketId?: string; ticketNumber?: string }> {
  const subject = String(input.subject ?? '').trim();
  const description = String(input.description ?? '').trim();
  const contactName = String(input.contactName ?? '').trim();
  const contactPhone = String(input.contactPhone ?? '').trim();
  if (!subject || !description || !contactName || !contactPhone) {
    return { success: false, message: 'subject, description, contactName, and contactPhone are required.' };
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let created: { id: string; ticket_number?: string } | undefined;
    await withTenantContext(client, context.tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO tickets (tenant_id, call_id, subject, description, status, priority, source, department, contact_name, contact_phone, contact_email, tags)
         VALUES ($1, $2, $3, $4, 'open', $5, 'phone', $6, $7, $8, $9, $10)
         RETURNING id, ticket_number`,
        [
          context.tenantId,
          context.callLogId ?? null,
          subject,
          description,
          String(input.priority ?? 'medium'),
          String(input.category ?? 'general'),
          contactName,
          contactPhone,
          String(input.contactEmail ?? ''),
          [String(input.category ?? 'general'), 'voice-library'],
        ],
      );
      created = rows[0] as { id: string; ticket_number?: string };
      await client.query(
        `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
         VALUES ($1, $2, NULL, 'created', $3)`,
        [context.tenantId, created.id, 'Ticket created by voice agent tool library'],
      );
    });
    await client.query('COMMIT');
    const ticketRef = created?.ticket_number ? `#${created.ticket_number}` : created?.id;
    return {
      success: true,
      message: `Ticket ${ticketRef} created for staff review. The requested work is not complete until staff acts.`,
      ticketId: created?.id,
      ticketNumber: created?.ticket_number,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('create_ticket failed', { tenantId: context.tenantId, error: String(err) });
    return { success: false, message: 'Failed to create the ticket. Offer to try again or escalate.' };
  } finally {
    client.release();
  }
}

const entry = getToolLibraryEntry('create_ticket')!;

export const createTicketTool: ToolDefinition = {
  name: entry.name,
  description: entry.description,
  inputSchema: entry.parameters,
  handler: (input, context) => executeCreateTicket(input as Record<string, unknown>, context),
};
