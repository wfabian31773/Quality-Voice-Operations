import type { TenantId } from '../../../core/types';
import type { OutboxService } from '../../../integrations/outbox/OutboxService';
import { detectPriority, detectDepartmentId } from '../config/ticketingConfig';
import type { AnsweringServiceTicketingConfig } from '../config/ticketingConfig';
import { createLogger } from '../../../core/logger';
import { submitTicket, isTicketingConfigured } from '../../../integrations/azul-vision/ticketingClient';
import { getPlatformPool, withTenantContext } from '../../../db';

const logger = createLogger('ANSWERING_SERVICE_TOOL');

export interface CreateServiceTicketInput {
  callerFirstName?: string;
  callerLastName?: string;
  callerPhone?: string;
  patientFirstName?: string;
  patientLastName?: string;
  patientPhone?: string;
  patientDob?: string;
  reasonForCall: string;
  callbackNumber?: string;
  preferredContactMethod?: string;
  lastProviderSeen?: string;
  locationOfLastVisit?: string;
  additionalNotes?: string;
  outcomeType?: 'appointment_request' | 'reschedule_request' | 'cancellation_request' | 'callback_request' | 'billing_question' | 'prescription_refill_request' | 'records_request' | 'staff_message' | 'general_question' | 'urgent_escalation';
  requestedAction?: string;
  urgency?: 'routine' | 'time_sensitive' | 'urgent' | 'emergency';
  callbackPreference?: string;
  identityVerificationStatus?: 'unverified' | 'partially_verified' | 'verified' | 'not_required';
  consentToContact?: boolean;
  evidenceSource?: Array<'caller_statement' | 'caller_id' | 'verified_record' | 'tool_result'>;
  callerType?: 'patient' | 'caregiver' | 'pharmacy' | 'lab' | 'facility' | 'referring_office' | 'other';
  organizationName?: string;
}

export interface CreateServiceTicketDeps {
  tenantId: TenantId;
  callSid?: string;
  callLogId?: string;
  outbox: OutboxService;
  config: AnsweringServiceTicketingConfig;
  practiceName?: string;
  /**
   * Optional persistence boundary used by deterministic, non-PHI demo execution.
   * Production callers omit this and retain the database-backed projection.
   */
  localTicketProjector?: LocalTicketProjector;
}

export type LocalTicketProjectionStatus = 'created' | 'existing' | 'queued' | 'not_applicable';

export interface CreateServiceTicketResult {
  success: boolean;
  confirmationMessage: string;
  outboxId?: string;
  ticketId?: string;
  ticketNumber?: number | string | null;
  projectionStatus?: LocalTicketProjectionStatus;
}

interface ResolvedHealthcareIdentity {
  callerFirstName: string;
  callerLastName: string;
  callerPhone: string;
  patientFirstName?: string;
  patientLastName?: string;
  patientPhone?: string;
}

function resolveHealthcareIdentity(input: CreateServiceTicketInput): ResolvedHealthcareIdentity {
  const callerFirstName = input.callerFirstName?.trim() || input.patientFirstName?.trim() || '';
  const callerLastName = input.callerLastName?.trim() || input.patientLastName?.trim() || '';
  const callerPhone = input.callerPhone?.trim() || input.patientPhone?.trim() || '';
  const callerIsPatient = input.callerType === 'patient';
  return {
    callerFirstName,
    callerLastName,
    callerPhone,
    patientFirstName: input.patientFirstName?.trim() || (callerIsPatient ? callerFirstName : undefined),
    patientLastName: input.patientLastName?.trim() || (callerIsPatient ? callerLastName : undefined),
    patientPhone: input.patientPhone?.trim() || (callerIsPatient ? callerPhone : undefined),
  };
}

function buildConfirmationMessage(input: CreateServiceTicketInput, identity: ResolvedHealthcareIdentity): string {
  const outcomeLabels: Partial<Record<NonNullable<CreateServiceTicketInput['outcomeType']>, string>> = {
    appointment_request: 'appointment request',
    reschedule_request: 'reschedule request',
    cancellation_request: 'cancellation request',
  };
  const outcomeLabel = input.outcomeType ? outcomeLabels[input.outcomeType] : undefined;
  return outcomeLabel
    ? `I've submitted the ${outcomeLabel} for staff review. The practice will contact you at ${input.callbackNumber ?? identity.callerPhone} to confirm what happens next.`
    : `I've submitted your request for staff review. The practice will contact you at ${input.callbackNumber ?? identity.callerPhone} about what happens next.`;
}

