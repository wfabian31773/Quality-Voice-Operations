import type { TenantId } from '../../core/types';

export interface TenantTwilioCredentials {
  tenantId: TenantId;
  accountSid: string;
  authToken: string;
  phoneNumbers: string[];
}

export interface PhoneNumberRoute {
  phoneNumber: string;
  tenantId: TenantId;
  agentId: string;
}
