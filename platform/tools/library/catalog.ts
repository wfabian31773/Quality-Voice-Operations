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
    description: 'Send an SMS to a phone number and persist it in the tenant SMS inbox. Confirm the destination and message with the caller before sending.',
    category: 'sms',
    parameters: {
      type: 'object',
      properties: {
        toNumber: { type: 'string', description: 'Destination phone number in E.164 format' },
        body: { type: 'string', description: 'SMS body. Keep it short and factual.' },
        fromNumber: { type: 'string', description: 'Optional from number. Defaults to the tenant Twilio number.' },
      },
      required: ['toNumber', 'body'],
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
      },
      required: ['title', 'startTime', 'contactName', 'contactPhone'],
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
