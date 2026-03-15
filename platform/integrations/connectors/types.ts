import type { TenantId } from '../../core/types';

export type ConnectorType = 'ticketing' | 'sms' | 'crm' | 'scheduling' | 'ehr' | 'email' | 'webhook' | 'custom';

export interface ConnectorConfig {
  integrationId: string;
  tenantId: TenantId;
  connectorType: ConnectorType;
  provider: string;
  isEnabled: boolean;
  credentials: Record<string, string>;
}

export interface ConnectorPayload {
  type: string;
  [key: string]: unknown;
}

export interface ConnectorResult {
  success: boolean;
  externalId?: string;
  ticketNumber?: string;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface ConnectorAdapter {
  execute(tenantId: TenantId, config: ConnectorConfig, payload: ConnectorPayload): Promise<ConnectorResult>;
}

export interface CreateTicketPayload extends ConnectorPayload {
  type: 'create_ticket';
  patientFullName: string;
  patientDob: string;
  reasonForCalling: string;
  preferredContactMethod: 'phone' | 'sms' | 'email';
  patientPhone?: string;
  patientEmail?: string;
  lastProviderSeen?: string;
  locationOfLastVisit?: string;
  additionalDetails?: string;
  callSid?: string;
  callerPhone?: string;
  agentUsed?: string;
  callDurationSeconds?: number;
  idempotencyKey?: string;
}

export interface SendSmsPayload extends ConnectorPayload {
  type: 'send_sms' | 'escalation_notification';
  to?: string;
  body?: string;
  reason?: string;
  callSessionId?: string;
  timestamp?: string;
}
