import {
  buildAfterHoursSystemPrompt,
  getAfterHoursGreeting,
  MEDICAL_SAFETY_GUARDRAILS,
} from '../../../platform/agent-templates/medical-after-hours';
import {
  buildDentalSystemPrompt,
  getDentalGreeting,
  DENTAL_SAFETY_GUARDRAILS,
  DENTAL_TOOLS,
} from '../../../platform/agent-templates/dental';
import {
  buildPropertyManagementSystemPrompt,
  getPropertyManagementGreeting,
  PROPERTY_MANAGEMENT_GUARDRAILS,
  PROPERTY_MANAGEMENT_TOOLS,
} from '../../../platform/agent-templates/property-management';
import {
  buildHomeServicesSystemPrompt,
  getHomeServicesGreeting,
  HOME_SERVICES_GUARDRAILS,
  HOME_SERVICES_TOOLS,
} from '../../../platform/agent-templates/home-services';
import {
  buildLegalSystemPrompt,
  getLegalGreeting,
  LEGAL_SAFETY_GUARDRAILS,
  LEGAL_TOOLS,
} from '../../../platform/agent-templates/legal';
import {
  buildCustomerSupportSystemPrompt,
  getCustomerSupportGreeting,
  CUSTOMER_SUPPORT_GUARDRAILS,
  CUSTOMER_SUPPORT_TOOLS,
} from '../../../platform/agent-templates/customer-support';
import {
  buildOutboundSalesSystemPrompt,
  getOutboundSalesGreeting,
  OUTBOUND_SALES_GUARDRAILS,
  OUTBOUND_SALES_TOOLS,
} from '../../../platform/agent-templates/outbound-sales';
import {
  buildTechnicalSupportSystemPrompt,
  getTechnicalSupportGreeting,
  TECHNICAL_SUPPORT_GUARDRAILS,
  TECHNICAL_SUPPORT_TOOLS,
} from '../../../platform/agent-templates/technical-support';
import {
  buildCollectionsSystemPrompt,
  getCollectionsGreeting,
  COLLECTIONS_GUARDRAILS,
  COLLECTIONS_TOOLS,
} from '../../../platform/agent-templates/collections';
import { createLogger } from '../../../platform/core/logger';
import type { TenantId } from '../../../platform/core/types';
import { filterToolsByPermissions, type ToolOverride } from '../../../platform/agent-templates/toolPermissions';
import {
  getAgentLanguageLabel,
  normalizeAgentLanguage,
} from '../../../platform/agent-templates/agentLanguages';
import { buildLocalizedGreeting } from '../../../platform/agent-templates/greetingTranslations';
import {
  createHealthcareReceptionistRolePackage,
  normalizeHealthcareOperationalFacts,
  validateHealthcarePracticeName,
} from '../../../platform/agent-templates/healthcare-receptionist';
import {
  MASTER_VOICE_AGENT_DEFAULT_VOICE,
  MASTER_VOICE_AGENT_MODEL,
  MASTER_VOICE_CONVERSATION_POLICY,
  compileRolePackage,
  normalizeTimeZone,
} from '../../../platform/agent-runtime/masterVoiceAgent';
import { stripStageDirections, type StageDirectionRule } from '../../../platform/agent-runtime/promptLint';
import { createCoreReceptionistRolePackage } from '../../../platform/agent-templates/core-receptionist';
import { buildCallerIdPromptLine, createSalonRolePackage } from '../../../platform/agent-templates/salon';
import { isTemplateOrDefaultSystemPrompt } from '../../../client-app/src/lib/agentBuilderI18n';
import { compose, type ContractToolBinding } from '../../../platform/agent-runtime/composer';
import { BARBERSHOP_TEMPLATE_V1 } from '../../../platform/agent-templates/barbershop';
import type { AgentTemplate } from '../../../platform/agent-templates/shared';

const logger = createLogger('AGENT_LOADER');

/**
 * RT-09 flag: an agent runs on the generic composer only when its own
 * metadata says `runtime: 'composer'` (agents.metadata JSON; no env var, no
 * migration). Anything else, or no value, keeps the existing path.
 */
export const COMPOSER_RUNTIME_KEY = 'runtime';
export const COMPOSER_RUNTIME = 'composer';

