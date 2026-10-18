import type { TicketsRepo } from './repo';
import type { TicketPriority, TicketUrgency } from './schemas';

export function priorityFor(urgency: TicketUrgency): TicketPriority {
  return urgency === 'urgent' ? 'urgent' : 'medium';
}

export function addMinutes(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * callback_due_at comes only from tenant config: settings first, then an active SLA policy. Never invented.
 * When a policy supplies it, the matching SLA instance uses the same clock, so response_due_at equals it.
 */
export async function resolveSla(repo: TicketsRepo, minutesFromSettings: number | null, priority: TicketPriority, now: Date) {
  if (minutesFromSettings) return { dueAt: addMinutes(now, minutesFromSettings), instance: null };
  const policy = await repo.slaPolicy(priority);
  if (!policy) return { dueAt: null, instance: null };
  const dueAt = addMinutes(now, policy.firstResponseMinutes);
  return {
    dueAt,
    instance: { policyId: policy.id, responseDueAt: dueAt, resolutionDueAt: addMinutes(now, policy.resolutionMinutes) },
  };
}
