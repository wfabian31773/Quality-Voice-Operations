export interface NotificationRecord {
  id: string;
  receivedAt: number;
  title: string | null;
  body: string | null;
  event: string | null;
  jobId: string | null;
  bookingId: string | null;
  read: boolean;
}

export interface ExpoNotificationLike {
  request?: {
    identifier?: string | null;
    content?: {
      title?: string | null;
      body?: string | null;
      data?: Record<string, unknown> | null;
    } | null;
  } | null;
  date?: number | null;
}

export const NOTIFICATION_LOG_LIMIT = 50;

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function generateFallbackId(receivedAt: number): string {
  return `local-${receivedAt}-${Math.random().toString(36).slice(2, 8)}`;
}

export function notificationFromExpo(
  notification: ExpoNotificationLike | null | undefined,
  now: () => number = Date.now,
): NotificationRecord | null {
  if (!notification) return null;
  const request = notification.request ?? null;
  const content = request?.content ?? null;
  const data =
    content?.data && typeof content.data === 'object' ? content.data : null;
  const title = nonEmptyString(content?.title);
  const body = nonEmptyString(content?.body);
  // If there's nothing visible to render, the row would be useless.
  if (!title && !body) return null;
  const receivedAt = typeof notification.date === 'number' && Number.isFinite(notification.date)
    ? notification.date
    : now();
  const id = nonEmptyString(request?.identifier) ?? generateFallbackId(receivedAt);
  return {
    id,
    receivedAt,
    title,
    body,
    event: data ? nonEmptyString(data.event) : null,
    jobId: data ? nonEmptyString(data.jobId) : null,
    bookingId: data ? nonEmptyString(data.bookingId) : null,
    read: false,
  };
}

/**
 * Insert (or update) a record into the log, newest-first. If a record with
 * the same id already exists we keep its `read` flag and refresh the
 * remaining fields so re-deliveries don't lose user-visible state.
 */
export function upsertNotification(
  log: NotificationRecord[],
  next: NotificationRecord,
  limit: number = NOTIFICATION_LOG_LIMIT,
): NotificationRecord[] {
  const existingIdx = log.findIndex((r) => r.id === next.id);
  let merged: NotificationRecord;
  let remaining: NotificationRecord[];
  if (existingIdx === -1) {
    merged = next;
    remaining = log;
  } else {
    const existing = log[existingIdx]!;
    merged = { ...next, read: existing.read };
    remaining = log.filter((_, i) => i !== existingIdx);
  }
  const out = [merged, ...remaining];
  out.sort((a, b) => b.receivedAt - a.receivedAt);
  return out.slice(0, limit);
}

export function markAllRead(log: NotificationRecord[]): NotificationRecord[] {
  let changed = false;
  const out = log.map((r) => {
    if (r.read) return r;
    changed = true;
    return { ...r, read: true };
  });
  return changed ? out : log;
}

export function markRead(
  log: NotificationRecord[],
  id: string,
): NotificationRecord[] {
  let changed = false;
  const out = log.map((r) => {
    if (r.id !== id || r.read) return r;
    changed = true;
    return { ...r, read: true };
  });
  return changed ? out : log;
}

export function unreadCount(log: NotificationRecord[]): number {
  let count = 0;
  for (const r of log) if (!r.read) count++;
  return count;
}

export function notificationTargetPathFromRecord(
  record: Pick<NotificationRecord, 'jobId' | 'bookingId'>,
): string | null {
  if (record.jobId) return `/jobs/${record.jobId}`;
  if (record.bookingId) return `/bookings/${record.bookingId}`;
  return null;
}

export const DISPATCH_EVENT_LABELS: Record<string, string> = {
  job_assigned: 'Job assigned',
  job_status_en_route: 'En route',
  job_status_on_site: 'On site',
  job_cancelled: 'Job cancelled',
  booking_rescheduled: 'Appointment rescheduled',
  booking_cancelled: 'Appointment cancelled',
};

export function eventLabel(event: string | null | undefined): string | null {
  if (!event) return null;
  return DISPATCH_EVENT_LABELS[event] ?? event.replace(/_/g, ' ');
}

/**
 * The provider must wipe the local notification log whenever auth transitions
 * from signed-in to signed-out, so a subsequent sign-in (potentially as a
 * different tenant on the same device) cannot see the previous user's alerts.
 * Returns true only on a true→false transition; the initial render and a
 * sustained signed-out state both yield false.
 */
export function shouldResetOnAuthChange(
  previouslySignedIn: boolean,
  currentlySignedIn: boolean,
): boolean {
  return previouslySignedIn === true && currentlySignedIn === false;
}

export function serializeLog(log: NotificationRecord[]): string {
  return JSON.stringify(log);
}

export function deserializeLog(raw: string | null | undefined): NotificationRecord[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: NotificationRecord[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const i = item as Record<string, unknown>;
    const id = nonEmptyString(i.id);
    const receivedAt = typeof i.receivedAt === 'number' ? i.receivedAt : null;
    if (!id || receivedAt === null) continue;
    out.push({
      id,
      receivedAt,
      title: nonEmptyString(i.title),
      body: nonEmptyString(i.body),
      event: nonEmptyString(i.event),
      jobId: nonEmptyString(i.jobId),
      bookingId: nonEmptyString(i.bookingId),
      read: i.read === true,
    });
  }
  out.sort((a, b) => b.receivedAt - a.receivedAt);
  return out.slice(0, NOTIFICATION_LOG_LIMIT);
}