function getMissingHealthcareOutcomeFields(input: CreateServiceTicketInput, identity: ResolvedHealthcareIdentity): string[] {
  if (!input.outcomeType) return [];
  const missing: string[] = [];
  const requiredStrings: Array<keyof CreateServiceTicketInput> = [
    'callbackNumber', 'callerType', 'reasonForCall', 'requestedAction', 'urgency',
    'callbackPreference', 'identityVerificationStatus',
  ];
  if (!identity.callerFirstName) missing.push('callerFirstName');
  if (!identity.callerLastName) missing.push('callerLastName');
  if (!identity.callerPhone) missing.push('callerPhone');
  for (const field of requiredStrings) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim().length === 0) missing.push(field);
  }
  if (typeof input.consentToContact !== 'boolean') missing.push('consentToContact');
  if (!Array.isArray(input.evidenceSource) || input.evidenceSource.length === 0) missing.push('evidenceSource');
  if (['pharmacy', 'lab', 'facility', 'referring_office'].includes(input.callerType ?? '')
    && !input.organizationName?.trim()) missing.push('organizationName');
  return missing;
}

function getInvalidHealthcareOutcomeFields(input: CreateServiceTicketInput, identity: ResolvedHealthcareIdentity): string[] {
  if (!input.outcomeType) return [];
  const invalid: string[] = [];
  const maxLengths: Array<[keyof CreateServiceTicketInput, number]> = [
    ['callerFirstName', 100], ['callerLastName', 100], ['callerPhone', 32],
    ['patientFirstName', 100], ['patientLastName', 100], ['patientPhone', 32],
    ['callbackNumber', 32], ['reasonForCall', 2_000], ['requestedAction', 2_000],
    ['callbackPreference', 500], ['organizationName', 200], ['additionalNotes', 4_000],
  ];
  for (const [field, maxLength] of maxLengths) {
    const value = input[field];
    if (typeof value === 'string' && value.length > maxLength) invalid.push(field);
  }
  const allowedOutcomes = new Set([
    'appointment_request', 'reschedule_request', 'cancellation_request', 'callback_request',
    'billing_question', 'prescription_refill_request', 'records_request', 'staff_message',
    'general_question', 'urgent_escalation',
  ]);
  const allowedUrgency = new Set(['routine', 'time_sensitive', 'urgent', 'emergency']);
  const allowedVerification = new Set(['unverified', 'partially_verified', 'verified', 'not_required']);
  const allowedCallerTypes = new Set(['patient', 'caregiver', 'pharmacy', 'lab', 'facility', 'referring_office', 'other']);
  const allowedEvidence = new Set(['caller_statement', 'caller_id', 'verified_record', 'tool_result']);
  if (!allowedOutcomes.has(input.outcomeType)) invalid.push('outcomeType');
  if (!input.urgency || !allowedUrgency.has(input.urgency)) invalid.push('urgency');
  if (!input.identityVerificationStatus || !allowedVerification.has(input.identityVerificationStatus)) invalid.push('identityVerificationStatus');
  if (!input.callerType || !allowedCallerTypes.has(input.callerType)) invalid.push('callerType');
  if (input.evidenceSource?.some((source) => !allowedEvidence.has(source))) invalid.push('evidenceSource');
  const phonePattern = /^\+?[0-9() .-]{7,32}$/;
  if (!phonePattern.test(identity.callerPhone)) invalid.push('callerPhone');
  if (identity.patientPhone && !phonePattern.test(identity.patientPhone)) invalid.push('patientPhone');
  if (input.callbackNumber && !/^\+?[0-9() .-]{7,32}$/.test(input.callbackNumber)) invalid.push('callbackNumber');
  if (input.preferredContactMethod && !['phone', 'sms'].includes(input.preferredContactMethod)) invalid.push('preferredContactMethod');
  return [...new Set(invalid)];
}

function buildOutcomeSummary(input: CreateServiceTicketInput): string {
  const outcomeLabel = (input.outcomeType ?? 'staff_message').replace(/_/g, ' ');
  const reason = input.reasonForCall.trim().replace(/\s+/g, ' ');
  const requestedAction = (input.requestedAction ?? input.reasonForCall).trim().replace(/\s+/g, ' ');
  return `${outcomeLabel}: ${reason}. Next action: ${requestedAction}. Staff confirmation required.`.slice(0, 500);
}

export interface LocalTicketProjectionInput {
  tenantId: TenantId;
  callLogId: string;
  outboxId: string;
  input: CreateServiceTicketInput;
  caller: {
    firstName: string;
    lastName: string;
    phone: string;
  };
  priority: string;
}

export interface LocalTicketProjectionResult {
  status: 'created' | 'existing';
  ticketId: string;
  ticketNumber: number | string | null;
}

