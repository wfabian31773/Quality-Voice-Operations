import { sendDispatchPush, type PushResult } from './PushDispatcher';
import { createLogger } from '../core/logger';

const logger = createLogger('DISPATCH_PUSH');

export type DispatchPushEvent =
  | 'job_assigned'
  | 'job_status_en_route'
  | 'job_status_on_site'
  | 'booking_rescheduled';

export interface DispatchPushJob {
  id: string;
  title: string | null;
  status: string | null;
  contact_name?: string | null;
  address?: string | null;
  scheduled_at?: string | null;
  eta_start?: string | null;
}

interface FireParams {
  event: DispatchPushEvent;
  tenantId: string;
  resourceIds?: string[];
  userIds?: string[];
  job?: DispatchPushJob;
  /** Optional booking summary used by the booking_rescheduled event. */
  booking?: {
    id: string;
    title: string | null;
    start_time: string | null;
  };
}

function shortLocation(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 57)}…`;
}

function formatJobTitle(job?: DispatchPushJob): string {
  if (!job) return 'Job update';
  return job.title?.trim() || `Job ${job.id.slice(0, 6)}`;
}

function copyForEvent(event: DispatchPushEvent, params: FireParams): { title: string; body: string } {
  const job = params.job;
  switch (event) {
    case 'job_assigned': {
      const title = `New job assigned`;
      const parts = [formatJobTitle(job)];
      const loc = shortLocation(job?.address);
      if (loc) parts.push(loc);
      if (job?.contact_name) parts.push(`Customer: ${job.contact_name}`);
      return { title, body: parts.join(' · ') };
    }
    case 'job_status_en_route': {
      return {
        title: 'Marked en route',
        body: `${formatJobTitle(job)}${job?.contact_name ? ` · ${job.contact_name}` : ''}`,
      };
    }
    case 'job_status_on_site': {
      return {
        title: 'Arrived on-site',
        body: `${formatJobTitle(job)}${job?.contact_name ? ` · ${job.contact_name}` : ''}`,
      };
    }
    case 'booking_rescheduled': {
      const when = params.booking?.start_time
        ? new Date(params.booking.start_time).toLocaleString()
        : 'a new time';
      return {
        title: 'Appointment rescheduled',
        body: `${params.booking?.title?.trim() || 'Appointment'} → ${when}`,
      };
    }
  }
}

/**
 * Fire-and-forget push delivery for a dispatch / scheduling lifecycle event.
 * Errors are swallowed so the surrounding state-machine can never be blocked
 * by a flaky upstream (Expo, network, etc.).
 */
export async function fireDispatchPush(params: FireParams): Promise<PushResult | null> {
  try {
    const { title, body } = copyForEvent(params.event, params);
    const data: Record<string, unknown> = { event: params.event, tenantId: params.tenantId };
    if (params.job) {
      data.jobId = params.job.id;
      data.jobStatus = params.job.status;
    }
    if (params.booking) data.bookingId = params.booking.id;
    return await sendDispatchPush(
      {
        tenantId: params.tenantId,
        resourceIds: params.resourceIds,
        userIds: params.userIds,
      },
      {
        title,
        body,
        data,
        channelId: 'dispatch',
        priority: 'high',
      },
    );
  } catch (err) {
    logger.warn('fireDispatchPush failed', {
      tenantId: params.tenantId,
      event: params.event,
      error: String(err),
    });
    return null;
  }
}
