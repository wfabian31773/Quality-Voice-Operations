import type { TenantId } from '../../core/types';

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'dead_letter';

export interface OutboxEntry {
  id: string;
  tenantId: TenantId;
  idempotencyKey?: string;
  callSid?: string;
  callLogId?: string;
  payload: unknown;
  status: OutboxStatus;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date | null;
  lastError?: string;
  ticketNumber?: string;
  externalTicketId?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutboxWriteResult {
  outboxId: string;
  idempotencyKey?: string;
  alreadyExists: boolean;
}

export interface OutboxSendResult {
  success: boolean;
  ticketNumber?: string;
  externalId?: string;
  error?: string;
  outboxId: string;
}

export interface OutboxStats {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  deadLetter: number;
}

export interface OutboxWriteParams {
  tenantId: TenantId;
  payload: unknown;
  callSid?: string;
  callLogId?: string;
  /** If provided, duplicate writes with the same key are silently ignored. */
  idempotencyKey?: string;
}
