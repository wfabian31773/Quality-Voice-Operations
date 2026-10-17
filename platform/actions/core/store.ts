import type { ActionContext, ActionResult, TenantTx } from './types';

export interface IdempotencyRecord {
  tenantId: string;
  action: string;
  key: string;
  requestHash: string;
  status: 'in_progress' | 'completed';
  response: ActionResult | null;
  expiresAt: Date;
}

export type BeginIdempotencyResult =
  | { kind: 'new' }
  | { kind: 'replay'; response: ActionResult }
  | { kind: 'reused' };

export interface ProposalRecord {
  id: string;
  tenantId: string;
  action: string;
  callId: string | null;
  payloadHash: string;
  payload: unknown;
  readback: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface CreateProposalInput {
  action: string;
  callId?: string;
  payload: unknown;
  payloadHash: string;
  readback: string;
  expiresAt: Date;
}

export interface ConsumeProposalInput {
  confirmationToken: string;
  action: string;
  callId?: string;
  payloadHash: string;
}

export interface AuditRecord {
  tenantId: string;
  action: string;
  actor: Record<string, unknown>;
  inputRedacted: unknown;
  resultCode: string;
  latencyMs: number;
  callId?: string;
}

export interface ActionStore {
  beginIdempotency(
    tx: TenantTx,
    input: {
      tenantId: string;
      action: string;
      key: string;
      requestHash: string;
      now: Date;
      expiresAt: Date;
    },
  ): Promise<BeginIdempotencyResult>;
  completeIdempotency(
    tx: TenantTx,
    input: { tenantId: string; action: string; key: string; response: ActionResult; now: Date },
  ): Promise<void>;
  createProposal(tx: TenantTx, ctx: ActionContext, input: CreateProposalInput): Promise<ProposalRecord>;
  consumeProposal(tx: TenantTx, ctx: ActionContext, input: ConsumeProposalInput): Promise<ProposalRecord | null>;
  inspectProposal(tx: TenantTx, ctx: ActionContext, id: string): Promise<ProposalRecord | null>;
  insertAudit(tx: TenantTx, record: AuditRecord): Promise<void>;
}