export type LocalTicketProjector = (
  params: LocalTicketProjectionInput,
) => Promise<LocalTicketProjectionResult>;

async function projectLocalTicket(params: LocalTicketProjectionInput): Promise<LocalTicketProjectionResult> {
  const { tenantId, callLogId, outboxId, input, caller, priority } = params;
  const pool = getPlatformPool();
  const client = await pool.connect();
  const outcomeType = input.outcomeType ?? 'staff_message';
  const outcomeTag = `outcome:${outcomeType}`;
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tenantId}:${callLogId}:${outcomeType}`]);
    const { rows: existingRows } = await client.query(
      `SELECT id, ticket_number FROM tickets
       WHERE tenant_id = $1 AND call_id = $2 AND tags @> ARRAY[$3]::text[]
       ORDER BY created_at ASC LIMIT 1`,
      [tenantId, callLogId, outcomeTag],
    );
    if (existingRows.length > 0) {
      await client.query('COMMIT');
      return {
        status: 'existing',
        ticketId: String(existingRows[0].id),
        ticketNumber: (existingRows[0].ticket_number as number | string | null | undefined) ?? null,
      };
    }

    const contactName = `${caller.firstName} ${caller.lastName}`.trim();
    const summary = buildOutcomeSummary(input);
    const description = [
      summary,
      `Reason: ${input.reasonForCall}`,
      `Requested Action: ${input.requestedAction ?? input.reasonForCall}`,
      `Urgency: ${input.urgency ?? priority}`,
      `Callback Preference: ${input.callbackPreference ?? input.preferredContactMethod ?? 'phone'}`,
      `Identity Verification: ${input.identityVerificationStatus ?? 'unverified'}`,
      `Consent to Contact: ${input.consentToContact === true ? 'yes' : 'no/not recorded'}`,
      `Evidence Source: ${(input.evidenceSource ?? ['caller_statement']).join(', ')}`,
      `Caller Type: ${input.callerType ?? 'patient'}`,
      input.organizationName ? `Organization: ${input.organizationName}` : '',
      input.lastProviderSeen ? `Last Provider: ${input.lastProviderSeen}` : '',
      input.locationOfLastVisit ? `Location: ${input.locationOfLastVisit}` : '',
      input.additionalNotes ? `Notes: ${input.additionalNotes}` : '',
    ].filter(Boolean).join('\n');
    const { rows: ticketRows } = await client.query(
      `INSERT INTO tickets (tenant_id, call_id, subject, description, status, priority, source, department, contact_name, contact_phone, tags)
       VALUES ($1, $2, $3, $4, 'open', $5, 'phone', 'answering_service', $6, $7, $8)
       RETURNING id, ticket_number`,
      [
        tenantId,
        callLogId,
        `Service Request: ${input.reasonForCall.substring(0, 100)}`,
        description,
        priority,
        contactName,
        caller.phone,
        ['answering-service', outcomeTag],
      ],
    );
    const ticketId = String(ticketRows[0].id);
    await client.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content, metadata)
       VALUES ($1, $2, NULL, 'created', 'Healthcare receptionist follow-up created', $3)`,
      [tenantId, ticketId, JSON.stringify({
        source: 'healthcare_receptionist',
        outboxId,
        callLogId,
        outcomeType,
        requestedAction: input.requestedAction ?? input.reasonForCall,
        summary,
      })],
    );
    const { rows: policies } = await client.query(
      `SELECT * FROM ticket_sla_policies
       WHERE tenant_id = $1 AND is_active = true AND priority = $2
       ORDER BY created_at ASC LIMIT 1`,
      [tenantId, priority],
    );
    if (policies.length > 0) {
      const policy = policies[0];
      await client.query(
        `INSERT INTO ticket_sla_instances (tenant_id, ticket_id, policy_id, response_due_at, resolution_due_at)
         VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval, NOW() + ($5 || ' minutes')::interval)`,
        [tenantId, ticketId, policy.id, String(policy.first_response_minutes), String(policy.resolution_minutes)],
      );
    }
    await client.query('COMMIT');
    return {
      status: 'created',
      ticketId,
      ticketNumber: (ticketRows[0].ticket_number as number | string | null | undefined) ?? null,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
): Promise<CreateServiceTicketResult> {
  const { tenantId, callSid, callLogId, outbox, config } = deps;
  const identity = resolveHealthcareIdentity(input);

  const priority = input.urgency === 'emergency' || input.urgency === 'urgent'
    ? 'urgent'
    : input.urgency === 'time_sensitive'
      ? 'high'
      : detectPriority(input.reasonForCall);
  const departmentId = detectDepartmentId(input.reasonForCall, config);
  const callScope = callSid ?? callLogId;
  const idempotencyKey = callScope
    ? input.outcomeType
      ? `healthcare-receptionist:${callScope}:${input.outcomeType}`
      : `answering-service:${callScope}`
    : undefined;

  if (input.outcomeType && !callScope) {
    logger.warn('Healthcare outcome rejected without an idempotency scope', { tenantId, outcomeType: input.outcomeType });
    return {
      success: false,
      confirmationMessage: "I'm unable to verify the call safely, so I cannot submit this request yet. Please ask a staff member to follow up.",
    };
  }

  const missingHealthcareFields = getMissingHealthcareOutcomeFields(input, identity);
  if (missingHealthcareFields.length > 0) {
    logger.warn('Healthcare outcome rejected before persistence', {
      tenantId,
      missingFields: missingHealthcareFields,
      outcomeType: input.outcomeType,
    });
    return {
      success: false,
      confirmationMessage: `I'm missing required information before I can submit this request: ${missingHealthcareFields.join(', ')}.`,
    };
  }
  const invalidHealthcareFields = getInvalidHealthcareOutcomeFields(input, identity);
  if (invalidHealthcareFields.length > 0) {
    logger.warn('Healthcare outcome rejected due to invalid input', {
      tenantId,
      invalidFields: invalidHealthcareFields,
      outcomeType: input.outcomeType,
    });
    return {
      success: false,
      confirmationMessage: `I received invalid information for: ${invalidHealthcareFields.join(', ')}. Please confirm those details before I submit the request.`,
    };
  }

  try {
    const result = await outbox.writeToOutbox({
      tenantId,
      callSid,
      callLogId,
      idempotencyKey,
      payload: {
        type: 'answering_service_ticket',
        callerFirstName: identity.callerFirstName,
        callerLastName: identity.callerLastName,
        callerPhone: identity.callerPhone,
        patientFirstName: identity.patientFirstName,
        patientLastName: identity.patientLastName,
        patientPhone: identity.patientPhone,
        patientDob: input.patientDob,
        callbackNumber: input.callbackNumber ?? identity.callerPhone,
        preferredContactMethod: input.preferredContactMethod ?? 'phone',
        reasonForCall: input.reasonForCall,
        departmentId,
        requestTypeId: config.defaultRequestTypeId,
        requestReasonId: config.defaultRequestReasonId,
        priority,
        lastProviderSeen: input.lastProviderSeen,
        locationOfLastVisit: input.locationOfLastVisit,
        additionalNotes: input.additionalNotes,
        outcomeType: input.outcomeType ?? 'staff_message',
        requestedAction: input.requestedAction ?? input.reasonForCall,
        urgency: input.urgency ?? priority,
        callbackPreference: input.callbackPreference ?? input.preferredContactMethod ?? 'phone',
        identityVerificationStatus: input.identityVerificationStatus ?? 'unverified',
        consentToContact: input.consentToContact ?? false,
        evidenceSource: input.evidenceSource ?? ['caller_statement'],
        callerType: input.callerType ?? 'patient',
        organizationName: input.organizationName,
        summary: buildOutcomeSummary(input),
      },
    });

    logger.ticketCreated({ tenantId, callId: callLogId, ticketType: 'answering_service' });

    let localProjection: LocalTicketProjectionResult | null = null;
    if (callLogId) {
      try {
        const projector = deps.localTicketProjector ?? projectLocalTicket;
        localProjection = await projector({
          tenantId,
          callLogId,
          outboxId: result.outboxId,
          input,
          caller: {
            firstName: identity.callerFirstName,
            lastName: identity.callerLastName,
            phone: identity.callerPhone,
          },
          priority,
        });
      } catch (dbErr) {
        logger.warn('Failed to create local DB ticket (outbox succeeded)', { tenantId, callLogId, error: String(dbErr) });
      }
    }

    const isAzulVision = deps.practiceName === 'Azul Vision' || deps.practiceName === 'Azul Vision Eye Center';
    if (isAzulVision && isTicketingConfigured()
      && identity.patientFirstName && identity.patientLastName && identity.patientPhone) {
      const ticketResult = await submitTicket({
        patientFirstName: identity.patientFirstName,
        patientLastName: identity.patientLastName,
        patientDob: input.patientDob,
        patientPhone: identity.patientPhone,
        callbackNumber: input.callbackNumber ?? identity.callerPhone,
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
      confirmationMessage: buildConfirmationMessage(input, identity),
      outboxId: result.outboxId,
      ticketId: localProjection?.ticketId,
      ticketNumber: localProjection?.ticketNumber,
      projectionStatus: localProjection?.status ?? (input.outcomeType ? 'queued' : 'not_applicable'),
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
