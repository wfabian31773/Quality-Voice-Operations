export type HealthcareOutcomeType =
  | 'appointment_request'
  | 'reschedule_request'
  | 'cancellation_request'
  | 'callback_request'
  | 'billing_question'
  | 'prescription_refill_request'
  | 'records_request'
  | 'staff_message'
  | 'general_question'
  | 'urgent_escalation';

export interface HealthcareOutcomeDashboardProjection {
  callId: string;
  language: string | null;
  lifecycleState: string;
  startedAt: string | null;
  endedAt: string | null;
  caller: {
    firstName: string;
    lastName: string;
    phone: string;
    type: string;
    organizationName: string | null;
  } | null;
  patient: { firstName: string; lastName: string; phone: string | null } | null;
  intent: string | null;
  outcome: {
    type: HealthcareOutcomeType;
    summary: string;
    requestedAction: string;
    urgency: string;
    callbackPreference: string;
    identityVerificationStatus: string;
    consentToContact: boolean;
    evidenceSource: string[];
  } | null;
  transcript: { available: boolean; lineCount: number };
  recording: { policy: 'disabled' | 'enabled'; status: 'not_recorded' | 'recorded' | 'unavailable'; url: string | null };
  delivery: { id: string; status: string; error: string | null; externalReference: string | null } | null;
  followUp: {
    ticketId: string | null;
    ticketNumber: number | string | null;
    ownerId: string | null;
    ownerLabel: string;
    priority: string;
    status: string;
    nextAction: string;
  } | null;
  tool: { id: string; name: string; status: string; error: string | null; invokedAt: string | null; result: unknown } | null;
  escalation: {
    id: string;
    reason: string;
    priority: string;
    status: string;
    ownerId: string | null;
    ownerLabel: string;
    toolName: string | null;
    createdAt: string | null;
  } | null;
  operationalValue: {
    state: 'none' | 'durably_queued' | 'staff_follow_up_created' | 'human_follow_up_required' | 'delivery_attention_required';
    evidence: string;
  };
}

