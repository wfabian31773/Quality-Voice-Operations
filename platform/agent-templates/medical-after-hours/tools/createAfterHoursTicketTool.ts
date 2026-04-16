import type { TenantId } from '../../../core/types';
import type { OutboxService } from '../../../integrations/outbox/OutboxService';
import type { TriageOutcome } from '../config/triageOutcomes';
import { DEFAULT_TRIAGE_OUTCOME_MAPPINGS } from '../config/triageOutcomes';
import { createLogger } from '../../../core/logger';
import { submitTicket, isTicketingConfigured } from '../../../integrations/azul-vision/ticketingClient';
import { getPlatformPool } from '../../../db';

const logger = createLogger('AFTER_HOURS_TOOL');

export interface CreateAfterHoursTicketInput {
  patientFirstName: string;
  patientLastName: string;
  patientDob: string;
  callbackNumber: string;
  symptomDescription: string;
  triageOutcome: TriageOutcome;
  lastProviderSeen?: string;
  locationOfLastVisit?: string;
  additionalNotes?: string;
}

export interface CreateAfterHoursTicketDeps {
  tenantId: TenantId;
  callSid?: string;
  callLogId?: string;
  outbox: OutboxService;
  afterHoursDepartmentId?: number;
  practiceName?: string;
}

/**
 * createAfterHoursTicket tool handler.
 * Uses the platform OutboxService for durable delivery.
 */
export async function createAfterHoursTicket(
  input: CreateAfterHoursTicketInput,
  deps: CreateAfterHoursTicketDeps,
): Promise<{ success: boolean; confirmationMessage: string; outboxId?: string }> {
  const { tenantId, callSid, callLogId, outbox } = deps;
  const outcomeConfig = DEFAULT_TRIAGE_OUTCOME_MAPPINGS[input.triageOutcome];

  try {
    const result = await outbox.writeToOutbox({
      tenantId,
      callSid,
      callLogId,
      idempotencyKey: callSid ? `after-hours:${callSid}` : undefined,
      payload: {
        type: 'after_hours_triage_ticket',
        patientFirstName: input.patientFirstName,
        patientLastName: input.patientLastName,
        patientDob: input.patientDob,
        callbackNumber: input.callbackNumber,
        symptomDescription: input.symptomDescription,
        triageOutcome: input.triageOutcome,
        triageOutcomeLabel: outcomeConfig.label,
        priority: outcomeConfig.ticketPriority,
        departmentId: deps.afterHoursDepartmentId ?? 1,
        lastProviderSeen: input.lastProviderSeen,
        locationOfLastVisit: input.locationOfLastVisit,
        additionalNotes: input.additionalNotes,
        requiresHumanTransfer: outcomeConfig.requiresHumanTransfer,
      },
    });

    logger.ticketCreated({
      tenantId,
      callId: callLogId,
      ticketType: `after_hours:${input.triageOutcome}`,
    });

    try {
      const pool = getPlatformPool();
      const contactName = `${input.patientFirstName} ${input.patientLastName}`;
      const description = [
        input.symptomDescription,
        `\nTriage Outcome: ${outcomeConfig.label}`,
        input.lastProviderSeen ? `\nLast Provider: ${input.lastProviderSeen}` : '',
        input.locationOfLastVisit ? `\nLocation: ${input.locationOfLastVisit}` : '',
        input.additionalNotes ? `\nNotes: ${input.additionalNotes}` : '',
      ].join('');
      const { rows: ticketRows } = await pool.query(
        `INSERT INTO tickets (tenant_id, call_id, subject, description, status, priority, source, department, contact_name, contact_phone, tags)
         VALUES ($1, $2, $3, $4, 'open', $5, 'phone', 'after_hours', $6, $7, $8)
         RETURNING id, ticket_number`,
        [tenantId, callLogId || null, `After Hours: ${input.symptomDescription.substring(0, 100)}`, description, outcomeConfig.ticketPriority, contactName, input.callbackNumber, ['after-hours', input.triageOutcome]],
      );
      if (ticketRows.length > 0) {
        const ticketId = ticketRows[0].id;
        await pool.query(
          `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
           VALUES ($1, $2, NULL, 'created', $3)`,
          [tenantId, ticketId, `After-hours triage ticket created - ${outcomeConfig.label}`],
        );
        const { rows: policies } = await pool.query(
          `SELECT * FROM ticket_sla_policies WHERE tenant_id = $1 AND is_active = true AND priority = $2 ORDER BY created_at ASC LIMIT 1`,
          [tenantId, outcomeConfig.ticketPriority],
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
        callbackNumber: input.callbackNumber,
        symptomDescription: input.symptomDescription,
        departmentId: deps.afterHoursDepartmentId ?? 1,
        priority: outcomeConfig.ticketPriority,
        triageOutcome: input.triageOutcome,
        ticketType: 'after_hours',
        additionalNotes: input.additionalNotes,
        idempotencyKey: callSid ? `after-hours:${callSid}` : undefined,
      });
      if (!ticketResult.success) {
        logger.warn('Azul Vision ticketing API failed (outbox succeeded)', { tenantId, error: ticketResult.error });
      }
    }

    return {
      success: true,
      confirmationMessage:
        input.triageOutcome === 'callback_next_business_day'
          ? "I've documented your concern and someone from our team will follow up with you during business hours. Is there anything else I can help you with tonight?"
          : "I've documented your concern. Our team will be in touch with you as soon as possible.",
      outboxId: result.outboxId,
    };
  } catch (err) {
    logger.error('createAfterHoursTicket failed', { tenantId, error: String(err) });
    return {
      success: false,
      confirmationMessage:
        "I'm sorry, I was unable to complete your request. Please try calling back or contact the office during business hours.",
    };
  }
}
