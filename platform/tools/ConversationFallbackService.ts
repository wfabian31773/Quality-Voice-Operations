import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';

const logger = createLogger('CONVERSATION_FALLBACK');

export interface FallbackConfig {
  defaultMessage: string;
  toolMessages: Record<string, string>;
}

const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  defaultMessage: "I apologize for the inconvenience. I wasn't able to complete that action right now. I'll have someone from our team follow up with you within the hour to make sure this gets taken care of.",
  toolMessages: {
    createServiceTicket: "I wasn't able to create the service ticket at this moment, but I've noted all your information. A team member will follow up with you shortly to ensure your request is handled.",
    createAfterHoursTicket: "I'm unable to submit the after-hours ticket right now, but rest assured your concern has been noted. Our team will reach out to you during the next business day.",
    triageEscalate: "I'm having difficulty connecting you with our team right now. Your concern has been marked as urgent and someone will contact you as soon as possible.",
    scheduleDentalAppointment: "I wasn't able to book the appointment just now. A scheduling coordinator will call you back shortly to get that set up.",
    lookup_customer: "I'm having trouble accessing your account information at the moment. Let me continue helping you with what I can, and we'll verify the details afterward.",
    update_crm_record: "I wasn't able to update your records just now, but I've made note of the changes. Our team will ensure everything is updated promptly.",
    send_sms: "I wasn't able to send that text message right now. We'll make sure it gets sent to you shortly.",
  },
};

const tenantFallbackConfigs = new Map<string, Partial<FallbackConfig>>();

export function setTenantFallbackConfig(tenantId: TenantId, config: Partial<FallbackConfig>): void {
  tenantFallbackConfigs.set(tenantId, config);
}

export function getFallbackMessage(tenantId: TenantId, toolName: string): string {
  const tenantConfig = tenantFallbackConfigs.get(tenantId);
  const toolMsg = tenantConfig?.toolMessages?.[toolName] ?? DEFAULT_FALLBACK_CONFIG.toolMessages[toolName];
  if (toolMsg) return toolMsg;
  return tenantConfig?.defaultMessage ?? DEFAULT_FALLBACK_CONFIG.defaultMessage;
}

export interface FallbackResult {
  message: string;
  flaggedForFollowUp: boolean;
  callSessionId: string;
  toolName: string;
}

export function buildFallbackResponse(
  tenantId: TenantId,
  toolName: string,
  callSessionId: string,
  error: string,
): FallbackResult {
  const message = getFallbackMessage(tenantId, toolName);

  logger.info('Graceful fallback triggered', {
    tenantId,
    tool: toolName,
    callId: callSessionId,
    error,
  });

  return {
    message,
    flaggedForFollowUp: true,
    callSessionId,
    toolName,
  };
}
