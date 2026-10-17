import { actionFail } from './errors';
import { requestHash } from './hash';
import { getActionStore } from './runtime';
import type { ActionStore, ProposalRecord } from './store';
import { PROPOSAL_TTL_MS, type ActionContext, type ActionResult, type TenantTx } from './types';

export interface CreateProposalArgs {
  action: string;
  payload: unknown;
  readback: string;
  callId?: string;
  ttlMs?: number;
}

export interface ConsumeProposalArgs {
  confirmationToken: string;
  action: string;
  payload?: unknown;
  payloadHash?: string;
  callId?: string;
}

export async function createProposal(
  tx: TenantTx,
  ctx: ActionContext,
  args: CreateProposalArgs,
  store: ActionStore = getActionStore(),
): Promise<{ confirmationToken: string; readback: string; expiresAt: Date; payloadHash: string }> {
  const expiresAt = new Date(ctx.now.getTime() + (args.ttlMs ?? PROPOSAL_TTL_MS));
  const payloadHash = requestHash(args.payload);
  const record = await store.createProposal(tx, ctx, {
    action: args.action,
    callId: args.callId ?? ctx.callId,
    payload: args.payload,
    payloadHash,
    readback: args.readback,
    expiresAt,
  });
  return {
    confirmationToken: record.id,
    readback: record.readback,
    expiresAt: record.expiresAt,
    payloadHash: record.payloadHash,
  };
}

const CONFIRMATION_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isConfirmationToken(value: string): boolean {
  return CONFIRMATION_TOKEN.test(value);
}

export async function consumeProposal(
  tx: TenantTx,
  ctx: ActionContext,
  args: ConsumeProposalArgs,
  store: ActionStore = getActionStore(),
): Promise<ProposalRecord | ActionResult<never>> {
  if (!isConfirmationToken(args.confirmationToken)) {
    return actionFail('CONFIRMATION_INVALID', 'Unknown or expired confirmation token');
  }
  const payloadHash = args.payloadHash ?? requestHash(args.payload ?? {});
  const consumed = await store.consumeProposal(tx, ctx, {
    confirmationToken: args.confirmationToken,
    action: args.action,
    callId: args.callId ?? ctx.callId,
    payloadHash,
  });
  if (consumed) return consumed;

  const existing = await store.inspectProposal(tx, ctx, args.confirmationToken);
  const reason = classifyProposalRejection(existing, {
    now: ctx.now,
    action: args.action,
    callId: args.callId ?? ctx.callId,
    payloadHash,
  });
  return actionFail('CONFIRMATION_INVALID', reason);
}

export function classifyProposalRejection(
  row: ProposalRecord | null,
  expected: { now: Date; action: string; callId?: string; payloadHash: string },
): string {
  if (!row) return 'Unknown or expired confirmation token';
  if (row.consumedAt) return 'Confirmation token has already been used';
  if (row.expiresAt.getTime() <= expected.now.getTime()) return 'Confirmation token has expired';
  if (row.action !== expected.action) return 'Confirmation token belongs to a different action';
  if ((row.callId ?? undefined) !== (expected.callId ?? undefined)) {
    return 'Confirmation token belongs to a different call';
  }
  if (row.payloadHash !== expected.payloadHash) return 'Confirmation payload has changed';
  return 'Confirmation token is not valid';
}
