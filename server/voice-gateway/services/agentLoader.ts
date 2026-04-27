import {
  buildAnsweringServiceSystemPrompt,
  DEFAULT_ANSWERING_SERVICE_CONFIG,
} from '../../../platform/agent-templates/answering-service';
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
  DEFAULT_AGENT_LANGUAGE,
  getAgentLanguageLabel,
  normalizeAgentLanguage,
} from '../../../platform/agent-templates/agentLanguages';
import { buildLocalizedGreeting } from '../../../platform/agent-templates/greetingTranslations';

const logger = createLogger('AGENT_LOADER');

export interface LoadedAgentConfig {
  agentId: string;
  tenantId: TenantId;
  systemPrompt: string;
  greeting: string;
  voice: string;
  model: string;
  language: string;
  tools: AgentToolDef[];
  guardrails: string[];
  metadata: Record<string, unknown>;
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

const ANSWERING_SERVICE_TOOLS: AgentToolDef[] = [
  {
    name: 'createServiceTicket',
    description:
      'Create a service ticket after collecting the caller\'s information. Call this when you have the patient name, DOB, reason for call, and callback number.',
    parameters: {
      type: 'object',
      properties: {
        patientFirstName: { type: 'string', description: "Patient's first name" },
        patientLastName: { type: 'string', description: "Patient's last name" },
        patientPhone: { type: 'string', description: "Patient's phone number" },
        patientDob: { type: 'string', description: 'Date of birth (MM/DD/YYYY)' },
        reasonForCall: { type: 'string', description: 'Brief description of why they are calling' },
        callbackNumber: { type: 'string', description: 'Number to call back on (default: caller ID)' },
        additionalNotes: { type: 'string', description: 'Any additional information' },
      },
      required: ['patientFirstName', 'patientLastName', 'patientPhone', 'reasonForCall'],
    },
  },
];

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
    'answering_service': 'answering-service',
    'answering-service': 'answering-service',
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
  };

  const fromType = typeMap[agentType];
  if (fromType) return fromType;

  const fromId = typeMap[agentId];
  if (fromId) return fromId;

  return agentType || agentId;
}

type LoadedAgentConfigWithoutLanguage = Omit<LoadedAgentConfig, 'language'>;

