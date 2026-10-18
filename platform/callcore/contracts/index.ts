import { BOOKING_BOOK_V1 } from './bookingBook';
import { contractKey, type ToolContract } from './types';

export const CONTRACTS: readonly ToolContract[] = [BOOKING_BOOK_V1];

const byKey = new Map(CONTRACTS.map((c) => [contractKey(c), c]));

/** Looks up a contract by 'id@version', or by bare id (its highest version). */
export function getContract(id: string): ToolContract | undefined {
  const exact = byKey.get(id);
  if (exact) return exact;
  return CONTRACTS.filter((c) => c.id === id).sort((a, b) => b.version - a.version)[0];
}

export { BOOKING_BOOK_V1 } from './bookingBook';
export { isEmptySlotValue, nextMissingSlot, valueAtPath } from './enforce';
export {
  schemaHasPath,
  validateContract,
  validateContracts,
  type ContractActionInfo,
  type ContractActionRegistry,
  type ContractIssue,
  type ContractRule,
  type ContractValidation,
} from './validate';
export * from './types';
