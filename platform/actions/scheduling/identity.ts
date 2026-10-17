// Caller identity for the agent's find / reschedule / cancel (spec §0.2.6).
//
// - The trusted caller ID is never model input: it is the call_sessions row
//   for ctx.callId in this tenant. caller_number is encrypted at rest, so the
//   match uses its HMAC caller_lookup_hash (the voice gateway's caller-memory
//   lookup), with a plain-text caller_number accepted for legacy rows.
// - A booking find_bookings verified for the agent is recorded server-side as
//   an action_proposals row (action scheduling.find_bookings, this call_id,
//   payload.bookings: [{ id, idKey }]) through the exported createProposal.
//   idKey is a sha256 over the tenant, phone digits and normalized name the
//   booking had when it was matched (no raw PII in the payload). It is never
//   returned as a token and never consumed; reschedule/cancel prepare look it
//   up for the same tenant and call and recompute idKey from the booking's
//   current row, so a booking staff gave someone else's name or phone since
//   the find no longer counts. No migration: action_proposals (121) is
//   RLS-forced and already carries tenant_id, action, call_id and expires_at.

import { createHash } from 'node:crypto';
import { createProposal, type ActionContext, type TenantTx } from '../core';
import { createPiiLookupHashCandidates } from '../../security/PiiLookupHash';
import { loadBooking } from './bookingRows';
import { toE164 } from './readback';

export const FIND_BOOKINGS = 'scheduling.find_bookings';

/** How long a verification lasts in its call (a long phone call, with margin). */
export const VERIFICATION_TTL_MS = 60 * 60_000;

/** Plain-text phone (legacy rows); anything else (ciphertext) is never parsed for digits. */
const PLAIN_PHONE = /^\+?[0-9 ().-]{7,24}$/;

function nameTokens(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Whether a caller-given name matches the name on a booking, ignoring case,
 * accents and punctuation. If either side is a single name, the first names
 * must match ("Luis" ~ "Luis Garcia"); otherwise the full names must
 * ("Luis Garcia" ≠ "Luis Garcia Jr.").
 */
export function namesMatch(given: string, onBooking: string): boolean {
  const g = nameTokens(given);
  const b = nameTokens(onBooking);
  if (g.length === 0 || b.length === 0) return false;
  if (g.length === 1 || b.length === 1) return g[0] === b[0];
  return g.join(' ') === b.join(' ');
}

/**
 * Whether `phone` (E.164) is this call's caller ID. No callId, no call row,
 * a blocked/withheld number or an unreadable one all mean "no match".
 */
export async function callerIdMatches(tx: TenantTx, ctx: ActionContext, phone: string): Promise<boolean> {
  if (!ctx.callId) return false;
  const { rows } = await tx.query(
    `SELECT caller_number, caller_lookup_hash
       FROM call_sessions
      WHERE tenant_id = $1 AND (id = $2 OR call_sid = $2)
      ORDER BY created_at DESC
      LIMIT 1`,
    [ctx.tenantId, ctx.callId],
  );
  const row = rows[0];
  if (!row) return false;
  if (typeof row.caller_lookup_hash === 'string' && row.caller_lookup_hash.trim()) {
    const stored = row.caller_lookup_hash.trim();
    return createPiiLookupHashCandidates(ctx.tenantId, phone, 'caller_memory').some((c) => c.hash === stored);
  }
  const plain = typeof row.caller_number === 'string' ? row.caller_number.trim() : '';
  return PLAIN_PHONE.test(plain) && toE164(plain) === phone;
}

/**
 * The identity a booking was verified against: tenant, contact phone digits
 * (10 digits count as +1) and the normalized contact name. Hashed, so the
 * verification row carries no PII.
 */
export function bookingIdentityKey(tenantId: string, contactPhone: string, contactName: string): string {
  const digits = contactPhone.replace(/\D/g, '');
  const phoneDigits = digits.length === 10 ? `1${digits}` : digits;
  return createHash('sha256')
    .update(`qvo:booking_identity:v1\0${tenantId}\0${phoneDigits}\0${nameTokens(contactName).join(' ')}`, 'utf8')
    .digest('hex');
}

/** Records bookings find_bookings verified for this call (agent only; needs a callId). */
export async function recordVerified(
  tx: TenantTx,
  ctx: ActionContext,
  bookings: Array<{ id: string; contactPhone: string; contactName: string }>,
): Promise<void> {
  if (!ctx.callId || bookings.length === 0) return;
  await createProposal(tx, ctx, {
    action: FIND_BOOKINGS,
    payload: {
      bookings: bookings.map((b) => ({ id: b.id, idKey: bookingIdentityKey(ctx.tenantId, b.contactPhone, b.contactName) })),
    },
    readback: '',
    callId: ctx.callId,
    ttlMs: VERIFICATION_TTL_MS,
  });
}

/**
 * Whether find_bookings verified `bookingId` earlier in this call, in this
 * tenant, and the booking still carries the phone and name it was verified
 * against (staff may have changed them since).
 */
export async function verifiedInCall(tx: TenantTx, ctx: ActionContext, bookingId: string): Promise<boolean> {
  if (!ctx.callId) return false;
  const booking = await loadBooking(tx, ctx.tenantId, bookingId);
  if (!booking) return false;
  const idKey = bookingIdentityKey(ctx.tenantId, booking.contactPhone, booking.contactName);
  const { rows } = await tx.query(
    `SELECT 1
       FROM action_proposals
      WHERE tenant_id = $1
        AND action = $2
        AND call_id = $3
        AND expires_at > $4
        AND payload -> 'bookings' @> jsonb_build_array(jsonb_build_object('id', $5::text, 'idKey', $6::text))
      LIMIT 1`,
    [ctx.tenantId, FIND_BOOKINGS, ctx.callId, ctx.now.toISOString(), bookingId, idKey],
  );
  return rows.length > 0;
}
