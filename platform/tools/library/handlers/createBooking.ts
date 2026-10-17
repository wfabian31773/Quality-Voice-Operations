import { bookingOverlapKind } from '../../../actions/scheduling/holds';
import { createLogger } from '../../../core/logger';
import { getPlatformPool, withTenantContext } from '../../../db';
import { phoneDigits, resolveCallerPhone } from '../../../reasoning/sessionBinding';
import { isRetryableToolError } from '../../RetryOrchestrator';
import { transitionBooking } from '../../../scheduling/bookingLifecycle';
import {
  buildOverrideConflictResponse,
  getTenantTimezone,
  wallClockInTimezoneToUtc,
} from '../../../../server/admin-api/routes/scheduling';
import type { ToolContext, ToolDefinition } from '../../registry/types';
import { getToolLibraryEntry } from '../catalog';
import { consumeBookingConfirmation, issueBookingConfirmation } from './bookingConfirmation';

const HAS_EXPLICIT_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

export function parseBookingDateTime(raw: string, timeZone: string): Date | null {
  const value = raw.trim();
  if (!value) return null;
  if (HAS_EXPLICIT_OFFSET.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/,
  );
  if (!match) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return wallClockInTimezoneToUtc(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
    timeZone,
  );
}

const logger = createLogger('TOOL_CREATE_BOOKING');

export interface CreateBookingResult {
  success: boolean;
  message: string;
  bookingId?: string;
  retryable?: boolean;
  pending?: boolean;
  status?: 'needs_confirmation';
  confirmationToken?: string;
}

/** Stable key of what the caller confirms: service, start time, duration, phone. */
function newBookingDetailsKey(title: string, startTime: string, duration: number, contactPhone: string): string {
  return [
    title.toLowerCase().replace(/\s+/g, ' '),
    startTime,
    String(duration),
    phoneDigits(contactPhone).slice(-10),
  ].join('|');
}

