/**
 * One-shot jobs for Render cron services (PR-00). Each job is a list of
 * steps; steps run sequentially, a failing step never skips the rest, and
 * the job fails if any step threw or its `failed` check reported a failure.
 *
 * `nightly` = the run-once function of every daily scheduler in the
 * registry that has one (see `nightly` in platform/runtime/schedulers.ts).
 * No new job logic lives here.
 */
import { createLogger } from '../../platform/core/logger';
import { nightlySchedulers, type SchedulerDefinition } from '../../platform/runtime/schedulers';

const logger = createLogger('JOBS');

export interface JobStep {
  name: string;
  run: () => Promise<unknown>;
  /** Failure reason for a resolved result (see `nightlyFailed`), else null. */
  failed?: (result: unknown) => string | null;
}

export interface JobResult {
  job: string;
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; durationMs: number; error?: string }>;
}

export function nightlySteps(registry?: readonly SchedulerDefinition[]): JobStep[] {
  return nightlySchedulers(registry).map((s) => ({
    name: s.name,
    run: s.nightly as () => Promise<unknown>,
    failed: s.nightlyFailed,
  }));
}

export const JOBS: Record<string, () => JobStep[]> = {
  nightly: () => nightlySteps(),
};

export async function runJob(job: string, steps: JobStep[]): Promise<JobResult> {
  const result: JobResult = { job, ok: true, steps: [] };
  logger.info('Job starting', { job, steps: steps.map((s) => s.name) });
  for (const step of steps) {
    const startedAt = Date.now();
    try {
      const value = await step.run();
      const reason = step.failed?.(value) ?? null;
      if (reason) throw new Error(reason);
      result.steps.push({ name: step.name, ok: true, durationMs: Date.now() - startedAt });
      logger.info('Job step complete', { job, step: step.name, durationMs: Date.now() - startedAt });
    } catch (err) {
      result.ok = false;
      // Error messages only (no env values are ever interpolated here).
      const message = err instanceof Error ? err.message : String(err);
      result.steps.push({ name: step.name, ok: false, durationMs: Date.now() - startedAt, error: message });
      logger.error('Job step failed', { job, step: step.name, error: message });
    }
  }
  logger.info('Job finished', { job, ok: result.ok, failed: result.steps.filter((s) => !s.ok).map((s) => s.name) });
  return result;
}
