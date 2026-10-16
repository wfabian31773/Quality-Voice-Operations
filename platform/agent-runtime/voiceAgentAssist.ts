import { TOOL_LIBRARY_NAMES } from '../tools/library/catalog';
import {
  MASTER_VOICE_AGENT_DEFAULT_VOICE,
  MASTER_VOICE_AGENT_MODEL,
} from './masterVoiceAgent';

export const VOICE_AGENT_TEMPLATE_IDS = [
  'customer_support',
  'sales_associate',
  'appointment_scheduler',
  'personal_assistant',
  'lead_qualification',
  'blank',
] as const;

export type VoiceAgentTemplateId = (typeof VOICE_AGENT_TEMPLATE_IDS)[number];

export interface VoiceAgentTemplate {
  id: VoiceAgentTemplateId;
  name: string;
  tagline: string;
  defaultAgentName: string;
  defaultTools: readonly string[];
}

export const VOICE_AGENT_TEMPLATES: readonly VoiceAgentTemplate[] = [
  {
    id: 'customer_support',
    name: 'Customer Support',
    tagline: 'Resolve issues',
    defaultAgentName: 'Support Concierge',
    defaultTools: [
      'get_current_tenant_time',
      'record_language_change',
      'retrieve_knowledge',
      'create_ticket',
      'send_sms',
      'lookup_customer',
      'escalate_to_human',
      'record_call_outcome',
    ],
  },
  {
    id: 'sales_associate',
    name: 'Sales Associate',
    tagline: 'Help buyers move forward',
    defaultAgentName: 'Sales Associate',
    defaultTools: [
      'get_current_tenant_time',
      'record_language_change',
      'lookup_customer',
      'send_sms',
      'send_email',
      'create_booking',
      'record_call_outcome',
      'escalate_to_human',
    ],
  },
  {
    id: 'appointment_scheduler',
    name: 'Appointment Scheduler',
    tagline: 'Book appointments',
    defaultAgentName: 'Scheduler',
    defaultTools: [
      'get_current_tenant_time',
      'record_language_change',
      'create_booking',
      'send_sms',
      'lookup_customer',
      'escalate_to_human',
    ],
  },
  {
    id: 'personal_assistant',
    name: 'Personal Assistant',
    tagline: 'Check email and calendar',
    defaultAgentName: 'Personal Assistant',
    defaultTools: [
      'get_current_tenant_time',
      'record_language_change',
      'send_email',
      'send_sms',
      'create_booking',
      'retrieve_knowledge',
    ],
  },
  {
    id: 'lead_qualification',
    name: 'Lead Qualification',
    tagline: 'Screen inbound leads',
    defaultAgentName: 'Lead Qualifier',
    defaultTools: [
      'get_current_tenant_time',
      'record_language_change',
      'lookup_customer',
      'record_call_outcome',
      'send_sms',
      'create_ticket',
      'escalate_to_human',
    ],
  },
  {
    id: 'blank',
    name: 'Blank agent',
    tagline: 'Start from scratch',
    defaultAgentName: 'Untitled',
    defaultTools: [
      'get_current_tenant_time',
      'record_language_change',
      'escalate_to_human',
      'record_call_outcome',
    ],
  },
];

export interface AssistChatMessage {
  role: 'assistant' | 'user';
  content: string;
}

export interface VoiceAgentDraft {
  name: string;
  type: 'general';
  templateId: VoiceAgentTemplateId;
  businessName: string;
  website: string;
  systemPrompt: string;
  welcomeGreeting: string;
  tools: string[];
  language: string;
  voice: string;
  model: string;
}

export interface AssistTurnInput {
  messages: AssistChatMessage[];
  templateId?: string | null;
  skip?: boolean;
}

export interface AssistTurnResult {
  messages: AssistChatMessage[];
  draft: VoiceAgentDraft;
  done: boolean;
}

const LIBRARY_NAME_SET = new Set<string>(TOOL_LIBRARY_NAMES);

const OPENING =
  "Hey! I'm here to help you set up a voice agent in just a couple of minutes. What's the use case you're building for? Describe it in your own words, or tap a template below.";

const ASK_BUSINESS =
  "Great, let's build that agent. What's the name of your business, and is there a website I can check out or can you tell me a bit about what you do?";

export function isVoiceAgentTemplateId(value: unknown): value is VoiceAgentTemplateId {
  return typeof value === 'string' && (VOICE_AGENT_TEMPLATE_IDS as readonly string[]).includes(value);
}

export function getVoiceAgentTemplate(id: VoiceAgentTemplateId): VoiceAgentTemplate {
  return VOICE_AGENT_TEMPLATES.find((template) => template.id === id) ?? VOICE_AGENT_TEMPLATES[5];
}

export function sanitizeLibraryTools(names: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const name of names) {
    if (LIBRARY_NAME_SET.has(name)) unique.add(name);
  }
  unique.add('get_current_tenant_time');
  unique.add('record_language_change');
  return TOOL_LIBRARY_NAMES.filter((name) => unique.has(name));
}

export function inferTemplateFromText(text: string): VoiceAgentTemplateId {
  const value = text.toLowerCase();
  if (/\b(schedul|appoint|book|calendar)\b/.test(value)) return 'appointment_scheduler';
  if (/\b(sales|buyer|quote|pricing|close)\b/.test(value)) return 'sales_associate';
  if (/\b(lead|qualif|screen|inbound)\b/.test(value)) return 'lead_qualification';
  if (/\b(assistant|email|calendar|personal)\b/.test(value)) return 'personal_assistant';
  if (/\b(support|ticket|help desk|customer|billing|account)\b/.test(value)) return 'customer_support';
  return 'customer_support';
}

