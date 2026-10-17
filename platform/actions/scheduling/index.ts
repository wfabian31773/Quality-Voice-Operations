import type { AnyActionDefinition } from '../core';
import { bookCommitAction, bookPrepareAction } from './book';
import { cancelCommitAction, cancelPrepareAction } from './cancel';
import { checkAvailabilityAction } from './checkAvailability';
import { findBookingsAction } from './findBookings';
import { listServicesAction } from './listServices';
import { listStaffAction } from './listStaff';
import { rescheduleCommitAction, reschedulePrepareAction } from './reschedule';

export const schedulingActions: AnyActionDefinition[] = [
  listServicesAction,
  listStaffAction,
  checkAvailabilityAction,
  findBookingsAction,
  bookPrepareAction,
  bookCommitAction,
  reschedulePrepareAction,
  rescheduleCommitAction,
  cancelPrepareAction,
  cancelCommitAction,
];
