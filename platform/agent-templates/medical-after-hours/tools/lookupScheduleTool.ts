import type { TenantId } from '../../../core/types';
import { lookupPatientSchedule } from '../../../integrations/azul-vision/scheduleLookupService';
import { createLogger } from '../../../core/logger';

const logger = createLogger('SCHEDULE_LOOKUP_TOOL');

export interface LookupScheduleInput {
  phone?: string;
  firstName?: string;
  lastName?: string;
  dob?: string;
}

export interface LookupScheduleDeps {
  tenantId: TenantId;
  callLogId?: string;
  practiceName?: string;
}

export async function lookupSchedule(
  input: LookupScheduleInput,
  deps: LookupScheduleDeps,
): Promise<{ success: boolean; schedule: string | null; message?: string }> {
  if (deps.practiceName !== 'Azul Vision' && deps.practiceName !== 'Azul Vision Eye Center') {
    return { success: false, schedule: null, message: 'Schedule lookup is not available for this practice.' };
  }

  try {
    const result = await lookupPatientSchedule({
      phone: input.phone,
      firstName: input.firstName,
      lastName: input.lastName,
      dob: input.dob,
    });

    if (result) {
      logger.info('Schedule found', { tenantId: deps.tenantId, callId: deps.callLogId });
      return { success: true, schedule: result };
    }

    return { success: true, schedule: null, message: 'No appointments found for this patient.' };
  } catch (err) {
    logger.error('Schedule lookup failed', { tenantId: deps.tenantId, error: String(err) });
    return { success: false, schedule: null, message: 'Unable to look up schedule at this time.' };
  }
}
