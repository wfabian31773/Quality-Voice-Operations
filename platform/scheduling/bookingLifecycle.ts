import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';
import { connectorService } from '../integrations/connectors';
import type { StandardEventType } from '../integrations/connectors/types';
import { fireDispatchPush } from '../notifications/dispatchPush';

const logger = createLogger('BOOKING_LIFECYCLE');

export interface BookingQueryPool {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

export const VALID_BOOKING_TRANSITIONS: Record<string, string[]> = {
  confirm: ['pending'],
  check_in: ['confirmed'],
  complete: ['checked_in', 'confirmed'],
  no_show: ['confirmed', 'checked_in'],
  cancel: ['pending', 'confirmed', 'checked_in'],
  reschedule: ['pending', 'confirmed'],
  reopen: ['cancelled', 'no_show', 'completed'],
};

const STATUS_MAP: Record<string, string> = {
  confirm: 'confirmed',
  check_in: 'checked_in',
  complete: 'completed',
  no_show: 'no_show',
  cancel: 'cancelled',
  reschedule: 'rescheduled',
  reopen: 'pending',
};

export function bookingTimeToISO(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function buildAppointmentLifecyclePayload(
  booking: Record<string, unknown>,
  type: StandardEventType,
  extras: Record<string, unknown> = {},
): { type: StandardEventType; [key: string]: unknown } {
  const payload: Record<string, unknown> = {
    type,
    appointmentId: booking.id,
    agentId: booking.agent_id ?? undefined,
    title: booking.title ?? undefined,
    contactName: booking.contact_name ?? undefined,
    callerPhone: booking.contact_phone ?? undefined,
    attendeeEmail: booking.contact_email ?? undefined,
    startTime: bookingTimeToISO(booking.start_time),
    endTime: bookingTimeToISO(booking.end_time),
    timezone: booking.timezone ?? undefined,
    ...extras,
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }
  return payload as { type: StandardEventType; [key: string]: unknown };
}

export function dispatchAppointmentLifecycleEvent(
  tenantId: TenantId,
  payload: { type: StandardEventType; [key: string]: unknown },
): void {
  void connectorService
    .dispatchEvent(tenantId, payload.type, payload)
    .then((result) => {
      const successful = result.results.filter((r) => r.success).length;
      if (successful > 0) return;
      const firstError = result.results.find((r) => !r.success)?.error;
      const reason = firstError
        ?? (result.results.length === 0
          ? 'no_scheduling_adapter_dispatched'
          : 'all_adapters_returned_failure');
      logger.warn('Appointment lifecycle dispatch produced no successful adapter executions', {
        tenantId,
        eventType: payload.type,
        appointmentId: payload.appointmentId,
        dispatched: result.dispatched,
        attempted: result.results.length,
        reason,
      });
    })
    .catch((err) => {
      logger.warn('Appointment lifecycle dispatch failed', {
        tenantId,
        eventType: payload.type,
        appointmentId: payload.appointmentId,
        error: String(err),
      });
    });
}

export async function writeSchedulingAuditLog(
  pool: BookingQueryPool,
  tenantId: string,
  bookingId: string | null,
  action: string,
  previousStatus: string | null,
  newStatus: string | null,
  changedBy: string | null,
  details: Record<string, unknown> = {},
  overrideReason = '',
): Promise<void> {
  await pool.query(
    `INSERT INTO scheduling_audit_log (tenant_id, booking_id, action, previous_status, new_status, changed_by, details, override_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, bookingId, action, previousStatus, newStatus, changedBy, JSON.stringify(details), overrideReason],
  );
}

export async function checkBookingConflicts(
  pool: BookingQueryPool,
  tenantId: string,
  startTime: string,
  endTime: string,
  providerId?: string,
  resourceId?: string,
  excludeBookingId?: string,
): Promise<Array<{ id: string; title: unknown; start_time: unknown; end_time: unknown }>> {
  const conds: string[] = ['tenant_id = $1', "status NOT IN ('cancelled', 'no_show', 'rescheduled')"];
  const vals: unknown[] = [tenantId];

  vals.push(startTime);
  vals.push(endTime);
  conds.push('start_time < $3::timestamptz');
  conds.push('end_time > $2::timestamptz');

  if (providerId) { vals.push(providerId); conds.push(`provider_id = $${vals.length}`); }
  if (resourceId) { vals.push(resourceId); conds.push(`resource_id = $${vals.length}`); }
  if (excludeBookingId) { vals.push(excludeBookingId); conds.push(`id != $${vals.length}`); }

  const { rows } = await pool.query(
    `SELECT id, title, start_time, end_time FROM bookings WHERE ${conds.join(' AND ')}`,
    vals,
  );
  return rows as Array<{ id: string; title: unknown; start_time: unknown; end_time: unknown }>;
}

export interface TransitionBookingInput {
  tenantId: string;
  bookingId: string;
  action: string;
  cancellationReason?: string;
  overrideReason?: string;
  newStartTime?: string;
  newEndTime?: string;
  changedBy?: string | null;
}

export type TransitionBookingResult =
  | {
    ok: true;
    httpStatus: 200;
    body: { booking: Record<string, unknown>; previous_booking_id?: string };
    afterCommit?: Array<() => void>;
  }
  | { ok: false; httpStatus: number; body: Record<string, unknown> };

export interface TransitionBookingHooks {
  checkBlackout?: (args: {
    startTime: string;
    endTime: string;
    providerId: string | null;
  }) => Promise<{ status: number; body: Record<string, unknown> } | null>;
  deferSideEffects?: boolean;
}

export async function transitionBooking(
  pool: BookingQueryPool,
  input: TransitionBookingInput,
  hooks: TransitionBookingHooks = {},
): Promise<TransitionBookingResult> {
  const { tenantId, bookingId, action } = input;
  if (!VALID_BOOKING_TRANSITIONS[action]) {
    return { ok: false, httpStatus: 400, body: { error: `Invalid action: ${action}` } };
  }

  const { rows: existing } = await pool.query(
    `SELECT * FROM bookings WHERE id = $1 AND tenant_id = $2`,
    [bookingId, tenantId],
  );
  if (existing.length === 0) {
    return { ok: false, httpStatus: 404, body: { error: 'Booking not found' } };
  }

  const booking = existing[0] as Record<string, unknown>;
  if (!VALID_BOOKING_TRANSITIONS[action].includes(String(booking.status))) {
    return {
      ok: false,
      httpStatus: 400,
      body: {
        error: `Cannot ${action} a booking with status '${String(booking.status)}'. Allowed from: ${VALID_BOOKING_TRANSITIONS[action].join(', ')}`,
      },
    };
  }

  const newStatus = STATUS_MAP[action];
  const afterCommit: Array<() => void> = [];
  const scheduleSideEffect = (effect: () => void) => {
    if (hooks.deferSideEffects) afterCommit.push(effect);
    else effect();
  };
  const updateFragments: string[] = ['status = $3', 'updated_at = NOW()'];
  const updateValues: unknown[] = [bookingId, tenantId, newStatus];

  if (action === 'check_in') updateFragments.push('checked_in_at = NOW()');
  if (action === 'complete') updateFragments.push('completed_at = NOW()');
  if (action === 'cancel' && input.cancellationReason) {
    updateValues.push(input.cancellationReason);
    updateFragments.push(`cancellation_reason = $${updateValues.length}`);
  }

  if (action === 'reschedule') {
    if (!input.newStartTime || !input.newEndTime) {
      return { ok: false, httpStatus: 400, body: { error: 'new_start_time and new_end_time required for reschedule' } };
    }
    const conflicts = await checkBookingConflicts(
      pool,
      tenantId,
      input.newStartTime,
      input.newEndTime,
      booking.provider_id ? String(booking.provider_id) : undefined,
      booking.resource_id ? String(booking.resource_id) : undefined,
      bookingId,
    );
    if (conflicts.length > 0 && !input.overrideReason) {
      return { ok: false, httpStatus: 409, body: { error: 'New time slot has conflicts', conflicts } };
    }
    if (!input.overrideReason && hooks.checkBlackout) {
      const overrideConflict = await hooks.checkBlackout({
        startTime: input.newStartTime,
        endTime: input.newEndTime,
        providerId: booking.provider_id ? String(booking.provider_id) : null,
      });
      if (overrideConflict) {
        return { ok: false, httpStatus: overrideConflict.status, body: overrideConflict.body };
      }
    }
  }

  if ((action === 'reopen' || action === 'confirm') && !input.overrideReason && hooks.checkBlackout) {
    const overrideConflict = await hooks.checkBlackout({
      startTime: booking.start_time instanceof Date
        ? booking.start_time.toISOString()
        : String(booking.start_time),
      endTime: booking.end_time instanceof Date
        ? booking.end_time.toISOString()
        : String(booking.end_time),
      providerId: booking.provider_id ? String(booking.provider_id) : null,
    });
    if (overrideConflict) {
      return { ok: false, httpStatus: overrideConflict.status, body: overrideConflict.body };
    }
  }

  updateValues.push(String(booking.status));
  const { rowCount } = await pool.query(
    `UPDATE bookings SET ${updateFragments.join(', ')} WHERE id = $1 AND tenant_id = $2 AND status = $${updateValues.length}`,
    updateValues,
  );
  if (!rowCount) {
    return {
      ok: false,
      httpStatus: 409,
      body: {
        error: 'That appointment was just changed by the shop. Do not claim it was cancelled or moved. Offer to check again or leave a message.',
        reason: 'stale_status',
      },
    };
  }

  if (action === 'reschedule') {
    // Original row is already marked rescheduled; copy its prior status so
    // pending voice requests are not promoted to confirmed.
    const replacementStatus = String(booking.status) === 'pending' ? 'pending' : 'confirmed';
    const { rows: newBookingRows } = await pool.query(
      `INSERT INTO bookings (tenant_id, title, description, start_time, end_time, status,
          contact_name, contact_phone, contact_email, agent_id, created_by, notes,
          provider_id, appointment_type_id, resource_id, recurring_series_id,
          intake_data, timezone, location, booking_source)
         SELECT tenant_id, title, description, $3, $4, $6,
           contact_name, contact_phone, contact_email, agent_id, $5, notes,
           provider_id, appointment_type_id, resource_id, recurring_series_id,
           intake_data, timezone, location, booking_source
         FROM bookings WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
      [bookingId, tenantId, input.newStartTime, input.newEndTime, input.changedBy ?? null, replacementStatus],
    );

    await writeSchedulingAuditLog(
      pool,
      tenantId,
      bookingId,
      'rescheduled',
      String(booking.status),
      'rescheduled',
      input.changedBy ?? null,
      { new_booking_id: (newBookingRows[0] as { id?: string } | undefined)?.id, new_start_time: input.newStartTime, new_end_time: input.newEndTime },
      input.overrideReason || '',
    );

    const newBooking = newBookingRows[0] as Record<string, unknown> | undefined;
    if (newBooking?.resource_id) {
      scheduleSideEffect(() => {
        void fireDispatchPush({
          event: 'booking_rescheduled',
          tenantId,
          resourceIds: [newBooking.resource_id as string],
          booking: {
            id: newBooking.id as string,
            title: (newBooking.title as string | null) ?? null,
            start_time: newBooking.start_time
              ? (newBooking.start_time instanceof Date
                ? newBooking.start_time.toISOString()
                : String(newBooking.start_time))
              : null,
          },
        });
      });
    }

    scheduleSideEffect(() => {
      dispatchAppointmentLifecycleEvent(
        tenantId,
        buildAppointmentLifecyclePayload(booking, 'appointment.rescheduled', {
          newAppointmentId: newBooking?.id ?? undefined,
          newStartTime: bookingTimeToISO(input.newStartTime),
          newEndTime: bookingTimeToISO(input.newEndTime),
          rescheduleReason: input.overrideReason || undefined,
        }),
      );
    });

    return {
      ok: true,
      httpStatus: 200,
      body: { booking: newBookingRows[0] as Record<string, unknown>, previous_booking_id: bookingId },
      afterCommit,
    };
  }

  if (action === 'cancel') {
    const { rows: waitlistRows } = await pool.query(
      `SELECT * FROM scheduling_waitlist
         WHERE tenant_id = $1 AND status = 'waiting'
           AND (appointment_type_id IS NULL OR appointment_type_id = $2)
           AND (provider_id IS NULL OR provider_id = $3)
         ORDER BY created_at ASC LIMIT 1`,
      [tenantId, booking.appointment_type_id, booking.provider_id],
    );

    if (waitlistRows.length > 0) {
      await pool.query(
        `UPDATE scheduling_waitlist SET status = 'offered', notified_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [(waitlistRows[0] as { id: string }).id],
      );
    }

    if (booking.resource_id) {
      scheduleSideEffect(() => {
        void fireDispatchPush({
          event: 'booking_cancelled',
          tenantId,
          resourceIds: [booking.resource_id as string],
          booking: {
            id: booking.id as string,
            title: (booking.title as string | null) ?? null,
            start_time: booking.start_time
              ? (booking.start_time instanceof Date
                ? booking.start_time.toISOString()
                : String(booking.start_time))
              : null,
          },
        });
      });
    }

    scheduleSideEffect(() => {
      dispatchAppointmentLifecycleEvent(
        tenantId,
        buildAppointmentLifecyclePayload(booking, 'appointment.cancelled', {
          cancellationReason: input.cancellationReason || input.overrideReason || undefined,
        }),
      );
    });
  }

  if (action === 'no_show') {
    scheduleSideEffect(() => {
      dispatchAppointmentLifecycleEvent(
        tenantId,
        buildAppointmentLifecyclePayload(booking, 'appointment.no_show'),
      );
    });
  }

  await writeSchedulingAuditLog(
    pool,
    tenantId,
    bookingId,
    action,
    String(booking.status),
    newStatus,
    input.changedBy ?? null,
    { cancellation_reason: input.cancellationReason },
    input.overrideReason || '',
  );

  const { rows: updated } = await pool.query(
    `SELECT * FROM bookings WHERE id = $1 AND tenant_id = $2`,
    [bookingId, tenantId],
  );

  return {
    ok: true,
    httpStatus: 200,
    body: { booking: updated[0] as Record<string, unknown> },
    afterCommit,
  };
}
