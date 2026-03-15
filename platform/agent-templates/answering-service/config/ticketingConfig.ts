/**
 * Answering Service Ticketing Agent — Tenant-overridable configuration.
 *
 * The defaults here are extracted from the original answeringServiceTicketing.ts
 * and answeringServiceAgent.ts. Each field can be overridden via tenant config
 * at registration time.
 */

export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface AnsweringServiceDepartment {
  id: number;
  name: string;
}

export interface AnsweringServiceTicketingConfig {
  departments: AnsweringServiceDepartment[];
  defaultDepartmentId: number;
  defaultRequestTypeId: number;
  defaultRequestReasonId: number;
  defaultPriority: TicketPriority;
}

/** Default config — tenant may override all fields. */
export const DEFAULT_ANSWERING_SERVICE_CONFIG: AnsweringServiceTicketingConfig = {
  departments: [
    { id: 1, name: 'General' },
    { id: 2, name: 'Billing' },
    { id: 3, name: 'Scheduling' },
    { id: 4, name: 'Clinical' },
    { id: 5, name: 'Pharmacy' },
  ],
  defaultDepartmentId: 1,
  defaultRequestTypeId: 1,
  defaultRequestReasonId: 1,
  defaultPriority: 'medium',
};

export function detectPriority(reason: string): TicketPriority {
  const lower = reason.toLowerCase();
  if (lower.includes('urgent') || lower.includes('emergency') || lower.includes('severe')) {
    return 'urgent';
  }
  if (lower.includes('pain') || lower.includes('bleeding') || lower.includes('fever')) {
    return 'high';
  }
  return 'medium';
}

export function detectDepartmentId(
  reason: string,
  config: AnsweringServiceTicketingConfig,
): number {
  const lower = reason.toLowerCase();
  if (lower.includes('bill') || lower.includes('payment') || lower.includes('insurance')) {
    return config.departments.find((d) => d.name === 'Billing')?.id ?? config.defaultDepartmentId;
  }
  if (lower.includes('schedule') || lower.includes('appointment')) {
    return config.departments.find((d) => d.name === 'Scheduling')?.id ?? config.defaultDepartmentId;
  }
  if (lower.includes('prescription') || lower.includes('medication') || lower.includes('refill')) {
    return config.departments.find((d) => d.name === 'Pharmacy')?.id ?? config.defaultDepartmentId;
  }
  return config.defaultDepartmentId;
}
