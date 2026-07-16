import {
  MASTER_VOICE_AGENT_CORE_VERSION,
  buildTenantTimeContext,
} from '../agent-runtime/masterVoiceAgent';
import {
  HEALTHCARE_RECEPTIONIST_ROLE_VERSION,
  createHealthcareReceptionistRolePackage,
} from '../agent-templates/healthcare-receptionist/rolePackage';
import { DEFAULT_ANSWERING_SERVICE_CONFIG } from '../agent-templates/answering-service/config/ticketingConfig';
import {
  createServiceTicket,
  type CreateServiceTicketInput,
} from '../agent-templates/answering-service/tools/createServiceTicketTool';
import type { OutboxService } from '../integrations/outbox/OutboxService';
import type { OutboxWriteParams } from '../integrations/outbox/types';
import {
  buildHealthcareOutcomeDashboardProjection,
} from '../../shared/receptionist/healthcareOutcomeDashboard';
import type {
  HealthcareDemoResult,
  HealthcareDemoScenarioKind,
  HealthcareDemoTimelineStep,
  HealthcareDemoTranscriptLine,
} from '../../shared/demo/healthcareDemo';

const DEMO_DISCLOSURE = 'Guided workflow using production contracts. This is not a live phone call.';
const DEMO_TIME_ZONE = 'America/Los_Angeles';

function deterministicIds(scenario: HealthcareDemoScenarioKind, now: Date) {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = scenario === 'appointment_request' ? 'appointment' : 'escalation';
  return {
    callId: `demo-call-${suffix}-${date}`,
    callSid: `DEMO-${suffix.toUpperCase()}-${date}`,
    outboxId: `demo-outbox-${suffix}-${date}`,
    ticketId: `demo-ticket-${suffix}-${date}`,
    escalationId: `demo-escalation-${date}`,
    toolId: `demo-tool-${suffix}-${date}`,
    ticketNumber: scenario === 'appointment_request' ? 101 : 102,
  };
}

function scenarioInput(scenario: HealthcareDemoScenarioKind): CreateServiceTicketInput {
  if (scenario === 'appointment_request') {
    return {
      callerFirstName: 'Ana',
      callerLastName: 'Lopez',
      callerPhone: '+15555550100',
      patientFirstName: 'Ana',
      patientLastName: 'Lopez',
      patientPhone: '+15555550100',
      callbackNumber: '+15555550100',
      reasonForCall: 'Annual eye exam request',
      outcomeType: 'appointment_request',
      requestedAction: 'Call back to arrange an appointment time',
      urgency: 'routine',
      callbackPreference: 'weekday afternoon',
      identityVerificationStatus: 'partially_verified',
      consentToContact: true,
      evidenceSource: ['caller_statement', 'caller_id'],
      callerType: 'patient',
    };
  }

  return {
    callerFirstName: 'Jordan',
    callerLastName: 'Reed',
    callerPhone: '+15555550101',
    patientFirstName: 'Jordan',
    patientLastName: 'Reed',
    patientPhone: '+15555550101',
    callbackNumber: '+15555550101',
    reasonForCall: 'Caller reports severe chest pain and asks what to do',
    outcomeType: 'urgent_escalation',
    requestedAction: 'Immediate human review after emergency-services direction',
    urgency: 'emergency',
    callbackPreference: 'immediate phone call if safe and available',
    identityVerificationStatus: 'unverified',
    consentToContact: true,
    evidenceSource: ['caller_statement', 'caller_id'],
    callerType: 'patient',
  };
}

function appointmentTranscript(timeLabel: string): HealthcareDemoTranscriptLine[] {
  return [
    { id: 'a1', speaker: 'assistant', language: 'es', text: 'Hola, soy la recepcionista virtual de Northstar Clinic.' },
    { id: 'a2', speaker: 'caller', language: 'es', text: 'Necesito una cita para un examen anual.' },
    { id: 'a3', speaker: 'assistant', language: 'es', text: 'Claro. ¿Me puede dar su nombre—', signal: 'caller_interruption' },
    { id: 'a4', speaker: 'caller', language: 'en', text: 'Sorry—English is easier. I am Ana Lopez.', signal: 'language_change' },
    { id: 'a5', speaker: 'assistant', language: 'en', text: `Of course. Today is ${timeLabel}. What callback number should staff use?`, signal: 'current_time' },
    { id: 'a6', speaker: 'caller', language: 'en', text: 'Use 555-555-0100, weekday afternoons.' },
    { id: 'a7', speaker: 'assistant', language: 'en', text: 'I have your number, afternoon preference, and annual eye exam request. I will not ask for them again.', signal: 'memory_retained' },
    { id: 'a8', speaker: 'assistant', language: 'en', text: 'Your appointment request was submitted for staff review. The clinic will call to confirm what happens next.', signal: 'tool_confirmed' },
  ];
}

