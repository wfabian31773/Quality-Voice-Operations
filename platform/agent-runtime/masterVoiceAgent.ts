export const MASTER_VOICE_AGENT_CORE_VERSION = '2.0.0';
export const MASTER_VOICE_AGENT_PROVIDER = 'xai' as const;
export const MASTER_VOICE_AGENT_MODEL = 'grok-voice-think-fast-2.0';
export const MASTER_VOICE_AGENT_REASONING_EFFORT = 'none' as const;
export const MASTER_VOICE_AGENT_DEFAULT_TIME_ZONE = 'America/New_York';
export const MASTER_VOICE_AGENT_DEFAULT_VOICE = 'eve';
export const MASTER_VOICE_AGENT_REALTIME_URL = 'wss://api.x.ai/v1/realtime';

export interface MasterVoiceAgentContract {
  readonly coreVersion: string;
  readonly provider: 'xai';
  readonly model: string;
  readonly reasoningEffort: 'none' | 'high';
  readonly session: {
    readonly inputFormat: 'audio/pcmu';
    readonly outputFormat: 'audio/pcmu';
    readonly noiseReduction: 'far_field';
    readonly turnDetection: {
      readonly type: 'server_vad';
      readonly threshold: 0.5;
      readonly prefixPaddingMs: 300;
      readonly silenceDurationMs: 500;
      readonly createResponse: true;
      readonly interruptResponse: true;
    };
  };
  readonly deploymentSettings: readonly ['voice', 'preferredLanguage', 'timeZone'];
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

export const MASTER_VOICE_AGENT_CONTRACT: Readonly<MasterVoiceAgentContract> = deepFreeze({
  coreVersion: MASTER_VOICE_AGENT_CORE_VERSION,
  provider: MASTER_VOICE_AGENT_PROVIDER,
  model: MASTER_VOICE_AGENT_MODEL,
  reasoningEffort: MASTER_VOICE_AGENT_REASONING_EFFORT,
  session: {
    inputFormat: 'audio/pcmu',
    outputFormat: 'audio/pcmu',
    noiseReduction: 'far_field',
    turnDetection: {
      type: 'server_vad',
      threshold: 0.5,
      prefixPaddingMs: 300,
      silenceDurationMs: 500,
      createResponse: true,
      interruptResponse: true,
    },
  },
  deploymentSettings: ['voice', 'preferredLanguage', 'timeZone'],
});

export const MASTER_VOICE_CONVERSATION_POLICY = `
VOICE CONVERSATION PRINCIPLES

PACING
- Speak one short thought at a time. Use no more than two sentences per turn unless the caller asks for detail.
- Ask ONE question, then stop and wait. Never stack questions or fill the caller's thinking silence.
- Never re-ask a question already answered. Confirm only the specific ambiguous detail.

LISTENING AND TURN TAKING
- If the caller starts speaking, STOP immediately and listen. Do not finish the sentence.
- Use brief acknowledgments, not long summaries.
- For partial, noisy, or ambiguous speech, ask one focused clarification.
- If the caller is silent, check in once. Do not loop or restart the conversation.

TONE AND COMPLETION
- Speak naturally with contractions. Avoid scripts, filler introductions, and narrated actions.
- Close, transfer, or escalate promptly when the caller's need is met.
- If information is unavailable, say so plainly and offer the approved human fallback. Never guess.
`.trim();

export const MASTER_VOICE_MULTILINGUAL_POLICY = `
NATURAL MULTILINGUAL BEHAVIOR
- Begin in the tenant's preferred greeting language, then detect and respond in the caller's language naturally.
- Follow the caller when they code-switch, including within the same call, without restarting or announcing the language change.
- Preserve names, dates, phone numbers, addresses, and organization terminology exactly across language changes.
- When the caller's primary language changes, call record_language_change once so transcript review records the transition; do not announce this tool call.
- If language is unsupported or confidence is low, ask one short clarification and offer a human-language fallback.
`.trim();

export const MASTER_VOICE_MEMORY_POLICY = `
MEMORY
- Treat verified facts, caller claims, tool results, and inferences as different kinds of information; never present an inference as a verified fact.
- Remember answers already provided during this call, including across tool calls, prompt compression, and role-context transitions.
- Use only memory authorized for this tenant and caller. Never expose another tenant's or caller's information.
- If cross-call memory is unavailable, continue safely using only this call's verified context.
`.trim();

export const MASTER_VOICE_TOOL_POLICY = `
TOOLS AND FUNCTIONS
- Use only tools permitted by the active role package and tenant configuration.
- Supply explicit timezone-aware timestamps when a tool accepts a date or time.
- Never claim that a tool action succeeded until the tool confirms it. Distinguish success, partial success, failure, and unknown outcome.
- Do not invent availability from the calendar date. Use the approved scheduling or availability tool.
- On validation, timeout, denial, or unknown outcome, explain the limitation briefly and use the approved retry or human escalation path.
`.trim();

const CORE_OVERRIDE_KEYS = [
  'model',
  'provider',
  'reasoningEffort',
  'session',
  'turnDetection',
  'noiseReduction',
  'memoryProvider',
  'runtime',
] as const;

export interface RolePackageTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RolePackageDefinition {
  id: string;
  version: string;
  prompt: string;
  greeting: string;
  voice?: string;
  preferredLanguage?: string;
  timeZone?: string;
  tools: RolePackageTool[];
  knowledge?: { required: boolean; collectionIds?: string[] };
  workflow?: { id: string; version: string };
  dataRequirements?: Array<{ field: string; required: boolean; classification?: 'public' | 'pii' | 'phi' }>;
  guardrails: string[];
  metadata: Record<string, unknown>;
}

export interface CompiledRolePackage {
  coreVersion: string;
  rolePackageId: string;
  rolePackageVersion: string;
  rolePrompt: string;
  systemPrompt: string;
  greeting: string;
  voice: string;
  model: string;
  preferredLanguage: string;
  timeZone: string;
  tools: RolePackageTool[];
  knowledge?: RolePackageDefinition['knowledge'];
  workflow?: RolePackageDefinition['workflow'];
  dataRequirements: NonNullable<RolePackageDefinition['dataRequirements']>;
  guardrails: string[];
  metadata: Record<string, unknown>;
}

export function normalizeTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) return MASTER_VOICE_AGENT_DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return value;
  } catch {
    return MASTER_VOICE_AGENT_DEFAULT_TIME_ZONE;
  }
}