/** Agent types with a composer template; only these can turn the flag on. */
const COMPOSER_TEMPLATES: Readonly<Record<string, AgentTemplate>> = {
  barbershop: BARBERSHOP_TEMPLATE_V1,
};

/** The contract tool binding cut to the tools the session exposes: a tool an override disabled is not bound. */
export function exposedContractTools(binding: ContractToolBinding, tools: ReadonlyArray<{ name: string }>): ContractToolBinding {
  const exposed = new Set(tools.map((tool) => tool.name));
  return { ...binding, actions: Object.fromEntries(Object.entries(binding.actions).filter(([tool]) => exposed.has(tool))) };
}

/** The composer template for this agent, or undefined when the flag is off or its type has none. */
export function composerTemplateFor(agentType: string, metadata: Record<string, unknown>): AgentTemplate | undefined {
  if (metadata[COMPOSER_RUNTIME_KEY] !== COMPOSER_RUNTIME) return undefined;
  return Object.prototype.hasOwnProperty.call(COMPOSER_TEMPLATES, agentType) ? COMPOSER_TEMPLATES[agentType] : undefined;
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

/**
 * The salon agent's DB prompt as shop-specific business details, or null
 * when it is empty or the stock copy the agent builder / onboarding saves
 * (base prompt + industry suffix, any locale). That generic copy has no
 * shop facts and would only contradict the package's tool rules.
 */
export function salonBusinessDetails(systemPrompt: string | null | undefined): string | null {
  const trimmed = systemPrompt?.trim();
  if (!trimmed || isTemplateOrDefaultSystemPrompt(trimmed)) return null;
  return trimmed;
}

export interface LoadedAgentConfig {
  agentId: string;
  tenantId: TenantId;
  coreVersion: string;
  rolePackageId: string;
  rolePackageVersion: string;
  rolePrompt: string;
  systemPrompt: string;
  greeting: string;
  voice: string;
  model: string;
  language: string;
  preferredLanguage: string;
  timeZone: string;
  tools: AgentToolDef[];
  guardrails: string[];
  metadata: Record<string, unknown>;
  /** Composer agents only: how the session's tool bridge runs the contract tools. */
  contractTools?: ContractToolBinding;
  /** Composer agents only: words the recognizer should expect (the business's name). */
  keyterms?: string[];
}

export interface AgentToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentLoadContext {
  tenantId: TenantId;
  agentId: string;
  agentType: string;
  callerPhone?: string;
  callerMemorySummary?: string;
  toolOverrides?: ToolOverride[];
  dbAgent?: {
    name: string;
    system_prompt?: string;
    voice?: string;
    model?: string;
    tools?: unknown;
    escalation_config?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    language?: string;
    tenant_timezone?: string;
  };
}

const LOOKUP_SCHEDULE_TOOL: AgentToolDef = {
  name: 'lookupSchedule',
  description:
    'Look up a patient\'s appointment schedule. Use this after collecting their identity to check for upcoming or recent appointments. Provide at least one of: phone, or firstName + lastName.',
  parameters: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'Patient phone number to search by' },
      firstName: { type: 'string', description: "Patient's first name" },
      lastName: { type: 'string', description: "Patient's last name" },
      dob: { type: 'string', description: 'Date of birth (MM/DD/YYYY)' },
    },
    required: [],
  },
};

const AFTER_HOURS_TOOLS: AgentToolDef[] = [
  {
    name: 'createAfterHoursTicket',
    description:
      'Create an after-hours triage ticket. Use this to document the caller\'s concern after determining urgency.',
    parameters: {
      type: 'object',
      properties: {
        patientFirstName: { type: 'string', description: "Patient's first name" },
        patientLastName: { type: 'string', description: "Patient's last name" },
        patientDob: { type: 'string', description: 'Date of birth' },
        callbackNumber: { type: 'string', description: 'Callback number' },
        symptomDescription: { type: 'string', description: 'Description of symptoms/concern' },
        triageOutcome: {
          type: 'string',
          enum: ['urgent_transfer', 'callback_next_business_day', 'self_care_advice', 'emergency_services'],
          description: 'Triage outcome category',
        },
        additionalNotes: { type: 'string', description: 'Additional notes' },
      },
      required: ['patientFirstName', 'patientLastName', 'patientDob', 'callbackNumber', 'symptomDescription', 'triageOutcome'],
    },
  },
  {
    name: 'triageEscalate',
    description:
      'Transfer the caller to the on-call team for urgent medical concerns. Only use this when the situation requires immediate human attention.',
    parameters: {
      type: 'object',
      properties: {
        patientFirstName: { type: 'string', description: "Patient's first name" },
        patientLastName: { type: 'string', description: "Patient's last name" },
        patientDob: { type: 'string', description: 'Date of birth' },
        callbackNumber: { type: 'string', description: 'Callback number' },
        urgentConcern: { type: 'string', description: 'Description of the urgent concern' },
      },
      required: ['patientFirstName', 'patientLastName', 'patientDob', 'callbackNumber', 'urgentConcern'],
    },
  },
];