export async function executeCreateBooking(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<CreateBookingResult> {
  const title = String(input.title ?? '').trim();
  const startTime = String(input.startTime ?? '').trim();
  const contactName = String(input.contactName ?? '').trim();
  const contactPhone = resolveCallerPhone(input.contactPhone, context.callerNumber);
  if (!title || !startTime || !contactName || !contactPhone) {
    return { success: false, retryable: false, message: 'title, startTime, contactName, and contactPhone are required.' };
  }

  const durationMinutes = Number(input.durationMinutes ?? 30);
  const duration = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 30;

  if (context.requireBookingConfirmation) {
    // The token is accepted only on a later caller turn and only for the
    // same details, so the caller answered after the readback.
    const requested = {
      bookingId: 'new',
      action: 'create',
      detailsKey: newBookingDetailsKey(title, startTime, duration, contactPhone),
    };
    const presentedToken = String(input.confirmationToken ?? '').trim();
    if (!consumeBookingConfirmation(context, requested, presentedToken)) {
      const confirmationToken = issueBookingConfirmation(context, requested);
      return {
        success: true,
        pending: true,
        status: 'needs_confirmation',
        confirmationToken,
        message: `Nothing is booked yet. Read back the service, day and time, name, and phone number to the caller and get an explicit yes. Then call create_booking again with the same details and confirmationToken ${confirmationToken}.`,
      };
    }
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let bookingId: string | undefined;
    let invalidStart = false;
    await withTenantContext(client, context.tenantId, async () => {
      const tenantTz = await getTenantTimezone(client, context.tenantId);
      const start = parseBookingDateTime(startTime, tenantTz);
      if (!start) {
        invalidStart = true;
        return;
      }
      const end = new Date(start.getTime() + duration * 60_000);
      // Each parameter is used once: reusing $1 for bookings.tenant_id
      // (varchar) and tenants.id (text) made Postgres reject every insert
      // with "inconsistent types deduced for parameter $1".
      const { rows } = await client.query(
        `INSERT INTO bookings (tenant_id, title, description, start_time, end_time, status,
            contact_name, contact_phone, contact_email, notes, booking_source, timezone)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, 'pending',
            $6, $7, $8, $9, 'ai_agent', $10)
         RETURNING id`,
        [
          context.tenantId,
          title,
          String(input.notes ?? ''),
          start.toISOString(),
          end.toISOString(),
          contactName,
          contactPhone,
          String(input.contactEmail ?? ''),
          String(input.notes ?? ''),
          tenantTz,
        ],
      );
      bookingId = rows[0]?.id as string;
    });
    if (invalidStart) {
      await client.query('ROLLBACK').catch(() => {});
      return { success: false, retryable: false, message: 'startTime must be a valid ISO-8601 timestamp.' };
    }
    await client.query('COMMIT');
    return {
      success: true,
      message: 'Booking stored as pending. Do not tell the caller the appointment is confirmed until staff or calendar sync confirms it.',
      bookingId,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('create_booking failed', { tenantId: context.tenantId, error: String(err) });
    return {
      success: false,
      retryable: isRetryableToolError(err),
      message: 'Failed to store the booking request. Offer to try again or escalate.',
    };
  } finally {
    client.release();
  }
}

export interface UpcomingBookingCandidate {
  bookingId: string;
  startTime: string;
  endTime: string;
  title: string;
  status: string;
}

function toCandidate(row: {
  id: string;
  start_time: Date | string;
  end_time: Date | string;
  status: string;
  title: string;
}): UpcomingBookingCandidate {
  return {
    bookingId: row.id,
    startTime: new Date(row.start_time).toISOString(),
    endTime: new Date(row.end_time).toISOString(),
    title: row.title,
    status: row.status,
  };
}

export interface UpdateBookingResult {
  success: boolean;
  message: string;
  bookingId?: string;
  action?: string;
  status?: 'needs_selection' | 'needs_confirmation' | 'updated' | 'conflict' | 'not_found';
  pending?: boolean;
  needsSelection?: boolean;
  needsConfirmation?: boolean;
  confirmationToken?: string;
  candidates?: UpcomingBookingCandidate[];
}

export function isPendingBookingChallenge(result: {
  pending?: boolean;
  status?: string;
}): boolean {
  return result.pending === true
    || result.status === 'needs_selection'
    || result.status === 'needs_confirmation'
    || result.status === 'conflict'
    || result.status === 'not_found';
}

function challengeResult(
  extras: Omit<UpdateBookingResult, 'success' | 'pending'>,
): UpdateBookingResult {
  return { success: true, pending: true, ...extras };
}

export async function executeUpdateBooking(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<UpdateBookingResult> {
  const action = String(input.action ?? '').trim().toLowerCase();
  if (action !== 'cancel' && action !== 'reschedule') {
    return { success: false, message: 'action must be cancel or reschedule.' };
  }

  const callerPhone = String(context.callerNumber ?? input.contactPhone ?? '').trim();
  const lookupDigits = phoneDigits(callerPhone);
  if (!lookupDigits) {
    return { success: false, message: 'Cannot find a booking without the session caller phone.' };
  }

  let newStart: Date | null = null;
  let newEnd: Date | null = null;
  if (action === 'reschedule') {
    const startTime = String(input.startTime ?? '').trim();
    if (!startTime) {
      return { success: false, message: 'Reschedule requires a valid startTime. Ask the caller for the new day and time first.' };
    }
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  let afterCommit: Array<() => void> = [];
  try {
    await client.query('BEGIN');
    const result = await withTenantContext(client, context.tenantId, async () => {
      const { rows: existing } = await client.query(
        `SELECT id, start_time, end_time, status, title
         FROM bookings
         WHERE tenant_id = $1
           AND status IN ('pending', 'confirmed')
           AND start_time >= NOW()
           AND RIGHT(regexp_replace(COALESCE(contact_phone, ''), '\\D', '', 'g'), 10) = $2
         ORDER BY start_time ASC`,
        [context.tenantId, lookupDigits.slice(-10)],
      );
      const candidates = (existing as Array<{
        id: string;
        start_time: Date | string;
        end_time: Date | string;
        status: string;
        title: string;
      }>).map(toCandidate);

      if (candidates.length === 0) {
        return challengeResult({
          action,
          status: 'not_found',
          message: 'No upcoming booking was found for this caller. Do not create a new booking. Offer to leave a message for the shop.',
        });
      }

      const requestedId = String(input.bookingId ?? '').trim();
      if (candidates.length > 1 && !requestedId) {
        return challengeResult({
          action,
          status: 'needs_selection',
          needsSelection: true,
          candidates,
          message: 'This caller has more than one upcoming booking. Read the date, time, and service for each and ask which one to change. Do not change anything yet.',
        });
      }

      const selected = requestedId
        ? candidates.find((row) => row.bookingId === requestedId)
        : candidates[0];
      if (!selected) {
        return challengeResult({
          action,
          status: 'needs_selection',
          needsSelection: true,
          candidates,
          message: 'That booking is not one of this caller\'s upcoming appointments. Ask which date, time, and service to change.',
        });
      }

      if (action === 'reschedule') {
        const tenantTz = await getTenantTimezone(client, context.tenantId);
        newStart = parseBookingDateTime(String(input.startTime ?? '').trim(), tenantTz);
        if (!newStart) {
          return { success: false, message: 'Reschedule requires a valid startTime. Ask the caller for the new day and time first.' };
        }
        const storedDurationMs = new Date(selected.endTime).getTime() - new Date(selected.startTime).getTime();
        const durationMs = storedDurationMs > 0 ? storedDurationMs : 30 * 60_000;
        newEnd = new Date(newStart.getTime() + durationMs);
      }

      const requestedChange = {
        bookingId: selected.bookingId,
        action,
        newStartTime: newStart?.toISOString() ?? null,
      };
      const presentedToken = String(input.confirmationToken ?? '').trim();
      const tokenAccepted = consumeBookingConfirmation(context, requestedChange, presentedToken);
      if (!tokenAccepted) {
        const confirmationToken = issueBookingConfirmation(context, requestedChange);
        return challengeResult({
          action,
          status: 'needs_confirmation',
          needsConfirmation: true,
          bookingId: selected.bookingId,
          confirmationToken,
          candidates: [selected],
          message: `Confirm with the caller before changing anything: ${selected.title} on ${selected.startTime}. Then call update_booking again with bookingId ${selected.bookingId}, confirmationToken ${confirmationToken}, and the same action.`,
        });
      }

      const transition = await transitionBooking(client, {
        tenantId: context.tenantId,
        bookingId: selected.bookingId,
        action,
        cancellationReason: String(input.notes ?? 'Caller cancelled on a voice call').trim(),
        newStartTime: newStart?.toISOString(),
        newEndTime: newEnd?.toISOString(),
        // changed_by / created_by reference users(id); the voice agent is
        // not a user, and an agent slug here broke every cancel/reschedule
        // with a foreign-key violation.
        changedBy: null,
      }, {
        deferSideEffects: true,
        checkBlackout: async ({ startTime, endTime, providerId }) => {
          const tenantTz = await getTenantTimezone(client, context.tenantId);
          return buildOverrideConflictResponse(client, context.tenantId, startTime, endTime, providerId, tenantTz);
        },
      });

      if (!transition.ok) {
        if (transition.httpStatus === 409) {
          return challengeResult({
            action,
            status: 'conflict',
            bookingId: selected.bookingId,
            message: transition.body.reason === 'stale_status'
              ? String(transition.body.error ?? 'That appointment was just changed by the shop. Do not claim it was cancelled or moved. Offer to check again or leave a message.')
              : 'That new time conflicts with another booking or a shop blackout. Offer a different time. Do not claim the appointment was moved.',
          });
        }
        if (transition.httpStatus === 404) {
          return challengeResult({
            action,
            status: 'not_found',
            bookingId: selected.bookingId,
            message: String(transition.body.error ?? 'No upcoming booking was found for this caller. Do not create a new booking. Offer to leave a message for the shop.'),
          });
        }
        return {
          success: false,
          action,
          bookingId: selected.bookingId,
          message: String(transition.body.error ?? 'Failed to update the existing booking.'),
        };
      }

      afterCommit = transition.afterCommit ?? [];
      return {
        success: true,
        action,
        status: 'updated',
        bookingId: String(transition.body.booking.id ?? selected.bookingId),
        message: action === 'cancel'
          ? 'Existing booking cancelled through the scheduling lifecycle. Do not claim a new appointment was booked.'
          : 'Existing booking rescheduled through the scheduling lifecycle. Do not create another booking.',
      } satisfies UpdateBookingResult;
    });
    await client.query('COMMIT');
    for (const effect of afterCommit) effect();
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // The reschedule's replacement row hit the 122 no-double-booking
    // constraints (23P01): same answer as an app-level conflict.
    if (bookingOverlapKind(err) !== null) {
      return challengeResult({
        action,
        status: 'conflict',
        message: 'That new time conflicts with another booking or a shop blackout. Offer a different time. Do not claim the appointment was moved.',
      });
    }
    logger.error('update_booking failed', { tenantId: context.tenantId, error: String(err) });
    return { success: false, message: 'Failed to update the existing booking. Offer to leave a message for the shop.' };
  } finally {
    client.release();
  }
}

const entry = getToolLibraryEntry('create_booking')!;

export const createBookingTool: ToolDefinition = {
  name: entry.name,
  description: entry.description,
  inputSchema: entry.parameters,
  handler: (input, context) => executeCreateBooking(input as Record<string, unknown>, context),
};

const updateEntry = getToolLibraryEntry('update_booking')!;

export const updateBookingTool: ToolDefinition = {
  name: updateEntry.name,
  description: updateEntry.description,
  inputSchema: updateEntry.parameters,
  handler: (input, context) => executeUpdateBooking(input as Record<string, unknown>, context),
};
