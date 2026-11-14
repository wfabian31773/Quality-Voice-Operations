// Job status transitions extracted from server/admin-api/routes/dispatch.ts.
// The admin route is the only other consumer; keep the exported names and
// shapes identical so that file can import them with no other edits.

export const DISPATCH_JOB_STATUSES = [
  'pending',
  'assigned',
  'scheduled',
  'en_route',
  'on_site',
  'in_progress',
  'completed',
  'incomplete',
  'cancelled',
  'done',
] as const;

export type DispatchJobStatus = (typeof DISPATCH_JOB_STATUSES)[number];

export const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['scheduled', 'en_route', 'in_progress', 'cancelled', 'pending'],
  scheduled: ['en_route', 'in_progress', 'cancelled', 'assigned'],
  en_route: ['on_site', 'cancelled'],
  on_site: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'incomplete', 'cancelled', 'done'],
  completed: ['done'],
  incomplete: ['pending', 'assigned', 'cancelled'],
  done: [],
  cancelled: ['pending'],
};

// A job in one of these statuses is no longer "in the field", so the
// technician's mobile app should have stopped sending location pings and
// the live map should drop the marker.
export const TERMINAL_JOB_STATUSES = new Set([
  'completed',
  'cancelled',
  'done',
  'incomplete',
]);

export function isDispatchJobStatus(value: string): value is DispatchJobStatus {
  return (DISPATCH_JOB_STATUSES as readonly string[]).includes(value);
}

export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function isOpenJobStatus(status: string): boolean {
  return isDispatchJobStatus(status) && !TERMINAL_JOB_STATUSES.has(status);
}

export function canTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}
