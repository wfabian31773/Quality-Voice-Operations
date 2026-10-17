import type { TenantId } from '../../core/types';

export interface ToolDefinition {
  name: string;
  description: string;
  /** Zod schema or JSON schema for input validation. */
  inputSchema: unknown;
  handler: (input: unknown, context: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  tenantId: TenantId;
  callLogId?: string;
  callSid?: string;
  agentSlug?: string;
  callerNumber?: string;
  transcriptTurnIndex?: number;
  /**
   * create_booking must be read back and confirmed on a later caller turn
   * (confirmationToken) before it stores anything. Set for shadow-mode calls.
   */
  requireBookingConfirmation?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
}
