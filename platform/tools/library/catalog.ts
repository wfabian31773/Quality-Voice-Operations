/**
 * Canonical tool library for the Master Voice Agent core.
 *
 * Role packages select from this chest. They do not invent a second
 * execution path. Every library tool has one name, one schema, and one
 * executable handler registered at gateway boot.
 */

export type ToolLibraryCategory =
  | 'runtime'
  | 'sms'
  | 'email'
  | 'tickets'
  | 'scheduling'
  | 'dispatch'
  | 'crm'
  | 'knowledge'
  | 'workforce';

export interface ToolLibraryEntry {
  name: string;
  description: string;
  category: ToolLibraryCategory;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
}

export const TOOL_LIBRARY: readonly ToolLibraryEntry[] = [
  {
    name: 'get_current_tenant_time',
    description: 'Return the current weekday, date, time, timezone, and UTC offset for this tenant. Use when a date or time boundary may have changed during the call.',
    category: 'runtime',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'record_language_change',
    description: 'Record that the caller changed spoken language. Do not announce this tool call.',
    category: 'runtime',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'BCP-47 language code, e.g. es, en, zh' },
        confidence: { type: 'number', description: '0-1 confidence that the language changed' },
      },
      required: ['language'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_sms',
    description: 'Text the caller one of the shop\'s fixed SMS templates. You cannot write the message: pick templateKey and fill vars. confirmation (after a booking is stored): vars businessName, summary, e.g. "a men\'s cut with Marco, Tue Oct 20 at 3:30 PM". directions: vars businessName, address. link: vars businessName, url (an https link from the business info). Read the number back as "the number ending in 0142" and get a yes first. Say it was sent only when status is queued; deferred_quiet_hours means they get it in the morning.',
    category: 'sms',
    parameters: {
      type: 'object',
      properties: {
        toNumber: { type: 'string', description: 'Destination phone number in E.164 format. Defaults to the caller number.' },
        templateKey: {
          type: 'string',
          enum: ['confirmation', 'directions', 'link'],
          description: 'confirmation = booking confirmed; directions = shop address; link = a shop link the caller asked for',
        },
        vars: {
          type: 'object',
          description: 'Template variables, only the ones the template uses. confirmation: { businessName, summary }. directions: { businessName, address }. link: { businessName, url }.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['templateKey', 'vars'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_email',
    description: 'Send an email through the tenant email service. Confirm the recipient and subject with the caller before sending.',
    category: 'email',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Plain-text email body' },
        replyTo: { type: 'string', description: 'Optional reply-to address' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_ticket',
    description: 'Create a staff-ready support ticket. Use after the caller confirms the request. Never claim the underlying work is complete.',
    category: 'tickets',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Short ticket subject' },
        description: { type: 'string', description: 'What the caller needs staff to do' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        contactName: { type: 'string' },
        contactPhone: { type: 'string' },
        contactEmail: { type: 'string' },
        category: { type: 'string' },
      },
      required: ['subject', 'description', 'contactName', 'contactPhone'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_booking',
    description: 'Create a scheduling booking request. Treat this as a request until the tool confirms a stored booking. Never invent availability.',
    category: 'scheduling',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Appointment title' },
        startTime: { type: 'string', description: 'ISO-8601 start time in the tenant timezone or UTC' },
        durationMinutes: { type: 'number', description: 'Duration in minutes. Defaults to 30.' },
        contactName: { type: 'string' },
        contactPhone: { type: 'string' },
        contactEmail: { type: 'string' },
        notes: { type: 'string' },
        confirmationToken: { type: 'string', description: 'Server-issued token from a previous create_booking challenge, sent after the caller confirmed the readback.' },
      },
      required: ['title', 'startTime', 'contactName', 'contactPhone'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_booking',
    description: 'Cancel or reschedule one of the caller\'s upcoming bookings. If more than one matches, list them and ask which. If exactly one matches, confirm it with the caller before applying. Never change a booking until the caller confirms and you pass back the confirmationToken from the previous challenge. Reschedule requires startTime. Uses the shop scheduling lifecycle (conflicts, blackouts, waitlist, calendar, audit).',
    category: 'scheduling',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['cancel', 'reschedule'], description: 'Cancel the existing booking or move it to a new time' },
        startTime: { type: 'string', description: 'New ISO-8601 start time. Required when action is reschedule.' },
        bookingId: { type: 'string', description: 'Existing booking id after the caller chose one of several upcoming visits' },
        confirmationToken: { type: 'string', description: 'Server-issued token from the previous update_booking challenge. Required to apply the change.' },
        confirmed: { type: 'boolean', description: 'Ignored unless paired with a valid confirmationToken from a prior challenge' },
        notes: { type: 'string', description: 'Cancel reason or reschedule notes' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_dispatch_job',
    description: 'Create a field dispatch job for a technician. Confirm address and timing before creating.',
    category: 'dispatch',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        address: { type: 'string' },
        contactName: { type: 'string' },
        contactPhone: { type: 'string' },
        contactEmail: { type: 'string' },
        scheduledAt: { type: 'string', description: 'ISO-8601 scheduled time if the caller requested one' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        jobType: { type: 'string' },
      },
      required: ['title', 'description', 'contactName', 'contactPhone'],
      additionalProperties: false,
    },
  },
  {
    name: 'lookup_customer',
    description: 'Look up a customer by phone number or name. Returns recent calls and campaign participation.',
    category: 'crm',
    parameters: {
      type: 'object',
      properties: {
        phoneNumber: { type: 'string' },
        name: { type: 'string' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'retrieve_knowledge',
    description: 'Search approved tenant knowledge before answering product, policy, hours, or FAQ questions.',
    category: 'knowledge',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or topic to search' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Create a human escalation task and optionally transfer the live call. Use when the caller asks for a person, a tool fails, or the request is outside policy.',
    category: 'workforce',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the call needs a human' },
        urgency: { type: 'string', enum: ['normal', 'high', 'urgent'] },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_call_outcome',
    description: 'Record the call disposition after the caller need is captured.',
    category: 'crm',
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', description: 'Short disposition label' },
        notes: { type: 'string' },
      },
      required: ['outcome'],
      additionalProperties: false,
    },
  },
] as const;

export const TOOL_LIBRARY_NAMES = TOOL_LIBRARY.map((tool) => tool.name);

export function getToolLibraryEntry(name: string): ToolLibraryEntry | undefined {
  return TOOL_LIBRARY.find((tool) => tool.name === name);
}

export function listToolLibrary(category?: ToolLibraryCategory): ToolLibraryEntry[] {
  return TOOL_LIBRARY.filter((tool) => !category || tool.category === category);
}

export function toRolePackageTools(names?: readonly string[]) {
  const selected = names ? TOOL_LIBRARY.filter((tool) => names.includes(tool.name)) : [...TOOL_LIBRARY];
  return selected.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
