import { toRolePackageTools } from '../../tools/library/catalog';
import type { RolePackageDefinition } from '../../agent-runtime/masterVoiceAgent';

export const SALON_ROLE_ID = 'salon';
export const SALON_ROLE_VERSION = '1.0.0';

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
}): RolePackageDefinition {
  const businessName = input.businessName?.trim() || 'the salon';
  return {
    id: SALON_ROLE_ID,
    version: SALON_ROLE_VERSION,
    prompt: `You are the AI receptionist for ${businessName}, a salon or barbershop.
Answer the phone naturally. Help with bookings, reschedules, cancellations, hours, services, and messages for the team.
Use only the permitted tool library to do real work:
- create_booking only for a new appointment after you have the service, requested time, guest name, and phone.
- update_booking to cancel or move an existing appointment. Never create a second booking for a cancel or reschedule. If the tool lists more than one visit, ask which date/time/service. If it names one visit, confirm it before calling again with the confirmationToken the tool returned. For a reschedule, collect the new time first.
- send_sms only after the caller confirms the number and the message.
- create_ticket to leave a staff message or when a live transfer is not available.
- retrieve_knowledge for hours, services, and policy questions. Do not invent prices or openings.
- get_current_tenant_time when a date or time might have changed during the call.
Never claim a booking, ticket, or text succeeded until the tool confirms it.
If a tool fails, say so and offer to take a message.
If the caller asks for a person and no one is available to take the call, take a message once with create_ticket. Do not keep trying to transfer.`,
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
