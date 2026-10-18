import { BOOKING_BOOK_V1 } from './bookingBook';
import { BOOKING_CANCEL_V1 } from './bookingCancel';
import { BOOKING_FIND_V1 } from './bookingFind';
import { BOOKING_RESCHEDULE_V1 } from './bookingReschedule';
import { TICKETS_MESSAGE_V1 } from './ticketsMessage';
import { contractKey, type ToolContract } from './types';

export const CONTRACTS: readonly ToolContract[] = [
  BOOKING_BOOK_V1,
  BOOKING_FIND_V1,
  BOOKING_RESCHEDULE_V1,
  BOOKING_CANCEL_V1,
  TICKETS_MESSAGE_V1,
];

const byKey = new Map(CONTRACTS.map((c) => [contractKey(c), c]));

/** Looks up a contract by 'id@version', or by bare id (its highest version). */
export function getContract(id: string): ToolContract | undefined {
  const exact = byKey.get(id);
  if (exact) return exact;
  return CONTRACTS.filter((c) => c.id === id).sort((a, b) => b.version - a.version)[0];
}

export { BOOKING_BOOK_V1 } from './bookingBook';
export { BOOKING_CANCEL_V1 } from './bookingCancel';
export { BOOKING_FIND_V1 } from './bookingFind';
export { BOOKING_RESCHEDULE_V1 } from './bookingReschedule';
export { TICKETS_MESSAGE_V1 } from './ticketsMessage';
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
