import type { ReadCachePolicy } from './types';

/**
 * Read actions templates list beside their contracts (catalog, availability),
 * as data: whether the call may answer a repeat from its own cache. A read
 * contract carries the same flag on itself (ToolContract.cacheable).
 */
export interface ReadActionSpec {
  action: string;
  cacheable?: ReadCachePolicy;
}

export const READ_ACTIONS: readonly ReadActionSpec[] = [
  // The catalog doesn't change while a call runs.
  { action: 'scheduling.list_services', cacheable: 'call' },
  { action: 'scheduling.list_staff', cacheable: 'call' },
  // Never cached: open times change during the call (other callers book them).
  { action: 'scheduling.check_availability' },
];

const byAction = new Map(READ_ACTIONS.map((spec) => [spec.action, spec]));

/** A listed read's cache policy, or undefined (read every time). */
export function readCachePolicy(action: string): ReadCachePolicy | undefined {
  return byAction.get(action)?.cacheable;
}
