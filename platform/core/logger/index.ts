export { StructuredLogger } from './StructuredLogger';
export type { LogContext } from './StructuredLogger';

import { StructuredLogger } from './StructuredLogger';
import type { LogContext } from './StructuredLogger';

/**
 * Create a component-scoped logger.
 * Pass a tenantId in baseContext to scope all entries to a specific tenant.
 */
export function createLogger(component: string, baseContext?: LogContext): StructuredLogger {
  return new StructuredLogger(component, baseContext);
}

export const callLogger = createLogger('CALL');
export const webhookLogger = createLogger('WEBHOOK');
export const ticketingLogger = createLogger('TICKETING');
export const resilienceLogger = createLogger('RESILIENCE');
export const tenantLogger = createLogger('TENANT');
export const billingLogger = createLogger('BILLING');