const PLATFORM_TOOLS: AgentToolDef[] = [
  {
    name: 'get_current_tenant_time',
    description: 'Return the current date, weekday, local time, IANA timezone, and UTC offset for the tenant. Use when relative dates matter or a long call may have crossed a boundary.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'record_language_change',
    description: 'Record a model-detected change in the caller\'s primary spoken language for transcript quality review. Call only when the language changes; do not announce this action.',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'zh', 'ja', 'ko', 'ar', 'hi'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['language', 'confidence'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Create an escalation task for a human operator to follow up with the caller. Use this when the caller explicitly requests to speak with a person, when you cannot resolve their issue, or when the situation requires human judgment. Provide a clear reason and priority level.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why this call needs human follow-up' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Urgency level of the escalation' },
        caller_phone: { type: 'string', description: 'Callback phone number for the caller' },
        transfer_number: { type: 'string', description: 'Optional: number to transfer the call to immediately' },
      },
      required: ['reason'],
    },
  },
];

function mergeTools(templateTools: AgentToolDef[], dbTools: AgentToolDef[]): AgentToolDef[] {
  const allTools = [...templateTools];
  const names = new Set(allTools.map((t) => t.name));
  for (const t of dbTools) {
    if (!names.has(t.name)) { allTools.push(t); names.add(t.name); }
  }
  for (const t of PLATFORM_TOOLS) {
    if (!names.has(t.name)) { allTools.push(t); names.add(t.name); }
  }
  return allTools;
}

function resolveTemplateKey(agentType: string, agentId: string): string {
  const typeMap: Record<string, string> = {
    'core-receptionist': 'core-receptionist',
    'core_receptionist': 'core-receptionist',
    'general': 'core-receptionist',
    'answering_service': 'healthcare-receptionist',
    'answering-service': 'healthcare-receptionist',
    'healthcare_receptionist': 'healthcare-receptionist',
    'healthcare-receptionist': 'healthcare-receptionist',
    'medical_after_hours': 'medical-after-hours',
    'medical-after-hours': 'medical-after-hours',
    'dental': 'dental',
    'property_management': 'property-management',
    'property-management': 'property-management',
    'home_services': 'home-services',
    'home-services': 'home-services',
    'legal': 'legal',
    'customer_support': 'customer-support',
    'customer-support': 'customer-support',
    'outbound_sales': 'outbound-sales',
    'outbound-sales': 'outbound-sales',
    'technical_support': 'technical-support',
    'technical-support': 'technical-support',
    'collections': 'collections',
    'salon': 'salon',
    'barbershop': 'salon',
  };

  const fromType = typeMap[agentType];
  if (fromType) return fromType;

  const fromId = typeMap[agentId];
  if (fromId) return fromId;

  return agentType || agentId;
}

type LoadedAgentConfigWithoutLanguage = Pick<
  LoadedAgentConfig,
  'agentId' | 'tenantId' | 'systemPrompt' | 'greeting' | 'voice' | 'model' | 'tools' | 'guardrails' | 'metadata'
>;

/** What the agent says and does when the tenant has set nothing. */
interface BuiltInDefaults {
  greeting?: () => string;
  systemPrompt?: () => string;
}

const GENERIC_GREETING = 'Hello, how can I help you today?';
const GENERIC_ROLE_PROMPT = 'You are a helpful voice assistant. Be polite, clear, and concise.';