export interface HealthcareOutcomeProjectionSources {
  call: Record<string, unknown>;
  outbox: Record<string, unknown> | null;
  ticket: Record<string, unknown> | null;
  tool: Record<string, unknown> | null;
  escalation: Record<string, unknown> | null;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableText(value: unknown): string | null {
  const valueText = text(value).trim();
  return valueText || null;
}

function isoText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return nullableText(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function buildHealthcareOutcomeDashboardProjection(
  sources: HealthcareOutcomeProjectionSources,
): HealthcareOutcomeDashboardProjection {
  const { call, outbox, ticket, tool, escalation } = sources;
  const payload = objectValue(outbox?.payload);
  const context = objectValue(call.context);
  const recordingPolicy = objectValue(context.recordingPolicy);
  const outcomeType = nullableText(payload.outcomeType) as HealthcareOutcomeType | null;
  const reason = nullableText(payload.reasonForCall);
  const requestedAction = nullableText(payload.requestedAction) ?? reason ?? 'Staff review required';
  const callerFirstName = text(payload.callerFirstName);
  const callerLastName = text(payload.callerLastName);
  const callerPhone = text(payload.callerPhone || payload.callbackNumber);
  const hasCaller = Boolean(callerFirstName || callerLastName || callerPhone);
  const patientFirstName = text(payload.patientFirstName);
  const patientLastName = text(payload.patientLastName);
  const hasPatient = Boolean(patientFirstName || patientLastName || payload.patientPhone);
  const deliveryContext = objectValue(outbox?.context);
  const deliveryStatus = nullableText(outbox?.status);
  const deliveryNeedsAttention = deliveryStatus === 'retry' || deliveryStatus === 'failed' || deliveryStatus === 'dead_letter';

  const transcriptCountRaw = Number(call.transcript_count ?? 0);
  const transcriptCount = Number.isFinite(transcriptCountRaw) ? transcriptCountRaw : 0;
  const policy = recordingPolicy.policy === 'enabled' ? 'enabled' : 'disabled';
  const recordingStatus = recordingPolicy.status === 'recorded'
    ? 'recorded'
    : recordingPolicy.status === 'unavailable'
      ? 'unavailable'
      : 'not_recorded';

  const followUp = outcomeType || ticket
    ? {
        ticketId: nullableText(ticket?.id),
        ticketNumber: (ticket?.ticket_number as number | string | null | undefined) ?? null,
        ownerId: nullableText(ticket?.assignee_user_id),
        ownerLabel: nullableText(ticket?.assignee_email) ?? 'Unassigned',
        priority: nullableText(ticket?.priority) ?? nullableText(payload.priority) ?? 'medium',
        status: nullableText(ticket?.status) ?? 'queued',
        nextAction: requestedAction,
      }
    : null;

  let operationalValue: HealthcareOutcomeDashboardProjection['operationalValue'];
  if (deliveryNeedsAttention) {
    operationalValue = {
      state: 'delivery_attention_required',
      evidence: 'The request is durable, but external delivery needs staff attention.',
    };
  } else if (escalation) {
    operationalValue = { state: 'human_follow_up_required', evidence: 'A human follow-up task was created.' };
  } else if (ticket) {
    operationalValue = { state: 'staff_follow_up_created', evidence: 'A staff follow-up ticket was created.' };
  } else if (outbox) {
    operationalValue = { state: 'durably_queued', evidence: 'The request was durably queued for staff follow-up.' };
  } else {
    operationalValue = { state: 'none', evidence: 'No staff-ready outcome has been recorded.' };
  }

  return {
    callId: text(call.id),
    language: nullableText(call.language),
    lifecycleState: text(call.lifecycle_state),
    startedAt: isoText(call.start_time),
    endedAt: isoText(call.end_time),
    caller: hasCaller ? {
      firstName: callerFirstName,
      lastName: callerLastName,
      phone: callerPhone,
      type: text(payload.callerType) || 'unknown',
      organizationName: nullableText(payload.organizationName),
    } : null,
    patient: hasPatient ? {
      firstName: patientFirstName,
      lastName: patientLastName,
      phone: nullableText(payload.patientPhone),
    } : null,
    intent: reason,
    outcome: outcomeType ? {
      type: outcomeType,
      summary: text(payload.summary) || `${reason ?? 'Caller request'}; staff review required.`,
      requestedAction,
      urgency: text(payload.urgency) || 'routine',
      callbackPreference: text(payload.callbackPreference) || 'not specified',
      identityVerificationStatus: text(payload.identityVerificationStatus) || 'unverified',
      consentToContact: payload.consentToContact === true,
      evidenceSource: stringArray(payload.evidenceSource),
    } : null,
    transcript: { available: transcriptCount > 0 || Boolean(context.transcript), lineCount: transcriptCount },
    recording: {
      policy,
      status: recordingStatus,
      url: policy === 'enabled' ? nullableText(recordingPolicy.url) : null,
    },
    delivery: outbox ? {
      id: text(outbox.id),
      status: deliveryStatus ?? 'pending',
      error: nullableText(outbox.last_error),
      externalReference: nullableText(deliveryContext.ticketNumber) ?? nullableText(deliveryContext.externalId),
    } : null,
    followUp,
    tool: tool ? {
      id: text(tool.id),
      name: text(tool.tool_name),
      status: text(tool.status),
      error: nullableText(tool.error_message),
      invokedAt: isoText(tool.invoked_at),
      result: tool.result ?? tool.output ?? null,
    } : null,
    escalation: escalation ? {
      id: text(escalation.id),
      reason: text(escalation.reason),
      priority: text(escalation.priority),
      status: text(escalation.status),
      ownerId: nullableText(escalation.assigned_to),
      ownerLabel: nullableText(escalation.assigned_to_email) ?? 'Unassigned',
      toolName: nullableText(escalation.tool_name),
      createdAt: isoText(escalation.created_at),
    } : null,
    operationalValue,
  };
}
