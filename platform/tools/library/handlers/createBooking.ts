import { createLogger } from '../../../core/logger';
import { getPlatformPool, withTenantContext } from '../../../db';
import { phoneDigits } from '../../../reasoning/sessionBinding';
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

export async function executeUpdateBooking(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{ success: boolean; message: string; bookingId?: string; action?: string }> {
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
  if (action === 'reschedule') {
    const startTime = String(input.startTime ?? '').trim();
    newStart = startTime ? new Date(startTime) : null;
    if (!newStart || Number.isNaN(newStart.getTime())) {
      return { success: false, message: 'Reschedule requires a valid startTime.' };
    }
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let updated: { id: string } | undefined;
    await withTenantContext(client, context.tenantId, async () => {
      const { rows: existing } = await client.query(
        `SELECT id, start_time, end_time, status, title
         FROM bookings
         WHERE tenant_id = $1
           AND status IN ('pending', 'confirmed')
           AND start_time >= NOW()
           AND RIGHT(regexp_replace(COALESCE(contact_phone, ''), '\\D', '', 'g'), 10) = $2
         ORDER BY start_time ASC
         LIMIT 1`,
        [context.tenantId, lookupDigits.slice(-10)],
      );
      const booking = existing[0] as {
        id: string;
        start_time: Date | string;
        end_time: Date | string;
        status: string;
        title: string;
      } | undefined;
      if (!booking) {
        return;
      }

      if (action === 'cancel') {
        const reason = String(input.notes ?? 'Caller cancelled on a voice call').trim();
        await client.query(
          `UPDATE bookings
           SET status = 'cancelled', cancellation_reason = $3, updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2`,
          [booking.id, context.tenantId, reason],
        );
        updated = { id: booking.id };
        return;
      }

      const previousStart = new Date(booking.start_time);
      const previousEnd = new Date(booking.end_time);
      const durationMs = Math.max(previousEnd.getTime() - previousStart.getTime(), 30 * 60_000);
      const newEnd = new Date(newStart!.getTime() + durationMs);
      const notes = String(input.notes ?? 'Rescheduled on a voice call').trim();
      await client.query(
        `UPDATE bookings
         SET start_time = $3::timestamptz, end_time = $4::timestamptz, notes = $5, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [booking.id, context.tenantId, newStart!.toISOString(), newEnd.toISOString(), notes],
      );
      updated = { id: booking.id };
    });
    await client.query('COMMIT');
    if (!updated) {
      return {
        success: false,
        message: 'No upcoming booking was found for this caller. Do not create a new booking. Offer to leave a message for the shop.',
        action,
      };
    }
    return {
      success: true,
      action,
      bookingId: updated.id,
      message: action === 'cancel'
        ? 'Existing booking cancelled. Do not claim a new appointment was booked.'
        : 'Existing booking moved to the requested time. Do not create another booking.',
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
