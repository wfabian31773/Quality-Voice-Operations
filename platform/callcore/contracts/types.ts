/**
 * Tool contract format (RT-01). A contract is pure data: the slots a flow
 * needs in ask order, its readback/commit pair, side effects, identity,
 * idempotency, what may be voiced and the fallback per error code.
 *
 * Division of labour: the model owns the conversation, the action named by
 * the contract owns its rule (a missing slot comes back as the next askId),
 * and nothing here does I/O. No vertical names belong in this folder.
 */

/** A ledger fact the server already holds; it satisfies a slot without an ask. */
export type HeldFact = 'callerPhone' | 'verifiedName';

export type HeldFacts = Partial<Record<HeldFact, string>>;

export interface SlotSpec {
  /** Slot name; also the `field` on a SLOT_MISSING refusal. */
  name: string;
  /** Dotted path into the prepare action's input, e.g. 'customer.name'. */
  inputPath: string;
  required: boolean;
  /** Stable id the template phrases; returned on SLOT_MISSING. */
  askId: string;
  /** Fallback phrasing when the template has none for this askId. */
  defaultAsk: { en: string; es: string };
  heldFrom?: HeldFact;
}

export type FailureStep =
  | { step: 'offer_alternatives' }
  | { step: 'ask_again'; slot: string }
  | { step: 'message_ticket' }
  | { step: 'scripted_close' };

/** Steps that end a chain: every refusal has an exit. */
export const TERMINAL_STEPS: ReadonlySet<FailureStep['step']> = new Set(['message_ticket', 'scripted_close']);

export interface ConfirmSpec {
  /** Action that validates, holds and returns the readback. */
  prepare: string;
  /** Action that commits the proposal after an explicit yes. */
  commit: string;
  explicitYes: true;
  maxReadbackCycles: number;
}

export interface ToolContract {
  id: string;
  version: number;
  /** Flow ids this contract serves. */
  intents: string[];
  /** Array order is ask order. */
  slots: SlotSpec[];
  confirm?: ConfirmSpec;
  sideEffect: 'read' | 'write';
  outbound: 'none' | 'sms' | 'call';
  outboundDestination?: 'callerPhone' | 'confirmedNumber' | 'configNumber';
  identity: 'none' | 'callerIdCandidate' | 'verified';
  idempotency: 'proposalToken' | { fixedKey: string };
  /** Commit output fields that may be voiced. */
  sayBack: string[];
  /** false = refs are texted, never spoken. */
  voiceRefs: boolean;
  /** Ordered fallback per error code; 'default' covers every other code. */
  onFailure: Record<string, FailureStep[]>;
  ceilings: { maxAsksPerSlot: 1 };
}

export function contractKey(contract: Pick<ToolContract, 'id' | 'version'>): string {
  return `${contract.id}@${contract.version}`;
}
