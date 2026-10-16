/**
 * Render cron entrypoint (QVO_PROCESS_ROLE=cron).
 *
 *   npx tsx server/jobs/run.ts nightly
 *
 * Runs one job from server/jobs/jobs.ts and exits non-zero if any step
 * failed (or the job name is unknown), so Render marks the run failed.
 */
import { closePlatformPool } from '../../platform/db';
import { createLogger } from '../../platform/core/logger';
import { validateEnvironment } from '../../scripts/validate-env';
import { resolveProcessRole, isRenderRuntime, scrubReplitFallbacks } from '../../platform/runtime/processRole';
import { closeWithTimeout } from '../../platform/runtime/boundedClose';
import { JOBS, runJob } from './jobs';

const logger = createLogger('JOBS');

async function main(): Promise<number> {
  const job = process.argv[2];
  if (!job || !JOBS[job]) {
    logger.error('Unknown or missing job name', { job: job ?? null, known: Object.keys(JOBS) });
    return 2;
  }

  const role = resolveProcessRole(process.env, 'cron');
  scrubReplitFallbacks();
  const isProd = process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging';
  const env = validateEnvironment({ role });
  if (!env.passed && (isProd || isRenderRuntime())) {
    logger.error('Environment validation failed', { missing: env.missing });
    return 1;
  }

  const result = await runJob(job, JOBS[job]());
  return result.ok ? 0 : 1;
}

main()
  .catch((err) => {
    logger.error('Job runner crashed', { error: err instanceof Error ? err.message : String(err) });
    return 1;
  })
  .then(async (code) => {
    await closeWithTimeout('DB pool', closePlatformPool);
    process.exit(code);
  });
