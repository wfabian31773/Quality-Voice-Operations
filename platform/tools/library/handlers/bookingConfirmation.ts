import { randomBytes } from 'crypto';

export interface BookingConfirmationChallenge {
  token: string;
  tenantId: string;
  callId: string;
  bookingId: string;
  action: string;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, BookingConfirmationChallenge>();

function callIdFrom(context: { tenantId: string; callLogId?: string; callSid?: string }): string {
  return `${context.tenantId}:${context.callLogId ?? context.callSid ?? 'unknown'}`;
}

function challengeKey(callId: string, bookingId: string, action: string): string {
  return `${callId}:${bookingId}:${action}`;
}

function pruneExpired(now = Date.now()): void {
  for (const [key, challenge] of pending) {
    if (challenge.expiresAt <= now) pending.delete(key);
  }
}

export function resetBookingConfirmations(): void {
  pending.clear();
}

export function issueBookingConfirmation(
  context: { tenantId: string; callLogId?: string; callSid?: string },
  bookingId: string,
  action: string,
): string {
  pruneExpired();
  const callId = callIdFrom(context);
  const token = randomBytes(16).toString('hex');
  pending.set(challengeKey(callId, bookingId, action), {
    token,
    tenantId: context.tenantId,
    callId,
    bookingId,
    action,
    expiresAt: Date.now() + TTL_MS,
  });
  return token;
}

export function consumeBookingConfirmation(
  context: { tenantId: string; callLogId?: string; callSid?: string },
  bookingId: string,
  action: string,
  token: string,
): boolean {
  pruneExpired();
  const presented = token.trim();
  if (!presented) return false;
  const key = challengeKey(callIdFrom(context), bookingId, action);
  const challenge = pending.get(key);
  if (!challenge || challenge.token !== presented) return false;
  pending.delete(key);
  return true;
}
