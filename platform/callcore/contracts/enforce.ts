import type { HeldFacts, SlotSpec, ToolContract } from './types';

/** Reads a dotted path ('customer.name') from a plain input object. */
export function valueAtPath(input: unknown, path: string): unknown {
  let cur: unknown = input;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Absent, null, a blank string and an empty array all count as not given. */
export function isEmptySlotValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * The first required slot, in ask order, that the input leaves empty and no
 * held fact satisfies; null when the contract's slots are all filled.
 */
export function nextMissingSlot(
  contract: Pick<ToolContract, 'slots'>,
  input: unknown,
  heldFacts: HeldFacts = {},
): SlotSpec | null {
  for (const slot of contract.slots) {
    if (!slot.required) continue;
    if (!isEmptySlotValue(valueAtPath(input, slot.inputPath))) continue;
    if (slot.heldFrom && !isEmptySlotValue(heldFacts[slot.heldFrom])) continue;
    return slot;
  }
  return null;
}
