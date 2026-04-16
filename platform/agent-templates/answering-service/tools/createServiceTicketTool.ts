import type { TenantId } from '../../../core/types';
import type { OutboxService } from '../../../integrations/outbox/OutboxService';
import { detectPriority, detectDepartmentId } from '../config/ticketingConfig';
import type { AnsweringServiceTicketingConfig } from '../config/ticketingConfig';
import { createLogger } from '../../../core/logger';
import { submitTicket, isTicketingConfigured } from '../../../integrations/azul-vision/ticketingClient';
import { getPlatformPool } from '../../../db';

const logger = createLogger('ANSWERING_SERVICE_TOOL');

export interface CreateServiceTicketInput {
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string;
  patientDob?: string;
  reasonForCall: string;
  callbackNumber?: string;
  preferredContactMethod?: string;
  lastProviderSeen?: string;
  locationOfLastVisit?: string;
  additionalNotes?: string;
}

export interface CreateServiceTicketDeps {
  tenantId: TenantId;
  callSid?: string;
  callLogId?: string;
  outbox: OutboxService;
  config: AnsweringServiceTicketingConfig;
  practiceName?: string;
}

/**
 * Platform-portable createServiceTicket tool handler.
 *
 * Extracted from the original answering service agent's inline tool implementation.
 * Uses the platform OutboxService instead of a hardcoded ticketing client.
 */
export async function createServiceTicket(
  input: CreateServiceTicketInput,
  deps: CreateServiceTicketDeps,
): Promise<{ success: boolean; confirmationMessage: string; outboxId?: string }> {
  const { tenantId, callSid, callLogId, outbox, config } = deps;

  const priority = detectPriority(input.reasonForCall);
  const departmentId = detectDepartmentId(input.reasonForCall, config);
  const idempotencyKey = callSid ? `answering-service:${callSid}` : undefined;

  try {
    const result = await outbox.writeToOutbox({
      tenantId,
      callSid,
      callLogId,
      idempotencyKey,
      payload: {
        type: 'answering_service_ticket',
        patientFirstName: input.patientFirstName,
        patientLastName: input.patientLastName,
        patientPhone: input.patientPhone,
        patientDob: input.patientDob,
        callbackNumber: input.callbackNumber ?? input.patientPhone,
        preferredContactMethod: input.preferredContactMethod ?? 'phone',
        reasonForCall: input.reasonForCall,
        departmentId,
        requestTypeId: config.defaultRequestTypeId,
        requestReasonId: config.defaultRequestReasonId,
        priority,
        lastProviderSeen: input.lastProviderSeen,
        locationOfLastVisit: input.locationOfLastVisit,
        additionalNotes: input.additionalNotes,
      },
    });

    logger.ticketCreated({ tenantId, callId: callLogId, ticketType: 'answering_service' });

    try {
      const pool = getPlatformPool();
      const contactName = `${input.patientFirstName} ${input.patientLastName}`;
      const description = [
        input.reasonForCall,
        input.lastProviderSeen ? `\nLast Provider: ${input.lastProviderSeen}` : '',
        input.locationOfLastVisit ? `\nLocation: ${input.locationOfLastVisit}` : '',
        input.additionalNotes ? `\nNotes: ${input.additionalNotes}` : '',
      ].join('');
      const { rows: ticketRows } = await pool.query(
        `INSERT INTO tickets (tenant_id, call_id, subject, description, status, priority, source, department, contact_name, contact_phone, tags)
         VALUES ($1, $2, $3, $4, 'open', $5, 'phone', 'answering_service', $6, $7, $8)
         RETURNING id, ticket_number`,
        [tenantId, callLogId || null, `Service Request: ${input.reasonForCall.substring(0, 100)}`, description, priority, contactName, input.patientPhone, ['answering-service']],
      );
      if (ticketRows.length > 0) {
        const ticketId = ticketRows[0].id;
        await pool.query(
          `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
           VALUES ($1, $2, NULL, 'created', 'Service ticket created via answering service call')`,
          [tenantId, ticketId],
        );
        const { rows: policies } = await pool.query(
          `SELECT * FROM ticket_sla_policies WHERE tenant_id = $1 AND is_active = true AND priority = $2 ORDER BY created_at ASC LIMIT 1`,
          [tenantId, priority],
        );
        if (policies.length > 0) {
          const policy = policies[0];
          await pool.query(
            `INSERT INTO ticket_sla_instances (tenant_id, ticket_id, policy_id, response_due_at, resolution_due_at)
             VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval, NOW() + ($5 || ' minutes')::interval)`,
            [tenantId, ticketId, policy.id, String(policy.first_response_minutes), String(policy.resolution_minutes)],
          );
        }
      }
    } catch (dbErr) {
      logger.warn('Failed to create local DB ticket (outbox succeeded)', { tenantId, error: String(dbErr) });
    }

    const isAzulVision = deps.practiceName === 'Azul Vision' || deps.practiceName === 'Azul Vision Eye Center';
    if (isAzulVision && isTicketingConfigured()) {
      const ticketResult = await submitTicket({
        patientFirstName: input.patientFirstName,
        patientLastName: input.patientLastName,
        patientDob: input.patientDob,
        patientPhone: input.patientPhone,
        callbackNumber: input.callbackNumber ?? input.patientPhone,
        reasonForCall: input.reasonForCall,
        departmentId,
        priority,
        ticketType: 'answering_service',
        additionalNotes: input.additionalNotes,
        idempotencyKey,
      });
      if (!ticketResult.success) {
        logger.warn('Azul Vision ticketing API failed (outbox succeeded)', { tenantId, error: ticketResult.error });
      }
    }

    return {
      success: true,
      confirmationMessage: `I've submitted your request and someone from ${input.patientFirstName}'s care team will be in touch. Is there anything else I can help you with?`,
      outboxId: result.outboxId,
    };
  } catch (err) {
    logger.error('createServiceTicket failed', { tenantId, error: String(err) });
    return {
      success: false,
      confirmationMessage:
        "I'm sorry, I wasn't able to submit your request at this time. Please try calling back or have a staff member follow up with you.",
    };
  }
}
