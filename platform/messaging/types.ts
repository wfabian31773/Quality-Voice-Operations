import type { TenantId } from '../core/types';

export type MessageChannel = 'sms' | 'email' | 'push';

export interface PlatformMessage {
  tenantId: TenantId;
  to: string;
  channel: MessageChannel;
  subject?: string;
  body: string;
  metadata?: Record<string, unknown>;
}
