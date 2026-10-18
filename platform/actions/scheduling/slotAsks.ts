// One ask per slot, then an exit (contract ceilings.maxAsksPerSlot). Misses
// are counted per (tenant, session, contract, slot) here, never from model
// arguments. The session is the one holds use (callId, else conversationId);
// with neither, nothing is counted and every refusal is a first ask. The
// action store has no read path for the audit log, so this is an in-process
// map with a TTL and a size cap: on more than one instance a call's second
// refusal can land on a fresh counter and ask once more before the exit. A
// retry of the same tool call (same idempotency key) counts once.

import { contractKey, type SlotSpec, type ToolContract } from '../../callcore/contracts';
import type { ActionContext } from '../core';
import { sessionOf } from './bookingRows';

/** What the agent says at the exit: a message ticket instead of another ask. */
export const SLOT_EXIT_MESSAGE = {
  en: 'I can take a message so someone can call you back.',
  es: 'Puedo tomar un mensaje para que alguien le devuelva la llamada.',
};

const SLOT_ASK_TTL_MS = 30 * 60_000;
const SLOT_ASK_MAX_ENTRIES = 5_000;
const slotAsks = new Map<string, { count: number; atMs: number; lastKey?: string }>();

type ContractRef = Pick<ToolContract, 'id' | 'version'>;

function slotAskKey(ctx: ActionContext, session: string, contract: ContractRef, slotName: string): string {
  return [ctx.tenantId, session, contractKey(contract), slotName].join('\0');
}

/**
 * Counts one miss of `slot` and returns the call's count so far (1 = the
 * first ask). ctx.idempotencyKey must be unique per model tool call (e.g. the
 * provider's tool-call id), never derived from the arguments; otherwise a
 * deliberate repeat would never reach the exit.
 */
export function countSlotAsk(ctx: ActionContext, contract: ContractRef, slot: Pick<SlotSpec, 'name'>): number {
  const session = sessionOf(ctx);
  if (!session) return 1;
  const key = slotAskKey(ctx, session, contract, slot.name);
  const nowMs = ctx.now.getTime();
  const invocationKey = ctx.idempotencyKey;
  const prev = slotAsks.get(key);
  const live = prev && nowMs - prev.atMs < SLOT_ASK_TTL_MS ? prev : undefined;
  const sameInvocation = live !== undefined && invocationKey !== undefined && live.lastKey === invocationKey;
  const count = !live ? 1 : sameInvocation ? live.count : live.count + 1;
  slotAsks.delete(key);
  // Oldest first (re-inserted on each touch): drop expired entries and keep under the cap.
  for (const [k, v] of slotAsks) {
    if (slotAsks.size < SLOT_ASK_MAX_ENTRIES && nowMs - v.atMs < SLOT_ASK_TTL_MS) break;
    slotAsks.delete(k);
  }
  slotAsks.set(key, { count, atMs: nowMs, lastKey: invocationKey });
  return count;
}

/** The call's live miss count for a slot, without counting one (0 = never missed). */
export function slotAskCount(ctx: ActionContext, contract: ContractRef, slotName: string): number {
  const session = sessionOf(ctx);
  if (!session) return 0;
  const entry = slotAsks.get(slotAskKey(ctx, session, contract, slotName));
  return entry && ctx.now.getTime() - entry.atMs < SLOT_ASK_TTL_MS ? entry.count : 0;
}

/** Forgets the call's counts for every slot of a contract. */
export function clearSlotAsks(ctx: ActionContext, contract: Pick<ToolContract, 'id' | 'version' | 'slots'>): void {
  const session = sessionOf(ctx);
  if (!session) return;
  for (const slot of contract.slots) slotAsks.delete(slotAskKey(ctx, session, contract, slot.name));
}
