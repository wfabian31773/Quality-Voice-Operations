import { toRolePackageTools } from '../../tools/library/catalog';
import type { RolePackageDefinition } from '../../agent-runtime/masterVoiceAgent';

export const CORE_RECEPTIONIST_ROLE_ID = 'core-receptionist';
export const CORE_RECEPTIONIST_ROLE_VERSION = '1.0.0';

export const CORE_RECEPTIONIST_TOOLS = toRolePackageTools([
  'get_current_tenant_time',
  'record_language_change',
  'send_sms',
  'send_email',
  'create_ticket',
  'create_booking',
  'create_dispatch_job',
  'lookup_customer',
  'retrieve_knowledge',
  'escalate_to_human',
  'record_call_outcome',
]);

export function createCoreReceptionistRolePackage(input: {
  businessName?: string;
  greeting?: string;
  preferredLanguage?: string;
  timeZone?: string;
  voice?: string;
}): RolePackageDefinition {
  const businessName = input.businessName?.trim() || 'the business';
  return {
    id: CORE_RECEPTIONIST_ROLE_ID,
    version: CORE_RECEPTIONIST_ROLE_VERSION,
    prompt: `You are the AI receptionist for ${businessName}.
Answer the phone naturally. Capture the caller's need. Use only the permitted tool library to do real work.
Never invent availability, never claim a ticket, SMS, email, booking, or dispatch job succeeded until the tool confirms it.
If a tool fails, say so and offer a human follow-up.
Collect name, callback number, and a staff-ready summary before creating work.`,
    greeting: input.greeting?.trim() || `Thank you for calling ${businessName}. How can I help you today?`,
    voice: input.voice,
    preferredLanguage: input.preferredLanguage,
    timeZone: input.timeZone,
    tools: CORE_RECEPTIONIST_TOOLS,
    knowledge: { required: false },
    dataRequirements: [
      { field: 'callerName', required: true, classification: 'pii' },
      { field: 'callbackNumber', required: true, classification: 'pii' },
      { field: 'requestedAction', required: true, classification: 'public' },
    ],
    guardrails: [
      'Do not invent prices, appointments, legal advice, or medical advice.',
      'Do not send SMS or email without confirming the destination with the caller.',
      'Do not claim a booking is confirmed until the booking tool and staff process say so.',
    ],
    metadata: { businessName, gtmRole: true },
  };
}
