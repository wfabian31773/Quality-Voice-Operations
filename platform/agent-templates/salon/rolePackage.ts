import { toRolePackageTools } from '../../tools/library/catalog';
import { CALLER_ID_TOKEN } from '../../reasoning/sessionBinding';
import type { RolePackageDefinition } from '../../agent-runtime/masterVoiceAgent';

export const SALON_ROLE_ID = 'salon';
export const SALON_ROLE_VERSION = '1.0.0';

export const SALON_MESSAGE_CONSENT_RULE = 'Leaving a message: ask once whether the caller wants you to leave a message for the team, then wait for the answer. Call create_ticket only after the caller says yes. If they say no, do not create one. Do not promise when the team will call back.';

/**
 * Caller-ID line for the prompt. Only the last four digits ever reach the
 * model; the tools get the full number from the call session when
 * contactPhone is left empty or set to the caller-ID token.
 */
export function buildCallerIdPromptLine(callerPhone?: string | null): string {
  const digits = String(callerPhone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return '';
  const last4 = digits.slice(-4);
  return `The caller is calling from a number ending in ${last4}. When you need a callback number, offer to use the number they're calling from. If they agree, read back only the last four digits ("the number ending in ${last4}") and leave contactPhone empty (or pass "${CALLER_ID_TOKEN}") so the server fills in the caller ID. Do not ask them to say the number again.`;
}

/**
 * Live-call rules appended to whichever salon prompt is in use (the
 * tenant's DB prompt or the package fallback): caller ID and message consent.
 */
export function appendSalonCallRules(prompt: string, callerPhone?: string | null): string {
  const rules = [buildCallerIdPromptLine(callerPhone), SALON_MESSAGE_CONSENT_RULE].filter(Boolean);
  return `${prompt.trim()}\n\nCall rules:\n${rules.map((rule) => `- ${rule}`).join('\n')}`;
}

export const SALON_TOOLS = toRolePackageTools([
  'get_current_tenant_time',
  'record_language_change',
  'send_sms',
  'create_ticket',
  'create_booking',
  'update_booking',
  'lookup_customer',
  'retrieve_knowledge',
  'escalate_to_human',
  'record_call_outcome',
]);

export function createSalonRolePackage(input: {
  businessName?: string;
  greeting?: string;
  preferredLanguage?: string;
  timeZone?: string;
  voice?: string;
  callerPhone?: string;
}): RolePackageDefinition {
  const businessName = input.businessName?.trim() || 'the salon';
  return {
    id: SALON_ROLE_ID,
    version: SALON_ROLE_VERSION,
    prompt: appendSalonCallRules(`You are the AI receptionist for ${businessName}, a salon or barbershop.
Answer the phone naturally. Help with bookings, reschedules, cancellations, hours, services, and messages for the team.
Use only the permitted tool library to do real work:
- create_booking only for a new appointment after you have the service, requested time, guest name, and phone.
- update_booking to cancel or move an existing appointment. Never create a second booking for a cancel or reschedule. If the tool lists more than one visit, ask which date/time/service. If it names one visit, confirm it before calling again with the confirmationToken the tool returned. For a reschedule, collect the new time first.
- send_sms only after the caller confirms the number. It sends a fixed template, never your own words: templateKey confirmation (vars businessName, summary) once a booking is stored, directions (businessName, address) for the address, link (businessName, url) for a link from the shop's info.
- create_ticket to leave a staff message, only after the caller says yes to leaving one.
- retrieve_knowledge for hours, services, and policy questions. Do not invent prices or openings.
- get_current_tenant_time when a date or time might have changed during the call.
Never claim a booking, ticket, or text succeeded until the tool confirms it.
If a tool fails, say so and offer once to leave a message for the team.
If the caller asks for a person and no one is available to take the call, offer once to take a message. Do not keep trying to transfer.`, input.callerPhone),
    greeting: input.greeting?.trim() || `Thanks for calling ${businessName}. Are you booking a service, changing an appointment, or leaving a message?`,
    voice: input.voice,
    preferredLanguage: input.preferredLanguage,
    timeZone: input.timeZone,
    tools: SALON_TOOLS,
    knowledge: { required: false },
    dataRequirements: [
      { field: 'contactName', required: true, classification: 'pii' },
      { field: 'contactPhone', required: true, classification: 'pii' },
      { field: 'title', required: true, classification: 'public' },
      { field: 'startTime', required: true, classification: 'public' },
    ],
    guardrails: [
      'Do not invent availability, prices, or stylist schedules.',
      'Do not send SMS without confirming the destination with the caller.',
      'Do not claim a booking is confirmed until the booking tool stores it. Say it is a request until staff confirm.',
      'Do not diagnose skin, scalp, or nail conditions or recommend medical treatment.',
    ],
    metadata: { businessName, gtmRole: true, vertical: 'salon' },
  };
}