function buildTemplateConfig(
  templateKey: string,
  ctx: AgentLoadContext,
  meta: Record<string, unknown>,
  dbTools: AgentToolDef[],
  language: string,
): (LoadedAgentConfigWithoutLanguage & { builtIn: BuiltInDefaults }) | null {
  const { tenantId, agentId, callerPhone, callerMemorySummary, dbAgent, toolOverrides } = ctx;

  switch (templateKey) {
    case 'dental': {
      const practiceName = (meta.practiceName as string) ?? 'our dental practice';
      const builtInPrompt = () => buildDentalSystemPrompt({ practiceName, callerPhone, callerMemorySummary });
      const builtInGreeting = () => getDentalGreeting(practiceName, language);
      return {
        agentId,
        tenantId,
        systemPrompt: dbAgent?.system_prompt ? dbAgent.system_prompt : builtInPrompt(),
        greeting: (meta.greeting as string) ?? builtInGreeting(),
        voice: dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: dbAgent?.model ?? MASTER_VOICE_AGENT_MODEL,
        tools: filterToolsByPermissions(mergeTools(DENTAL_TOOLS, dbTools), templateKey, toolOverrides),
        guardrails: DENTAL_SAFETY_GUARDRAILS,
        metadata: { practiceName },
        builtIn: { systemPrompt: builtInPrompt, greeting: builtInGreeting },
      };
    }

    case 'property-management': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our property management office';
      const builtInPrompt = () => buildPropertyManagementSystemPrompt({ companyName, callerPhone, callerMemorySummary });
      const builtInGreeting = () => getPropertyManagementGreeting(companyName, language);
      return {
        agentId,
        tenantId,
        systemPrompt: dbAgent?.system_prompt ? dbAgent.system_prompt : builtInPrompt(),
        greeting: (meta.greeting as string) ?? builtInGreeting(),
        voice: dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: dbAgent?.model ?? MASTER_VOICE_AGENT_MODEL,
        tools: filterToolsByPermissions(mergeTools(PROPERTY_MANAGEMENT_TOOLS, dbTools), templateKey, toolOverrides),
        guardrails: PROPERTY_MANAGEMENT_GUARDRAILS,
        metadata: { companyName },
        builtIn: { systemPrompt: builtInPrompt, greeting: builtInGreeting },
      };
    }

    case 'home-services': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our home services company';
      const serviceTypes = (meta.serviceTypes as string[]) ?? undefined;
      const builtInPrompt = () => buildHomeServicesSystemPrompt({ companyName, serviceTypes, callerPhone, callerMemorySummary });
      const builtInGreeting = () => getHomeServicesGreeting(companyName, language);
      return {
        agentId,
        tenantId,
        systemPrompt: dbAgent?.system_prompt ? dbAgent.system_prompt : builtInPrompt(),
        greeting: (meta.greeting as string) ?? builtInGreeting(),
        voice: dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: dbAgent?.model ?? MASTER_VOICE_AGENT_MODEL,
        tools: filterToolsByPermissions(mergeTools(HOME_SERVICES_TOOLS, dbTools), templateKey, toolOverrides),
        guardrails: HOME_SERVICES_GUARDRAILS,
        metadata: { companyName, serviceTypes },
        builtIn: { systemPrompt: builtInPrompt, greeting: builtInGreeting },
      };
    }

    case 'legal': {
      const firmName = (meta.firmName as string) ?? (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our law firm';
      const practiceAreas = (meta.practiceAreas as string[]) ?? undefined;
      const builtInPrompt = () => buildLegalSystemPrompt({ firmName, practiceAreas, callerPhone, callerMemorySummary });
      const builtInGreeting = () => getLegalGreeting(firmName, language);
      return {
        agentId,
        tenantId,
        systemPrompt: dbAgent?.system_prompt ? dbAgent.system_prompt : builtInPrompt(),
        greeting: (meta.greeting as string) ?? builtInGreeting(),
        voice: dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: dbAgent?.model ?? MASTER_VOICE_AGENT_MODEL,
        tools: filterToolsByPermissions(mergeTools(LEGAL_TOOLS, dbTools), templateKey, toolOverrides),
        guardrails: LEGAL_SAFETY_GUARDRAILS,
        metadata: { firmName, practiceAreas },
        builtIn: { systemPrompt: builtInPrompt, greeting: builtInGreeting },
      };
    }

    case 'customer-support': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our company';
      const builtInPrompt = () => buildCustomerSupportSystemPrompt({ companyName, callerPhone, callerMemorySummary });
      const builtInGreeting = () => getCustomerSupportGreeting(companyName, language);
      return {
        agentId,
        tenantId,
        systemPrompt: dbAgent?.system_prompt ? dbAgent.system_prompt : builtInPrompt(),
        greeting: (meta.greeting as string) ?? builtInGreeting(),
        voice: dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: dbAgent?.model ?? MASTER_VOICE_AGENT_MODEL,
        tools: mergeTools(CUSTOMER_SUPPORT_TOOLS, dbTools),
        guardrails: CUSTOMER_SUPPORT_GUARDRAILS,
        metadata: { companyName },
        builtIn: { systemPrompt: builtInPrompt, greeting: builtInGreeting },
      };
    }

    case 'outbound-sales': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our company';
      const productOrService = (meta.productOrService as string) ?? undefined;
      const builtInPrompt = () => buildOutboundSalesSystemPrompt({ companyName, productOrService, callerPhone, callerMemorySummary });
      const builtInGreeting = () => getOutboundSalesGreeting(companyName, language);
      return {
        agentId,
        tenantId,
        systemPrompt: dbAgent?.system_prompt ? dbAgent.system_prompt : builtInPrompt(),
        greeting: (meta.greeting as string) ?? builtInGreeting(),
        voice: dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: dbAgent?.model ?? MASTER_VOICE_AGENT_MODEL,
        tools: mergeTools(OUTBOUND_SALES_TOOLS, dbTools),
        guardrails: OUTBOUND_SALES_GUARDRAILS,
        metadata: { companyName, productOrService },
        builtIn: { systemPrompt: builtInPrompt, greeting: builtInGreeting },
      };
    }

    case 'technical-support': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our company';
      const productName = (meta.productName as string) ?? undefined;
      const builtInPrompt = () => buildTechnicalSupportSystemPrompt({ companyName, productName, callerPhone, callerMemorySummary });
      const builtInGreeting = () => getTechnicalSupportGreeting(companyName, language);
      return {
        agentId,
        tenantId,
        systemPrompt: dbAgent?.system_prompt ? dbAgent.system_prompt : builtInPrompt(),
        greeting: (meta.greeting as string) ?? builtInGreeting(),
        voice: dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: dbAgent?.model ?? MASTER_VOICE_AGENT_MODEL,
        tools: mergeTools(TECHNICAL_SUPPORT_TOOLS, dbTools),
        guardrails: TECHNICAL_SUPPORT_GUARDRAILS,
        metadata: { companyName, productName },
        builtIn: { systemPrompt: builtInPrompt, greeting: builtInGreeting },
      };
    }

    case 'collections': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our collections office';
      const builtInPrompt = () => buildCollectionsSystemPrompt({ companyName, callerPhone, callerMemorySummary });
      const builtInGreeting = () => getCollectionsGreeting(companyName, language);
      return {
        agentId,
        tenantId,
        systemPrompt: dbAgent?.system_prompt ? dbAgent.system_prompt : builtInPrompt(),
        greeting: (meta.greeting as string) ?? builtInGreeting(),
        voice: dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: dbAgent?.model ?? MASTER_VOICE_AGENT_MODEL,
        tools: mergeTools(COLLECTIONS_TOOLS, dbTools),
        guardrails: COLLECTIONS_GUARDRAILS,
        metadata: { companyName },
        builtIn: { systemPrompt: builtInPrompt, greeting: builtInGreeting },
      };
    }

    default:
      return null;
  }
}

