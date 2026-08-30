import { createLogger } from '../../../core/logger';
import { getPlatformPool, withTenantContext } from '../../../db';
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
  const contactPhone = String(input.contactPhone ?? '').trim();
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

const entry = getToolLibraryEntry('create_booking')!;

export const createBookingTool: ToolDefinition = {
  name: entry.name,
  description: entry.description,
  inputSchema: entry.parameters,
  handler: (input, context) => executeCreateBooking(input as Record<string, unknown>, context),
};