function extractBusinessName(text: string): string {
  const named = text.match(/(?:called|name is|we're|we are|business is)\s+([A-Z][\w&'’.-]+(?:\s+[A-Z][\w&'’.-]+){0,3})/);
  if (named?.[1]) return named[1].trim();
  const quoted = text.match(/["“]([^"”]{2,60})["”]/);
  if (quoted?.[1]) return quoted[1].trim();
  const beforeUrl = text.replace(/\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.[a-z]{2,}\S*/gi, '').trim();
  const titleCase = beforeUrl.match(/\b([A-Z][\w&'’.-]+(?:\s+[A-Z][\w&'’.-]+){0,3})\b/);
  if (titleCase?.[1]) return titleCase[1].trim();
  if (beforeUrl.length >= 2 && beforeUrl.length <= 60) {
    return beforeUrl.replace(/^(?:my |our |the )/i, '').trim();
  }
  const websiteMatch = text.match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+)\.[a-z]{2,}\b/i);
  if (websiteMatch?.[1] && websiteMatch[1] !== 'www') {
    return websiteMatch[1].replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return 'the business';
}

function extractWebsite(text: string): string {
  const match = text.match(/\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+|\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?/i);
  return match?.[0] ?? '';
}

function buildPrompt(template: VoiceAgentTemplate, businessName: string, useCase: string): string {
  const company = businessName.trim() || 'the business';
  const focus = useCase.trim() || template.tagline;
  return `You are the voice agent for ${company}.
${focus}

Answer the phone naturally. Capture the caller's need. Use only the permitted tools to do real work.
Never invent availability, prices, or outcomes. Never claim a ticket, SMS, email, booking, or dispatch job succeeded until the tool confirms it.
If a tool fails, say so and offer a human follow-up.
Collect name, callback number, and a staff-ready summary before creating work.`;
}

function buildGreeting(businessName: string): string {
  const company = businessName.trim();
  if (!company || company === 'the business') return 'Thank you for calling. How can I help you today?';
  return `Thank you for calling ${company}. How can I help you today?`;
}

export function emptyDraft(templateId: VoiceAgentTemplateId = 'blank'): VoiceAgentDraft {
  const template = getVoiceAgentTemplate(templateId);
  return {
    name: template.defaultAgentName,
    type: 'general',
    templateId,
    businessName: '',
    website: '',
    systemPrompt: '',
    welcomeGreeting: '',
    tools: sanitizeLibraryTools(template.defaultTools),
    language: 'en',
    voice: MASTER_VOICE_AGENT_DEFAULT_VOICE,
    model: MASTER_VOICE_AGENT_MODEL,
  };
}

export function finalizeDraft(input: {
  templateId: VoiceAgentTemplateId;
  businessName: string;
  website?: string;
  useCase?: string;
}): VoiceAgentDraft {
  const template = getVoiceAgentTemplate(input.templateId);
  const businessName = input.businessName.trim() || 'the business';
  const name = businessName === 'the business'
    ? template.defaultAgentName
    : `${businessName} ${template.defaultAgentName}`.replace(/\s+/g, ' ').trim();
  return {
    name: name.slice(0, 80),
    type: 'general',
    templateId: input.templateId,
    businessName,
    website: input.website?.trim() ?? '',
    systemPrompt: buildPrompt(template, businessName, input.useCase ?? template.tagline),
    welcomeGreeting: buildGreeting(businessName),
    tools: sanitizeLibraryTools(template.defaultTools),
    language: 'en',
    voice: MASTER_VOICE_AGENT_DEFAULT_VOICE,
    model: MASTER_VOICE_AGENT_MODEL,
  };
}

function lastUserText(messages: AssistChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].content.trim();
  }
  return '';
}

export function runVoiceAgentAssistTurn(input: AssistTurnInput): AssistTurnResult {
  const templateId = isVoiceAgentTemplateId(input.templateId) ? input.templateId : undefined;
  const userMessages = input.messages.filter((message) => message.role === 'user');

  if (input.skip) {
    const draft = finalizeDraft({ templateId: templateId ?? 'blank', businessName: 'the business' });
    return {
      messages: [
        { role: 'assistant', content: OPENING },
        { role: 'assistant', content: 'Skipped the interview. I started a blank agent you can finish in Configuration.' },
      ],
      draft,
      done: true,
    };
  }

  if (userMessages.length === 0) {
    const opening = templateId && templateId !== 'blank'
      ? ASK_BUSINESS
      : OPENING;
    return {
      messages: [{ role: 'assistant', content: opening }],
      draft: emptyDraft(templateId ?? 'blank'),
      done: false,
    };
  }

  const firstUser = userMessages[0].content.trim();
  const inferred = templateId && templateId !== 'blank' ? templateId : inferTemplateFromText(firstUser);

  if (userMessages.length === 1 && !templateId) {
    return {
      messages: [
        ...input.messages,
        { role: 'assistant', content: ASK_BUSINESS },
      ],
      draft: emptyDraft(inferred),
      done: false,
    };
  }

  const businessSource = userMessages.length > 1 ? lastUserText(input.messages) : firstUser;
  const draft = finalizeDraft({
    templateId: inferred,
    businessName: extractBusinessName(businessSource),
    website: extractWebsite(businessSource),
    useCase: firstUser,
  });

  return {
    messages: [
      ...input.messages,
      {
        role: 'assistant',
        content: `I drafted ${draft.name}. Review the instructions and tools, then publish when you are ready.`,
      },
    ],
    draft,
    done: true,
  };
}
