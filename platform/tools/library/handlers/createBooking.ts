import { createLogger } from '../../../core/logger';
import { getPlatformPool, withTenantContext } from '../../../db';
import { phoneDigits } from '../../../reasoning/sessionBinding';
import { transitionBooking } from '../../../scheduling/bookingLifecycle';
import { buildOverrideConflictResponse, getTenantTimezone } from '../../../../server/admin-api/routes/scheduling';
import type { ToolContext, ToolDefinition } from '../../registry/types';
import { getToolLibraryEntry } from '../catalog';

const logger = createLogger('TOOL_CREATE_BOOKING');

export async function executeCreateBooking(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{ success: boolean; message: string; bookingId?: string }> {
  const title = String(input.title ?? '').trim();
  const startTime = String(input.startTime ?? '').trim();
  const contactName = String(input.contactName ?? '').trim();
  const contactPhone = String(input.contactPhone ?? context.callerNumber ?? '').trim();
  if (!title || !startTime || !contactName || !contactPhone) {
    return { success: false, message: 'title, startTime, contactName, and contactPhone are required.' };
  }

  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) {
    return { success: false, message: 'startTime must be a valid ISO-8601 timestamp.' };
  }
  const durationMinutes = Number(input.durationMinutes ?? 30);
  const duration = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 30;
  const end = new Date(start.getTime() + duration * 60_000);

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let bookingId: string | undefined;
    await withTenantContext(client, context.tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO bookings (tenant_id, title, description, start_time, end_time, status,
            contact_name, contact_phone, contact_email, notes, booking_source, timezone)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, 'pending',
            $6, $7, $8, $9, 'ai_agent', COALESCE((SELECT timezone FROM tenants WHERE id = $1), 'America/New_York'))
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
        ],
      );
      bookingId = rows[0]?.id as string;
    });
    await client.query('COMMIT');
    return {
      success: true,
      message: 'Booking stored as pending. Do not tell the caller the appointment is confirmed until staff or calendar sync confirms it.',
      bookingId,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('create_booking failed', { tenantId: context.tenantId, error: String(err) });
    return { success: false, message: 'Failed to store the booking request. Offer to try again or escalate.' };
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

function isConfirmed(value: unknown): boolean {
  return value === true || String(value ?? '').trim().toLowerCase() === 'true';
}

export async function executeUpdateBooking(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{
  success: boolean;
  message: string;
  bookingId?: string;
  action?: string;
  needsSelection?: boolean;
  needsConfirmation?: boolean;
  candidates?: UpcomingBookingCandidate[];
}> {
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
    newStart = startTime ? new Date(startTime) : null;
    if (!newStart || Number.isNaN(newStart.getTime())) {
      return { success: false, message: 'Reschedule requires a valid startTime. Ask the caller for the new day and time first.' };
    }
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    let candidates: UpcomingBookingCandidate[] = [];
    await withTenantContext(client, context.tenantId, async () => {
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
      candidates = (existing as Array<{
        id: string;
        start_time: Date | string;
        end_time: Date | string;
        status: string;
        title: string;
      }>).map(toCandidate);
    });

    if (candidates.length === 0) {
      return {
        success: false,
        message: 'No upcoming booking was found for this caller. Do not create a new booking. Offer to leave a message for the shop.',
        action,
      };
    }

    const requestedId = String(input.bookingId ?? '').trim();
    if (candidates.length > 1 && !requestedId) {
      return {
        success: false,
        action,
        needsSelection: true,
        candidates,
        message: 'This caller has more than one upcoming booking. Read the date, time, and service for each and ask which one to change. Do not change anything yet.',
      };
    }

    const selected = requestedId
      ? candidates.find((row) => row.bookingId === requestedId)
      : candidates[0];
    if (!selected) {
      return {
        success: false,
        action,
        needsSelection: true,
        candidates,
        message: 'That booking is not one of this caller\'s upcoming appointments. Ask which date, time, and service to change.',
      };
    }

    if (!isConfirmed(input.confirmed)) {
      return {
        success: false,
        action,
        needsConfirmation: true,
        bookingId: selected.bookingId,
        candidates: [selected],
        message: `Confirm with the caller before changing anything: ${selected.title} on ${selected.startTime}. Then call update_booking again with bookingId and confirmed=true.`,
      };
    }

    if (action === 'reschedule' && newStart) {
      const durationMs = Math.max(
        new Date(selected.endTime).getTime() - new Date(selected.startTime).getTime(),
        30 * 60_000,
      );
      newEnd = new Date(newStart.getTime() + durationMs);
    }

    const result = await transitionBooking(client, {
      tenantId: context.tenantId,
      bookingId: selected.bookingId,
      action,
      cancellationReason: String(input.notes ?? 'Caller cancelled on a voice call').trim(),
      newStartTime: newStart?.toISOString(),
      newEndTime: newEnd?.toISOString(),
      changedBy: context.agentSlug ?? 'voice_agent',
    }, {
      checkBlackout: async ({ startTime, endTime, providerId }) => {
        const tenantTz = await getTenantTimezone(client, context.tenantId);
        return buildOverrideConflictResponse(client, context.tenantId, startTime, endTime, providerId, tenantTz);
      },
    });

    if (!result.ok) {
      const conflictMessage = result.httpStatus === 409
        ? 'That new time conflicts with another booking or a shop blackout. Offer a different time. Do not claim the appointment was moved.'
        : String(result.body.error ?? 'Failed to update the existing booking.');
      return { success: false, action, bookingId: selected.bookingId, message: conflictMessage };
    }

    const bookingId = String(result.body.booking.id ?? selected.bookingId);
    return {
      success: true,
      action,
      bookingId,
      message: action === 'cancel'
        ? 'Existing booking cancelled through the scheduling lifecycle. Do not claim a new appointment was booked.'
        : 'Existing booking rescheduled through the scheduling lifecycle. Do not create another booking.',
    };
  } catch (err) {
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
