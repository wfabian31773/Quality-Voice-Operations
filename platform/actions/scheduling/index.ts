import type { AnyActionDefinition } from '../core';
import { checkAvailabilityAction } from './checkAvailability';
import { listServicesAction } from './listServices';
import { listStaffAction } from './listStaff';

export const schedulingActions: AnyActionDefinition[] = [
  listServicesAction,
  listStaffAction,
  checkAvailabilityAction,
];