function buildTemplateConfig(
  templateKey: string,
  ctx: AgentLoadContext,
  meta: Record<string, unknown>,
  dbTools: AgentToolDef[],
  language: string,
): LoadedAgentConfigWithoutLanguage | null {
  const { tenantId, agentId, callerPhone, callerMemorySummary, dbAgent, toolOverrides } = ctx;

  switch (templateKey) {
    case 'dental': {
      const practiceName = (meta.practiceName as string) ?? 'our dental practice';
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildDentalSystemPrompt({ practiceName, callerPhone, callerMemorySummary });
      return {
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getDentalGreeting(practiceName, language),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: filterToolsByPermissions(mergeTools(DENTAL_TOOLS, dbTools), templateKey, toolOverrides),
        guardrails: DENTAL_SAFETY_GUARDRAILS,
        metadata: { practiceName },
      };
    }

    case 'property-management': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our property management office';
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildPropertyManagementSystemPrompt({ companyName, callerPhone, callerMemorySummary });
      return {
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getPropertyManagementGreeting(companyName, language),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: filterToolsByPermissions(mergeTools(PROPERTY_MANAGEMENT_TOOLS, dbTools), templateKey, toolOverrides),
        guardrails: PROPERTY_MANAGEMENT_GUARDRAILS,
        metadata: { companyName },
      };
    }

    case 'home-services': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our home services company';
      const serviceTypes = (meta.serviceTypes as string[]) ?? undefined;
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildHomeServicesSystemPrompt({ companyName, serviceTypes, callerPhone, callerMemorySummary });
      return {
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getHomeServicesGreeting(companyName, language),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: filterToolsByPermissions(mergeTools(HOME_SERVICES_TOOLS, dbTools), templateKey, toolOverrides),
        guardrails: HOME_SERVICES_GUARDRAILS,
        metadata: { companyName, serviceTypes },
      };
    }

    case 'legal': {
      const firmName = (meta.firmName as string) ?? (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our law firm';
      const practiceAreas = (meta.practiceAreas as string[]) ?? undefined;
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildLegalSystemPrompt({ firmName, practiceAreas, callerPhone, callerMemorySummary });
      return {
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getLegalGreeting(firmName, language),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: filterToolsByPermissions(mergeTools(LEGAL_TOOLS, dbTools), templateKey, toolOverrides),
        guardrails: LEGAL_SAFETY_GUARDRAILS,
        metadata: { firmName, practiceAreas },
      };
    }

    case 'customer-support': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our company';
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildCustomerSupportSystemPrompt({ companyName, callerPhone, callerMemorySummary });
      return {
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getCustomerSupportGreeting(companyName, language),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: mergeTools(CUSTOMER_SUPPORT_TOOLS, dbTools),
        guardrails: CUSTOMER_SUPPORT_GUARDRAILS,
        metadata: { companyName },
      };
    }

    case 'outbound-sales': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our company';
      const productOrService = (meta.productOrService as string) ?? undefined;
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildOutboundSalesSystemPrompt({ companyName, productOrService, callerPhone, callerMemorySummary });
      return {
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getOutboundSalesGreeting(companyName, language),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: mergeTools(OUTBOUND_SALES_TOOLS, dbTools),
        guardrails: OUTBOUND_SALES_GUARDRAILS,
        metadata: { companyName, productOrService },
      };
    }

    case 'technical-support': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our company';
      const productName = (meta.productName as string) ?? undefined;
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildTechnicalSupportSystemPrompt({ companyName, productName, callerPhone, callerMemorySummary });
      return {
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getTechnicalSupportGreeting(companyName, language),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: mergeTools(TECHNICAL_SUPPORT_TOOLS, dbTools),
        guardrails: TECHNICAL_SUPPORT_GUARDRAILS,
        metadata: { companyName, productName },
      };
    }

    case 'collections': {
      const companyName = (meta.companyName as string) ?? (meta.practiceName as string) ?? 'our collections office';
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildCollectionsSystemPrompt({ companyName, callerPhone, callerMemorySummary });
      return {
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getCollectionsGreeting(companyName, language),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: mergeTools(COLLECTIONS_TOOLS, dbTools),
        guardrails: COLLECTIONS_GUARDRAILS,
        metadata: { companyName },
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
  const finalize = (cfg: LoadedAgentConfigWithoutLanguage): LoadedAgentConfig => {
    let prompt = cfg.systemPrompt;
    if (language && language !== DEFAULT_AGENT_LANGUAGE) {
      const label = getAgentLanguageLabel(language);
      const directive = `Respond to the caller in ${label}. All spoken responses must be in ${label}.`;
      if (!prompt.includes(directive)) {
        prompt = `${prompt}\n\n${directive}`.trim();
      }
    }
    return { ...cfg, systemPrompt: prompt, language };
  };

  switch (templateKey) {
    case 'answering-service': {
      const practiceName = (meta.practiceName as string) ?? 'our office';
      const isAzulVision = practiceName === 'Azul Vision' || practiceName === 'Azul Vision Eye Center';
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildAnsweringServiceSystemPrompt({
            practiceName,
            callerPhone,
            callerMemorySummary,
            config: DEFAULT_ANSWERING_SERVICE_CONFIG,
          });
      const baseTools = isAzulVision
        ? [...ANSWERING_SERVICE_TOOLS, LOOKUP_SCHEDULE_TOOL]
        : ANSWERING_SERVICE_TOOLS;
      const mergedTools = mergeTools(baseTools, dbTools);
      return finalize({
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? buildLocalizedGreeting(
          'answering-service',
          isAzulVision ? 'Azul Vision Eye Center' : practiceName,
          language,
        ),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: filterToolsByPermissions(mergedTools, templateKey, toolOverrides),
        guardrails: [],
        metadata: { practiceName },
      });
    }

    case 'medical-after-hours': {
      const practiceName = (meta.practiceName as string) ?? 'our practice';
      const isAzulVision = practiceName === 'Azul Vision' || practiceName === 'Azul Vision Eye Center';
      const onCallNumber = (meta.onCallTransferNumber as string)
        || (isAzulVision ? (process.env.AZUL_VISION_ONCALL_NUMBER ?? '') : '');
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildAfterHoursSystemPrompt({
            practiceName,
            callerPhone,
            callerMemorySummary,
            onCallTransferNumber: onCallNumber,
          });
      const baseTools = isAzulVision
        ? [...AFTER_HOURS_TOOLS, LOOKUP_SCHEDULE_TOOL]
        : AFTER_HOURS_TOOLS;
      const mergedTools = mergeTools(baseTools, dbTools);
      return finalize({
        agentId,
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getAfterHoursGreeting(practiceName, language),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: filterToolsByPermissions(mergedTools, templateKey, toolOverrides),
        guardrails: MEDICAL_SAFETY_GUARDRAILS,
        metadata: { practiceName, onCallTransferNumber: onCallNumber },
      });
    }

    default: {
      const verticalConfig = buildTemplateConfig(templateKey, ctx, meta, dbTools, language);
      if (verticalConfig) return finalize(verticalConfig);

      if (dbAgent?.system_prompt) {
        logger.info('Loading DB-configured agent (no matching template)', { tenantId, agentId, agentType });
        return finalize({
          agentId,
          tenantId,
          systemPrompt: dbAgent.system_prompt,
          greeting: (meta.greeting as string) ?? 'Hello, how can I help you today?',
          voice: dbAgent.voice ?? 'sage',
          model: dbAgent.model ?? 'gpt-4o-realtime-preview',
          tools: filterToolsByPermissions(dbTools, templateKey, toolOverrides),
          guardrails: [],
          metadata: meta,
        });
      }
      logger.warn('Unknown agent template and no DB prompt, using generic config', { tenantId, agentId, agentType });
      return finalize({
        agentId,
        tenantId,
        systemPrompt: `You are a helpful voice assistant. Be polite, clear, and concise.`,
        greeting: 'Hello, how can I help you today?',
        voice: 'sage',
        model: 'gpt-4o-realtime-preview',
        tools: [],
        guardrails: [],
        metadata: {},
      });
    }
  }
}
