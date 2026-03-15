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
import { createLogger } from '../../../platform/core/logger';
import type { TenantId } from '../../../platform/core/types';

const logger = createLogger('AGENT_LOADER');

export interface LoadedAgentConfig {
  agentId: string;
  tenantId: TenantId;
  systemPrompt: string;
  greeting: string;
  voice: string;
  model: string;
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
  dbAgent?: {
    name: string;
    system_prompt?: string;
    voice?: string;
    model?: string;
    tools?: unknown;
    escalation_config?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
}

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

function mergeTools(templateTools: AgentToolDef[], dbTools: AgentToolDef[]): AgentToolDef[] {
  if (dbTools.length === 0) return templateTools;
  const templateNames = new Set(templateTools.map((t) => t.name));
  const extras = dbTools.filter((t) => !templateNames.has(t.name));
  return [...templateTools, ...extras];
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
  };

  const fromType = typeMap[agentType];
  if (fromType) return fromType;

  const fromId = typeMap[agentId];
  if (fromId) return fromId;

  return agentType || agentId;
}

function buildTemplateConfig(
  templateKey: string,
  ctx: AgentLoadContext,
  meta: Record<string, unknown>,
  dbTools: AgentToolDef[],
): LoadedAgentConfig | null {
  const { tenantId, callerPhone, callerMemorySummary, dbAgent } = ctx;

  switch (templateKey) {
    case 'dental': {
      const practiceName = (meta.practiceName as string) ?? 'our dental practice';
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildDentalSystemPrompt({ practiceName, callerPhone, callerMemorySummary });
      return {
        agentId: 'dental',
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getDentalGreeting(practiceName),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: mergeTools(DENTAL_TOOLS, dbTools),
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
        agentId: 'property-management',
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getPropertyManagementGreeting(companyName),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: mergeTools(PROPERTY_MANAGEMENT_TOOLS, dbTools),
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
        agentId: 'home-services',
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getHomeServicesGreeting(companyName),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: mergeTools(HOME_SERVICES_TOOLS, dbTools),
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
        agentId: 'legal',
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getLegalGreeting(firmName),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: mergeTools(LEGAL_TOOLS, dbTools),
        guardrails: LEGAL_SAFETY_GUARDRAILS,
        metadata: { firmName, practiceAreas },
      };
    }

    default:
      return null;
  }
}

export function loadAgentConfig(ctx: AgentLoadContext): LoadedAgentConfig {
  const { tenantId, agentId, agentType, callerPhone, callerMemorySummary, dbAgent } = ctx;

  const templateKey = resolveTemplateKey(agentType, agentId);
  const meta = (dbAgent?.metadata ?? {}) as Record<string, unknown>;
  const dbTools: AgentToolDef[] = Array.isArray(dbAgent?.tools) ? (dbAgent.tools as AgentToolDef[]) : [];

  switch (templateKey) {
    case 'answering-service': {
      const practiceName = (meta.practiceName as string) ?? 'our office';
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildAnsweringServiceSystemPrompt({
            practiceName,
            callerPhone,
            callerMemorySummary,
            config: DEFAULT_ANSWERING_SERVICE_CONFIG,
          });
      const mergedTools = mergeTools(ANSWERING_SERVICE_TOOLS, dbTools);
      return {
        agentId: 'answering-service',
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? `Thank you for calling ${practiceName}. How can I help you today?`,
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: mergedTools,
        guardrails: [],
        metadata: { practiceName },
      };
    }

    case 'medical-after-hours': {
      const practiceName = (meta.practiceName as string) ?? 'our practice';
      const onCallNumber = (meta.onCallTransferNumber as string) ?? '';
      const systemPrompt = dbAgent?.system_prompt
        ? dbAgent.system_prompt
        : buildAfterHoursSystemPrompt({
            practiceName,
            callerPhone,
            callerMemorySummary,
            onCallTransferNumber: onCallNumber,
          });
      const mergedTools = mergeTools(AFTER_HOURS_TOOLS, dbTools);
      return {
        agentId: 'medical-after-hours',
        tenantId,
        systemPrompt,
        greeting: (meta.greeting as string) ?? getAfterHoursGreeting(practiceName),
        voice: dbAgent?.voice ?? 'sage',
        model: dbAgent?.model ?? 'gpt-4o-realtime-preview',
        tools: mergedTools,
        guardrails: MEDICAL_SAFETY_GUARDRAILS,
        metadata: { practiceName, onCallTransferNumber: onCallNumber },
      };
    }

    default: {
      const verticalConfig = buildTemplateConfig(templateKey, ctx, meta, dbTools);
      if (verticalConfig) return verticalConfig;

      if (dbAgent?.system_prompt) {
        logger.info('Loading DB-configured agent (no matching template)', { tenantId, agentId, agentType });
        return {
          agentId,
          tenantId,
          systemPrompt: dbAgent.system_prompt,
          greeting: (meta.greeting as string) ?? 'Hello, how can I help you today?',
          voice: dbAgent.voice ?? 'sage',
          model: dbAgent.model ?? 'gpt-4o-realtime-preview',
          tools: dbTools,
          guardrails: [],
          metadata: meta,
        };
      }
      logger.warn('Unknown agent template and no DB prompt, using generic config', { tenantId, agentId, agentType });
      return {
        agentId,
        tenantId,
        systemPrompt: `You are a helpful voice assistant. Be polite, clear, and concise.`,
        greeting: 'Hello, how can I help you today?',
        voice: 'sage',
        model: 'gpt-4o-realtime-preview',
        tools: [],
        guardrails: [],
        metadata: {},
      };
    }
  }
}
