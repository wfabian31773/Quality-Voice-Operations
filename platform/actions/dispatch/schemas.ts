import { z } from 'zod';
import { phone } from '../scheduling/writeSchemas';
import { DISPATCH_JOB_STATUSES } from './transitions';

/** ISO 8601 instant with an offset or Z. */
const instant = z
  .string()
  .datetime({ offset: true, message: 'Use an ISO date-time with offset, e.g. 2026-10-20T13:00:00-04:00' });

/** Optional string: blank or missing becomes undefined, not an empty string. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value): string | undefined => (value && value.length > 0 ? value : undefined));
}

export const DISPATCH_URGENCIES = ['normal', 'urgent'] as const;
export type DispatchUrgency = (typeof DISPATCH_URGENCIES)[number];

export const addressInput = z.object({
  line1: z.string().trim().min(1).max(200),
  unit: optionalText(50),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100),
  postal: z.string().trim().min(1).max(20),
});
export type DispatchAddress = z.infer<typeof addressInput>;

export const windowInput = z
  .object({
    start: instant,
    end: instant,
  })
  .refine((window) => Date.parse(window.start) < Date.parse(window.end), {
    message: 'Window start must be before end',
    path: ['end'],
  });
export type DispatchWindow = z.infer<typeof windowInput>;

export const createJobPrepareInput = z.object({
  jobType: z.string().trim().min(1).max(100),
  window: windowInput,
  address: addressInput,
  contact: z.object({
    name: z.string().trim().min(1).max(80),
    phone,
  }),
  problem: z.string().trim().min(1).max(2000),
  accessNotes: optionalText(500),
  urgency: z.enum(DISPATCH_URGENCIES),
});
export type CreateJobPrepareInput = z.infer<typeof createJobPrepareInput>;

export const createJobPrepareOutput = z.object({
  confirmationToken: z.string(),
  expiresAt: z.string(),
  readback: z.string(),
  payloadHash: z.string(),
});

export const createJobCommitInput = z.object({
  confirmationToken: z.string().uuid(),
});

export const spokenWindow = z.object({
  start: z.string(),
  end: z.string(),
  spoken: z.string(),
});

export const createJobCommitOutput = z.object({
  jobId: z.string(),
  window: spokenWindow,
  duplicate: z.boolean(),
});

export const updateStatusInput = z.object({
  jobId: z.string().trim().min(1).max(255),
  status: z.enum(DISPATCH_JOB_STATUSES),
  eta: instant.optional(),
});
export type UpdateStatusInput = z.infer<typeof updateStatusInput>;

export const updateStatusOutput = z.object({
  jobId: z.string(),
  status: z.enum(DISPATCH_JOB_STATUSES),
  fromStatus: z.enum(DISPATCH_JOB_STATUSES),
});

export const getJobStatusInput = z.object({
  phone,
  name: z.string().trim().min(1).max(80),
});
export type GetJobStatusInput = z.infer<typeof getJobStatusInput>;

export const getJobStatusOutput = z.object({
  status: z.enum(DISPATCH_JOB_STATUSES),
  window: spokenWindow,
});