function escalationTranscript(): HealthcareDemoTranscriptLine[] {
  return [
    { id: 's1', speaker: 'caller', language: 'en', text: 'I have severe chest pain. What should I do?', signal: 'safety_boundary' },
    { id: 's2', speaker: 'assistant', language: 'en', text: "I can't diagnose this. If this may be an immediate emergency, call 911 or emergency services now.", signal: 'safety_boundary' },
    { id: 's3', speaker: 'assistant', language: 'en', text: 'I can also record this for immediate human review, but that does not replace emergency services.', signal: 'human_escalation' },
    { id: 's4', speaker: 'assistant', language: 'en', text: 'The urgent request was submitted for staff review.', signal: 'tool_confirmed' },
  ];
}

function appointmentTimeline(): HealthcareDemoTimelineStep[] {
  return [
    { id: 't1', label: 'Spanish detected', detail: 'The same agent continued naturally in Spanish.', signal: 'language_change', status: 'complete' },
    { id: 't2', label: 'Caller interrupted', detail: 'The agent stopped, listened, and followed the caller into English.', signal: 'caller_interruption', status: 'complete' },
    { id: 't3', label: 'Memory retained', detail: 'Captured details were not requested again after the language change.', signal: 'memory_retained', status: 'complete' },
    { id: 't4', label: 'Current tenant time used', detail: 'The injected clinic-local date grounded the conversation.', signal: 'current_time', status: 'complete' },
    { id: 't5', label: 'Production tool contract confirmed', detail: 'createServiceTicket returned durable success and a staff-ready follow-up.', signal: 'tool_confirmed', status: 'complete' },
  ];
}

function escalationTimeline(): HealthcareDemoTimelineStep[] {
  return [
    { id: 't1', label: 'Clinical boundary held', detail: 'The agent did not diagnose or recommend treatment.', signal: 'safety_boundary', status: 'complete' },
    { id: 't2', label: 'Emergency direction given', detail: 'Emergency services were named before operational follow-up.', signal: 'human_escalation', status: 'complete' },
    { id: 't3', label: 'Production tool contract confirmed', detail: 'createServiceTicket returned success for immediate human review.', signal: 'tool_confirmed', status: 'complete' },
  ];
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, into));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, into));
  }
}

export function auditHealthcareDemoClaims(value: unknown): { valid: boolean; violations: string[] } {
  const strings: string[] = [];
  collectStrings(value, strings);
  const rules: Array<[string, RegExp]> = [
    ['unsupported appointment completion', /appointment\s+(?:is\s+|was\s+|has\s+been\s+)?(?:booked|confirmed)/i],
    ['unsupported financial outcome', /\$\s?\d|(?:recovered|saved)\s+(?:revenue|income|money)/i],
    ['unsupported compliance claim', /HIPAA\s+compliant/i],
    ['unsupported transfer completion', /transfer(?:red)?\s+(?:completed|successfully)|transfer\s+completed/i],
    ['unsupported live-call claim', /\bthis\s+is\s+a\s+live\s+call\b/i],
    ['prohibited clinical claim', /\bI\s+(?:diagnose|prescribe|recommend\s+treatment)\b/i],
  ];
  const violations = rules.flatMap(([label, pattern]) =>
    strings.some((item) => pattern.test(item)) ? [label] : []);
  return { valid: violations.length === 0, violations };
}

