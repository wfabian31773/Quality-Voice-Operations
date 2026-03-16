import { createLogger } from '../core/logger';
import { redactPHI } from '../core/phi/redact';
import type { ToolDefinition, ToolContext, ToolRegistry } from './registry/types';
import { globalToolRegistry } from './registry';
import { isToolDenied, getTemplatePermissions, getAllKnownTools, type ToolOverride } from '../agent-templates/toolPermissions';
import type { TenantId } from '../core/types';

const logger = createLogger('TOOL_REGISTRY');

export interface ToolRateLimit {
  maxPerMinute: number;
  maxPerHour: number;
}

export interface EnhancedToolDefinition extends ToolDefinition {
  category?: string;
  rateLimit?: ToolRateLimit;
  recoveryInstructions?: string;
  requiredPermission?: string;
}

export interface ToolValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ToolExecutionRequest {
  toolName: string;
  args: Record<string, unknown>;
  tenantId: TenantId;
  callSessionId?: string;
  callSid?: string;
  agentId?: string;
  agentSlug?: string;
  templateKey?: string;
  toolOverrides?: ToolOverride[];
}

const minuteCounters = new Map<string, { count: number; windowStart: number }>();
const hourCounters = new Map<string, { count: number; windowStart: number }>();

function validateJsonSchema(data: unknown, schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as Record<string, unknown>;
  const errors: string[] = [];

  if (s.type === 'object' && typeof data === 'object' && data !== null) {
    const required = (s.required as string[]) ?? [];
    const properties = (s.properties as Record<string, unknown>) ?? {};
    const obj = data as Record<string, unknown>;

    for (const field of required) {
      if (obj[field] === undefined || obj[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      const propSchema = properties[key] as Record<string, unknown> | undefined;
      if (!propSchema) continue;

      if (propSchema.type === 'string' && typeof value !== 'string' && value !== null && value !== undefined) {
        errors.push(`Field "${key}" must be a string`);
      }
      if (propSchema.type === 'number' && typeof value !== 'number' && value !== null && value !== undefined) {
        errors.push(`Field "${key}" must be a number`);
      }
      if (propSchema.type === 'boolean' && typeof value !== 'boolean' && value !== null && value !== undefined) {
        errors.push(`Field "${key}" must be a boolean`);
      }
      if (propSchema.type === 'array' && !Array.isArray(value) && value !== null && value !== undefined) {
        errors.push(`Field "${key}" must be an array`);
      }
      if (propSchema.enum && Array.isArray(propSchema.enum) && value !== null && value !== undefined) {
        if (!propSchema.enum.includes(value)) {
          errors.push(`Field "${key}" must be one of: ${(propSchema.enum as string[]).join(', ')}`);
        }
      }
    }
  } else if (s.type === 'object' && (data === null || data === undefined)) {
    const required = (s.required as string[]) ?? [];
    if (required.length > 0) {
      errors.push(`Missing required fields: ${required.join(', ')}`);
    }
  }

  return errors;
}

function checkRateLimit(tenantId: string, toolName: string, limit: ToolRateLimit): boolean {
  const key = `${tenantId}:${toolName}`;
  const now = Date.now();

  const minEntry = minuteCounters.get(key);
  if (!minEntry || now - minEntry.windowStart > 60_000) {
    minuteCounters.set(key, { count: 1, windowStart: now });
  } else {
    if (minEntry.count >= limit.maxPerMinute) {
      return false;
    }
    minEntry.count++;
  }

  const hrEntry = hourCounters.get(key);
  if (!hrEntry || now - hrEntry.windowStart > 3_600_000) {
    hourCounters.set(key, { count: 1, windowStart: now });
  } else {
    if (hrEntry.count >= limit.maxPerHour) {
      return false;
    }
    hrEntry.count++;
  }

  return true;
}

export function redactToolParameters(params: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      redacted[key] = redactPHI(value);
    } else if (Array.isArray(value)) {
      redacted[key] = value.map((v) => (typeof v === 'string' ? redactPHI(v) : v));
    } else if (value && typeof value === 'object') {
      redacted[key] = redactToolParameters(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

const TOOL_RECOVERY_INSTRUCTIONS: Record<string, string> = {
  createServiceTicket: 'If ticket creation fails, inform the caller that you were unable to create the ticket and ask them to call back or try again shortly.',
  createAfterHoursTicket: 'If the after-hours ticket cannot be created, assure the caller their concern has been noted and someone will follow up during business hours.',
  triageEscalate: 'If escalation fails, stay on the line with the caller and provide any immediate guidance available. Note the situation for manual follow-up.',
  lookup_customer: 'If customer lookup fails, proceed with the conversation without historical context. Ask the caller to provide relevant information directly.',
  update_crm_record: 'If CRM update fails, continue the call normally. The update can be retried later.',
  record_call_outcome: 'If outcome recording fails, the call data is still preserved. The outcome can be recorded manually later.',
  create_campaign_contact: 'If contact creation fails, note the details and inform the operator. The contact can be added manually.',
};

export class UnifiedToolRegistry {
  private enhancedTools = new Map<string, EnhancedToolDefinition>();

  registerEnhanced(tool: EnhancedToolDefinition): void {
    this.enhancedTools.set(tool.name, tool);
  }

  getEnhanced(name: string): EnhancedToolDefinition | undefined {
    return this.enhancedTools.get(name);
  }

  getAll(): EnhancedToolDefinition[] {
    const enhanced = Array.from(this.enhancedTools.values());
    const globalTools = globalToolRegistry.list();

    const allNames = new Set(enhanced.map((t) => t.name));
    for (const gt of globalTools) {
      if (!allNames.has(gt.name)) {
        enhanced.push({
          ...gt,
          category: 'core',
          recoveryInstructions: TOOL_RECOVERY_INSTRUCTIONS[gt.name],
        });
      }
    }

    return enhanced;
  }

  getToolWithPermissions(
    toolName: string,
    templateKey?: string,
    overrides?: ToolOverride[],
  ): { tool: EnhancedToolDefinition | ToolDefinition | undefined; denied: boolean } {
    if (templateKey && isToolDenied(toolName, templateKey, overrides)) {
      return { tool: undefined, denied: true };
    }

    const enhanced = this.enhancedTools.get(toolName);
    if (enhanced) return { tool: enhanced, denied: false };

    const globalTool = globalToolRegistry.get(toolName);
    if (globalTool) return { tool: globalTool, denied: false };

    return { tool: undefined, denied: false };
  }

  validateToolInput(toolName: string, args: Record<string, unknown>): ToolValidationResult {
    const tool = this.enhancedTools.get(toolName) ?? globalToolRegistry.get(toolName);
    if (!tool) {
      return { valid: true, errors: [] };
    }

    const schemaErrors = validateJsonSchema(args, tool.inputSchema);
    if (schemaErrors.length > 0) {
      return { valid: false, errors: schemaErrors };
    }

    return { valid: true, errors: [] };
  }

  checkRateLimit(tenantId: string, toolName: string): boolean {
    const enhanced = this.enhancedTools.get(toolName);
    const limit = enhanced?.rateLimit ?? { maxPerMinute: 30, maxPerHour: 300 };
    return checkRateLimit(tenantId, toolName, limit);
  }

  getRecoveryInstructions(toolName: string): string {
    const enhanced = this.enhancedTools.get(toolName);
    if (enhanced?.recoveryInstructions) return enhanced.recoveryInstructions;
    return TOOL_RECOVERY_INSTRUCTIONS[toolName] ?? 'Tool execution failed. Please try again or proceed without this action.';
  }

  getRegistrySnapshot(): Array<{
    name: string;
    description: string;
    category: string;
    inputSchema: unknown;
    rateLimit: ToolRateLimit;
    hasRecoveryInstructions: boolean;
  }> {
    const all = this.getAll();
    return all.map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category ?? 'general',
      inputSchema: t.inputSchema,
      rateLimit: t.rateLimit ?? { maxPerMinute: 30, maxPerHour: 300 },
      hasRecoveryInstructions: !!(t.recoveryInstructions ?? TOOL_RECOVERY_INSTRUCTIONS[t.name]),
    }));
  }
}

export const unifiedToolRegistry = new UnifiedToolRegistry();
