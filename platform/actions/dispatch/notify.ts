import { getPlatformPool } from '../../db';
import { STATUS_TO_TRIGGER, type DispatchJobStatus } from './transitions';

export interface DispatchStatusNotification {
  tenantId: string;
  jobId: string;
  fromStatus: string;
  toStatus: DispatchJobStatus;
  trigger: string;
}

export type DispatchStatusNotifier = (event: DispatchStatusNotification) => void | Promise<void>;

export function triggerForStatus(status: string): string | undefined {
  return STATUS_TO_TRIGGER[status];
}

/**
 * Same fire-and-forget path as the admin transition handler:
 * `fireNotifications(pool, tenantId, jobId, trigger)`. Loaded lazily so unit
 * tests that inject a fake never pull the 5k-line route graph.
 */
export const fireAdminDispatchNotifications: DispatchStatusNotifier = (event) => {
  void import('../../../server/admin-api/routes/dispatch')
    .then(({ fireNotifications }) => {
      fireNotifications(getPlatformPool(), event.tenantId, event.jobId, event.trigger);
    })
    .catch(() => {
      // Tests, and the unregistered-actions path, have no admin route graph.
    });
};
