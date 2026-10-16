import { randomBytes } from 'crypto';

export interface BookingConfirmationChange {
  bookingId: string;
  action: string;
  newStartTime?: string | null;
}

export interface BookingConfirmationContext {
  tenantId: string;
  callLogId?: string;
  callSid?: string;
  transcriptTurnIndex?: number;
}

export interface BookingConfirmationChallenge {
  token: string;
  tenantId: string;
  callId: string;
  bookingId: string;
  action: string;
  newStartTime: string | null;
  issuedAtTurn: number;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, BookingConfirmationChallenge>();

function callIdFrom(context: BookingConfirmationContext): string {
  return `${context.tenantId}:${context.callLogId ?? context.callSid ?? 'unknown'}`;
}

function challengeKey(callId: string, bookingId: string, action: string): string {
  return `${callId}:${bookingId}:${action}`;
}

function normalizeStartTime(value?: string | null): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
}

function currentTurn(context: BookingConfirmationContext): number {
  return typeof context.transcriptTurnIndex === 'number' && Number.isFinite(context.transcriptTurnIndex)
    ? context.transcriptTurnIndex
    : 0;
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
  context: BookingConfirmationContext,
  change: BookingConfirmationChange,
): string {
  pruneExpired();
  const callId = callIdFrom(context);
  const token = randomBytes(16).toString('hex');
  pending.set(challengeKey(callId, change.bookingId, change.action), {
    token,
    tenantId: context.tenantId,
    callId,
    bookingId: change.bookingId,
    action: change.action,
    newStartTime: normalizeStartTime(change.newStartTime),
    issuedAtTurn: currentTurn(context),
    expiresAt: Date.now() + TTL_MS,
  });
  return token;
}

export function consumeBookingConfirmation(
  context: BookingConfirmationContext,
  change: BookingConfirmationChange,
  token: string,
): boolean {
  pruneExpired();
  const presented = token.trim();
  if (!presented) return false;
  const key = challengeKey(callIdFrom(context), change.bookingId, change.action);
  const challenge = pending.get(key);
  if (!challenge || challenge.token !== presented) return false;
  if (currentTurn(context) <= challenge.issuedAtTurn) return false;
  if (challenge.bookingId !== change.bookingId || challenge.action !== change.action) return false;
  if (challenge.newStartTime !== normalizeStartTime(change.newStartTime)) return false;
  pending.delete(key);
  return true;
}