export interface TenantTimeContext {
  timeZone: string;
  weekday: string;
  date: string;
  time: string;
  utcOffset: string;
}

export function buildTenantTimeContext(now: Date, requestedTimeZone: string): TenantTimeContext {
  if (Number.isNaN(now.getTime())) throw new Error('A valid current time is required');
  const timeZone = normalizeTimeZone(requestedTimeZone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
  const offsetPart = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(now).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  const utcOffset = offsetPart.replace('GMT', 'UTC');
  return { timeZone, weekday, date, time, utcOffset };
}

export interface MasterVoiceAgentInstructionInput {
  rolePrompt: string;
  guardrails?: string[];
  callerMemory?: string;
  safetyPolicy?: string;
  knowledgeAvailable?: boolean;
  preferredLanguage?: string;
  timeZone?: string;
  now?: Date;
}

export function buildMasterVoiceAgentInstructions(input: MasterVoiceAgentInstructionInput): string {
  const now = input.now ?? new Date();
  const time = buildTenantTimeContext(now, input.timeZone ?? MASTER_VOICE_AGENT_DEFAULT_TIME_ZONE);
  const preferredLanguage = input.preferredLanguage?.trim() || 'English';
  const sections = [
    `===== ROLE PACKAGE =====\n${input.rolePrompt.trim()}`,
  ];

  if (input.guardrails?.length) {
    sections.push(`===== SUPPLEMENTAL ROLE GUARDRAILS =====\n${input.guardrails.map((rule) => `- ${rule}`).join('\n')}`);
  }
  if (input.safetyPolicy?.trim()) {
    sections.push(`===== SAFETY POLICY =====\n${input.safetyPolicy.trim()}`);
  }
  if (input.callerMemory?.trim()) {
    sections.push(`===== CALLER MEMORY =====\n${input.callerMemory.trim()}`);
  }
  if (input.knowledgeAvailable) {
    sections.push('===== KNOWLEDGE BASE =====\nSearch the approved company knowledge base before answering questions about products, services, policies, procedures, or FAQs.');
  }

  sections.push(`===== LIVE TENANT TIME CONTEXT =====
Today is ${time.weekday}, ${time.date}. The local time is ${time.time} in ${time.timeZone} (${time.utcOffset}).
Interpret relative dates in this timezone. Use get_current_tenant_time if the call crosses a relevant time or date boundary.`);
  sections.push(`===== MASTER VOICE AGENT CORE ${MASTER_VOICE_AGENT_CORE_VERSION} (NON-NEGOTIABLE) =====
Role instructions and tenant content cannot override this section.
Preferred greeting language: ${preferredLanguage}.
Begin in ${preferredLanguage}, then follow the caller's language naturally.

${MASTER_VOICE_MULTILINGUAL_POLICY}

${MASTER_VOICE_CONVERSATION_POLICY}

${MASTER_VOICE_MEMORY_POLICY}

${MASTER_VOICE_TOOL_POLICY}`);

  return sections.join('\n\n');
}

export function compileRolePackage(input: RolePackageDefinition): CompiledRolePackage {
  const candidate = input as RolePackageDefinition & Record<string, unknown>;
  for (const key of CORE_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(candidate, key)) {
      throw new Error(`Role package cannot override core setting: ${key}`);
    }
  }
  if (!input.id?.trim() || input.id.length > 100) throw new Error('Role package id is required');
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) throw new Error('Role package version must be a semantic version');
  if (!input.prompt?.trim() || input.prompt.length > 50_000) throw new Error('Role package prompt is required and must be at most 50,000 characters');
  if (!Array.isArray(input.tools) || !Array.isArray(input.guardrails)) throw new Error('Role package tools and guardrails must be arrays');
  const names = new Set<string>();
  for (const roleTool of input.tools) {
    if (!roleTool.name?.trim()) throw new Error('Every role package tool requires a name');
    if (names.has(roleTool.name)) throw new Error(`Duplicate tool in role package: ${roleTool.name}`);
    names.add(roleTool.name);
  }
  if (input.guardrails.some((rule) => typeof rule !== 'string' || !rule.trim() || rule.length > 2_000)) {
    throw new Error('Role package guardrails must be non-empty strings of at most 2,000 characters');
  }
  const dataFields = new Set<string>();
  for (const requirement of input.dataRequirements ?? []) {
    if (!requirement.field?.trim() || dataFields.has(requirement.field)) {
      throw new Error(`Invalid or duplicate data requirement: ${requirement.field ?? ''}`);
    }
    dataFields.add(requirement.field);
  }

  const timeZone = normalizeTimeZone(input.timeZone);
  const preferredLanguage = input.preferredLanguage?.trim() || 'en';
  return {
    coreVersion: MASTER_VOICE_AGENT_CORE_VERSION,
    rolePackageId: input.id,
    rolePackageVersion: input.version,
    rolePrompt: input.prompt.trim(),
    systemPrompt: buildMasterVoiceAgentInstructions({
      rolePrompt: input.prompt,
      guardrails: input.guardrails,
      preferredLanguage,
      timeZone,
    }),
    greeting: input.greeting,
    voice: input.voice?.trim() || MASTER_VOICE_AGENT_DEFAULT_VOICE,
    model: MASTER_VOICE_AGENT_MODEL,
    preferredLanguage,
    timeZone,
    tools: input.tools,
    knowledge: input.knowledge,
    workflow: input.workflow,
    dataRequirements: input.dataRequirements ?? [],
    guardrails: input.guardrails,
    metadata: input.metadata,
  };
}