export function loadAgentConfig(ctx: AgentLoadContext): LoadedAgentConfig {
  const { tenantId, agentId, agentType, callerPhone, callerMemorySummary, dbAgent, toolOverrides } = ctx;

  const templateKey = resolveTemplateKey(agentType, agentId);
  const meta = (dbAgent?.metadata ?? {}) as Record<string, unknown>;
  const dbTools: AgentToolDef[] = Array.isArray(dbAgent?.tools) ? (dbAgent.tools as AgentToolDef[]) : [];
  const language = normalizeAgentLanguage(dbAgent?.language ?? (meta as Record<string, unknown>).language);
  const timeZone = normalizeTimeZone(dbAgent?.tenant_timezone ?? meta.timeZone);
  const extractRolePrompt = (systemPrompt: string): string => {
    const rolePromptMatch = systemPrompt.match(/^===== ROLE PACKAGE =====\n([\s\S]*?)(?:\n\n=====|$)/);
    return (rolePromptMatch?.[1]?.trim() || systemPrompt)
      .replace(MASTER_VOICE_CONVERSATION_POLICY, '')
      .trim();
  };
  // Tenant DB prompts and greetings can carry stage directions grok-voice
  // reads aloud ("(file the ticket quietly)", "*pauses*"). Repo prompts and
  // greetings are lint-clean, so they pass through unchanged. Warn only when
  // something was removed; hits that were kept (narration words, emphasis)
  // are debug noise. Log rule counts only: the matched text is
  // tenant-authored and may hold PHI. If the strip leaves nothing to say, fall
  // back to the built-in text (or a generic line) rather than fail the call.
  const stripTenantText = (
    subject: 'role prompt' | 'greeting',
    text: string,
    fallback: { builtIn?: () => string; generic: string },
  ): string => {
    const { text: stripped, hits, removed } = stripStageDirections(text);
    if (hits.length === 0) return stripped;
    const counts: Partial<Record<StageDirectionRule, number>> = {};
    for (const hit of hits) counts[hit.rule] = (counts[hit.rule] ?? 0) + 1;
    const payload = { tenantId, agentId, counts, removed };
    if (removed === 0) {
      logger.debug(`Possible stage directions in agent ${subject}; nothing removed`, payload);
      return stripped;
    }
    if (/[\p{L}\p{N}]/u.test(stripped)) {
      logger.warn(`Stage directions removed from agent ${subject}`, payload);
      return stripped;
    }
    const builtInText = fallback.builtIn?.();
    logger.warn(`Stage directions removed from agent ${subject}`, {
      ...payload,
      fallback: builtInText ? 'built-in' : 'generic',
    });
    return builtInText || fallback.generic;
  };
  const finalize = (
    cfg: LoadedAgentConfigWithoutLanguage,
    lockedRoleIdentity?: { id: string; version: string },
    builtIn: BuiltInDefaults = {},
  ): LoadedAgentConfig => {
    const rolePrompt = stripTenantText('role prompt', extractRolePrompt(cfg.systemPrompt), {
      builtIn: builtIn.systemPrompt && (() => extractRolePrompt(builtIn.systemPrompt!())),
      generic: GENERIC_ROLE_PROMPT,
    });
    const greeting = typeof cfg.greeting === 'string'
      ? stripTenantText('greeting', cfg.greeting, { builtIn: builtIn.greeting, generic: GENERIC_GREETING })
      : cfg.greeting;
    const rolePackageVersion = lockedRoleIdentity?.version ?? (typeof meta.rolePackageVersion === 'string'
      ? meta.rolePackageVersion
      : '1.0.0');
    const compiled = compileRolePackage({
      id: (lockedRoleIdentity?.id ?? templateKey) || 'generic',
      version: rolePackageVersion,
      prompt: rolePrompt,
      greeting,
      voice: cfg.voice,
      preferredLanguage: getAgentLanguageLabel(language),
      timeZone,
      tools: mergeTools(cfg.tools, []),
      guardrails: cfg.guardrails,
      metadata: cfg.metadata,
    });
    return {
      ...cfg,
      greeting,
      coreVersion: compiled.coreVersion,
      rolePackageId: compiled.rolePackageId,
      rolePackageVersion: compiled.rolePackageVersion,
      rolePrompt: compiled.rolePrompt,
      systemPrompt: compiled.systemPrompt,
      voice: compiled.voice,
      model: compiled.model,
      language,
      preferredLanguage: compiled.preferredLanguage,
      timeZone: compiled.timeZone,
      tools: compiled.tools,
    };
  };

  const composerTemplate = composerTemplateFor(agentType, meta);
  if (composerTemplate) {
    // The same tenant facts the salon path uses: the business name and the
    // shop's own saved prompt as business details. Caller ID goes last.
    const businessName = firstText(meta.businessName, meta.practiceName, meta.companyName);
    const composed = compose(
      composerTemplate,
      undefined,
      { businessName, businessDetails: salonBusinessDetails(dbAgent?.system_prompt) },
      { language, callerIdLine: buildCallerIdPromptLine(callerPhone) },
    );
    const greeting = typeof meta.greeting === 'string'
      ? stripTenantText('greeting', meta.greeting, { builtIn: () => composed.greeting, generic: composed.greeting })
      : composed.greeting;
    const metadata = { ...meta, businessName: businessName ?? null, role: composerTemplate.id, template: composed.templateKey };
    // toolOverrides, by the rule every other loader path uses, keyed on the
    // role package id the session checks isToolDenied with (stream.ts passes
    // rolePackageId as templateKey). The bridge binds only what is exposed.
    const tools = filterToolsByPermissions(composed.tools, composerTemplate.id, toolOverrides);
    const contractTools = exposedContractTools(composed.contractTools, tools);
    const compiled = compileRolePackage({
      id: composerTemplate.id,
      version: `${composerTemplate.version}.0.0`,
      prompt: composed.prompt,
      greeting,
      voice: dbAgent?.voice,
      preferredLanguage: getAgentLanguageLabel(language),
      timeZone,
      tools,
      guardrails: [],
      metadata,
    });
    logger.info('Loading composer agent', { tenantId, agentId, template: composed.templateKey });
    return {
      agentId,
      tenantId,
      coreVersion: compiled.coreVersion,
      rolePackageId: compiled.rolePackageId,
      rolePackageVersion: compiled.rolePackageVersion,
      rolePrompt: compiled.rolePrompt,
      systemPrompt: compiled.systemPrompt,
      greeting,
      voice: compiled.voice,
      model: compiled.model,
      language,
      preferredLanguage: compiled.preferredLanguage,
      timeZone: compiled.timeZone,
      tools: compiled.tools,
      guardrails: compiled.guardrails,
      metadata,
      contractTools,
      keyterms: composed.keyterms,
    };
  }

  switch (templateKey) {
    case 'core-receptionist': {
      const businessName = (meta.businessName as string) ?? (meta.practiceName as string) ?? (meta.companyName as string) ?? 'the business';
      const roleInput = { businessName, preferredLanguage: language, timeZone, voice: dbAgent?.voice };
      const role = createCoreReceptionistRolePackage({ ...roleInput, greeting: meta.greeting as string | undefined });
      return finalize({
        agentId,
        tenantId,
        systemPrompt: role.prompt,
        greeting: role.greeting,
        voice: role.voice ?? dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: MASTER_VOICE_AGENT_MODEL,
        tools: filterToolsByPermissions(mergeTools(role.tools, dbTools), templateKey, toolOverrides),
        guardrails: role.guardrails,
        metadata: { ...meta, businessName, role: 'core-receptionist' },
      }, { id: role.id, version: role.version }, {
        greeting: () => createCoreReceptionistRolePackage(roleInput).greeting,
      });
    }

    case 'salon': {
      const businessName = (meta.businessName as string) ?? (meta.practiceName as string) ?? (meta.companyName as string) ?? 'the salon';
      const roleInput = { businessName, preferredLanguage: language, timeZone, voice: dbAgent?.voice };
      const role = createSalonRolePackage({ ...roleInput, greeting: meta.greeting as string | undefined });
      // The package prompt is the base (identity, tool rules, message
      // consent). The tenant's own prompt (services, durations, hours) is
      // added as business details below it, unless it is the stock
      // template copy the agent builder saves. The caller-ID line goes last.
      const businessDetails = salonBusinessDetails(dbAgent?.system_prompt);
      const callerIdLine = buildCallerIdPromptLine(callerPhone);
      const systemPrompt = [
        role.prompt,
        businessDetails && `Business details from the shop:\n${businessDetails}\n\nIf these business details conflict with the tool rules or call rules above, the tool and call rules win.`,
        callerIdLine && `Caller ID:\n- ${callerIdLine}`,
      ].filter(Boolean).join('\n\n');
      return finalize({
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? role.greeting,
        voice: role.voice ?? dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: MASTER_VOICE_AGENT_MODEL,
        tools: filterToolsByPermissions(mergeTools(role.tools, dbTools), templateKey, toolOverrides),
        guardrails: role.guardrails,
        metadata: { ...meta, businessName, role: 'salon' },
      }, { id: role.id, version: role.version }, {
        greeting: () => createSalonRolePackage(roleInput).greeting,
      });
    }

    case 'healthcare-receptionist': {
      const rawPracticeName = meta.practiceName;
      let practiceName = 'our healthcare practice';
      if (rawPracticeName !== undefined) {
        try {
          practiceName = validateHealthcarePracticeName(rawPracticeName);
        } catch (error) {
          logger.warn('Ignoring invalid healthcare practice identity', {
            tenantId,
            agentId,
            error: error instanceof Error ? error.message : 'invalid practice identity',
          });
        }
      }
      let approvedOperationalFacts;
      try {
        approvedOperationalFacts = normalizeHealthcareOperationalFacts(meta.approvedOperationalFacts);
      } catch (error) {
        logger.warn('Ignoring invalid healthcare operational facts', {
          tenantId,
          agentId,
          error: error instanceof Error ? error.message : 'invalid operational facts',
        });
      }
      const role = createHealthcareReceptionistRolePackage({
        practiceName,
        callerPhone,
        preferredLanguage: language,
        timeZone,
        voice: dbAgent?.voice,
        approvedOperationalFacts,
      });
      return finalize({
        agentId,
        tenantId,
        systemPrompt: role.rolePrompt,
        greeting: role.greeting,
        voice: role.voice,
        model: role.model,
        tools: filterToolsByPermissions(role.tools, templateKey, toolOverrides),
        guardrails: role.guardrails,
        metadata: { ...meta, practiceName, role: 'healthcare-receptionist' },
      }, { id: role.rolePackageId, version: role.rolePackageVersion });
    }

    case 'medical-after-hours': {
      const practiceName = (meta.practiceName as string) ?? 'our practice';
      const isAzulVision = practiceName === 'Azul Vision' || practiceName === 'Azul Vision Eye Center';
      const onCallNumber = (meta.onCallTransferNumber as string)
        || (isAzulVision ? (process.env.AZUL_VISION_ONCALL_NUMBER ?? '') : '');
      const builtInPrompt = () => buildAfterHoursSystemPrompt({
        practiceName,
        callerPhone,
        callerMemorySummary,
        onCallTransferNumber: onCallNumber,
      });
      const builtInGreeting = () => getAfterHoursGreeting(practiceName, language);
      const systemPrompt = dbAgent?.system_prompt ? dbAgent.system_prompt : builtInPrompt();
      const baseTools = isAzulVision
        ? [...AFTER_HOURS_TOOLS, LOOKUP_SCHEDULE_TOOL]
        : AFTER_HOURS_TOOLS;
      const mergedTools = mergeTools(baseTools, dbTools);
      return finalize({
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? builtInGreeting(),
        voice: dbAgent?.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: dbAgent?.model ?? MASTER_VOICE_AGENT_MODEL,
        tools: filterToolsByPermissions(mergedTools, templateKey, toolOverrides),
        guardrails: MEDICAL_SAFETY_GUARDRAILS,
        metadata: { practiceName, onCallTransferNumber: onCallNumber },
      }, undefined, { systemPrompt: builtInPrompt, greeting: builtInGreeting });
    }

    default: {
      const vertical = buildTemplateConfig(templateKey, ctx, meta, dbTools, language);
      if (vertical) {
        const { builtIn, ...verticalConfig } = vertical;
        return finalize(verticalConfig, undefined, builtIn);
      }

      if (dbAgent?.system_prompt) {
        logger.info('Loading DB-configured agent (no matching template)', { tenantId, agentId, agentType });
        return finalize({
          agentId,
          tenantId,
          systemPrompt: dbAgent.system_prompt,
          greeting: (meta.greeting as string) ?? GENERIC_GREETING,
          voice: dbAgent.voice ?? MASTER_VOICE_AGENT_DEFAULT_VOICE,
          model: dbAgent.model ?? MASTER_VOICE_AGENT_MODEL,
          tools: filterToolsByPermissions(dbTools, templateKey, toolOverrides),
          guardrails: [],
          metadata: meta,
        });
      }
      logger.warn('Unknown agent template and no DB prompt, using generic config', { tenantId, agentId, agentType });
      return finalize({
        agentId,
        tenantId,
        systemPrompt: GENERIC_ROLE_PROMPT,
        greeting: GENERIC_GREETING,
        voice: MASTER_VOICE_AGENT_DEFAULT_VOICE,
        model: MASTER_VOICE_AGENT_MODEL,
        tools: [],
        guardrails: [],
        metadata: {},
      });
    }
  }
}
