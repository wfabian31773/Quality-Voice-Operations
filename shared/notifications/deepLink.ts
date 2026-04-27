export interface PushResponseLike {
  notification?: {
    request?: {
      identifier?: string | null;
      content?: {
        data?: Record<string, unknown> | null;
      } | null;
    } | null;
  } | null;
}

export function notificationTargetPath(
  data: Record<string, unknown> | null | undefined,
): string | null {
  if (!data || typeof data !== 'object') return null;
  const jobId = typeof data.jobId === 'string' ? data.jobId : null;
  if (jobId) return `/jobs/${jobId}`;
  const bookingId = typeof data.bookingId === 'string' ? data.bookingId : null;
  if (bookingId) return `/bookings/${bookingId}`;
  return null;
}

export interface ColdStartDeps {
  readLastHandledPushId: () => Promise<string | null>;
  writeLastHandledPushId: (id: string) => Promise<void>;
}

export interface ColdStartResult {
  skipped: 'no-response' | 'no-id' | 'duplicate' | null;
  path: string | null;
}

export async function processColdStartResponse(
  resp: PushResponseLike | null | undefined,
  deps: ColdStartDeps,
): Promise<ColdStartResult> {
  if (!resp) return { skipped: 'no-response', path: null };
  const id = resp.notification?.request?.identifier ?? null;
  if (!id) return { skipped: 'no-id', path: null };
  const lastSeen = await deps.readLastHandledPushId();
  if (lastSeen === id) return { skipped: 'duplicate', path: null };
  await deps.writeLastHandledPushId(id);
  const data = resp.notification?.request?.content?.data ?? undefined;
  return { skipped: null, path: notificationTargetPath(data) };
}