export async function executeHealthcareDemoScenario(
  scenario: HealthcareDemoScenarioKind,
  options: { now?: Date } = {},
): Promise<HealthcareDemoResult> {
  if (scenario !== 'appointment_request' && scenario !== 'safe_escalation') {
    throw new Error('Unsupported healthcare demo scenario');
  }
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('A valid healthcare demo clock is required');

  const role = createHealthcareReceptionistRolePackage({
    practiceName: 'Northstar Clinic',
    preferredLanguage: 'Spanish',
    timeZone: DEMO_TIME_ZONE,
  });
  if (!role.tools.some((tool) => tool.name === 'createServiceTicket')) {
    throw new Error('Healthcare role is missing the production createServiceTicket contract');
  }

  const ids = deterministicIds(scenario, now);
  let capturedOutbox: OutboxWriteParams | null = null;
  const outbox = {
    writeToOutbox: async (params: OutboxWriteParams) => {
      capturedOutbox = params;
      return { outboxId: ids.outboxId, alreadyExists: false };
    },
  } as Pick<OutboxService, 'writeToOutbox'> as OutboxService;

  const ticketResult = await createServiceTicket(scenarioInput(scenario), {
    tenantId: 'demo',
    callSid: ids.callSid,
    callLogId: ids.callId,
    outbox,
    config: DEFAULT_ANSWERING_SERVICE_CONFIG,
    localTicketProjector: async () => ({
      status: 'created',
      ticketId: ids.ticketId,
      ticketNumber: ids.ticketNumber,
    }),
  });
  if (!ticketResult.success || !capturedOutbox) {
    throw new Error('Healthcare demo production tool contract did not confirm success');
  }

  const time = buildTenantTimeContext(now, DEMO_TIME_ZONE);
  const transcript = scenario === 'appointment_request'
    ? appointmentTranscript(`${time.weekday}, ${time.date}`)
    : escalationTranscript();
  const outboxPayload = (capturedOutbox as OutboxWriteParams).payload;
  const ticket = {
    id: ids.ticketId,
    ticket_number: ids.ticketNumber,
    priority: scenario === 'safe_escalation' ? 'urgent' : 'medium',
    status: 'open',
    assignee_user_id: null,
    assignee_email: null,
  };
  const projection = buildHealthcareOutcomeDashboardProjection({
    call: {
      id: ids.callId,
      language: scenario === 'appointment_request' ? 'es-en' : 'en',
      lifecycle_state: 'CALL_COMPLETED',
      start_time: now.toISOString(),
      end_time: new Date(now.getTime() + 120_000).toISOString(),
      transcript_count: transcript.length,
      context: { transcript: true, recordingPolicy: { policy: 'disabled', status: 'not_recorded' } },
    },
    outbox: {
      id: ids.outboxId,
      payload: outboxPayload,
      status: 'sent',
      context: { ticketNumber: `DEMO-${ids.ticketNumber}` },
    },
    ticket,
    tool: {
      id: ids.toolId,
      tool_name: 'createServiceTicket',
      status: 'success',
      error_message: null,
      invoked_at: new Date(now.getTime() + 90_000).toISOString(),
      result: ticketResult,
    },
    escalation: scenario === 'safe_escalation' ? {
      id: ids.escalationId,
      reason: 'Caller-stated emergency concern',
      priority: 'critical',
      status: 'pending',
      assigned_to: null,
      assigned_to_email: null,
      tool_name: 'createServiceTicket',
      created_at: new Date(now.getTime() + 90_000).toISOString(),
    } : null,
  });

  const result: HealthcareDemoResult = {
    mode: 'guided_production_workflow',
    disclosure: DEMO_DISCLOSURE,
    scenario,
    runtime: {
      coreVersion: MASTER_VOICE_AGENT_CORE_VERSION,
      rolePackageId: 'healthcare-receptionist',
      rolePackageVersion: HEALTHCARE_RECEPTIONIST_ROLE_VERSION,
    },
    transcript,
    timeline: scenario === 'appointment_request' ? appointmentTimeline() : escalationTimeline(),
    tool: {
      name: 'createServiceTicket',
      status: 'success',
      productionContract: true,
      confirmationMessage: ticketResult.confirmationMessage,
    },
    projection,
    claims: [projection.operationalValue.evidence],
  };
  const audit = auditHealthcareDemoClaims(result);
  if (!audit.valid) throw new Error(`Healthcare demo claim audit failed: ${audit.violations.join(', ')}`);
  return result;
}
