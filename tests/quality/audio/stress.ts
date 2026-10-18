/**
 * The audio pack on a loaded box (orchestrator finding: with two `tsc`
 * processes running, S12 failed 1 run in 3 because the late tool result no
 * longer double-answered). This entry slows everything real on purpose:
 *
 * - the loader thread: every dynamic import() the runtime makes waits
 *   LOADER_DELAY_MS of real time (slowLoader.mjs);
 * - the event loop: a busy-wait on every DB statement and every 25th step;
 * - real I/O in a fake edge: each DB statement also awaits real time, through
 *   CallWorld.trackReal, so the clock waits for it.
 *
 *   node --import tsx tests/quality/audio/stress.ts [--keep-dynamic-imports] [--loader-delay-ms=N]
 *
 * Then it runs the pass^5 gate and prints the report (RESULT_MARKER line).
 * With the harness's edges the report matches an idle run. With
 * --keep-dynamic-imports (the import() edge off, i.e. the old harness) the
 * tool path's `await import()` waits on the loader in real time while the
 * clock steps on, so S12's late tool result lands after the hangup: the
 * orchestrator's failure, every run.
 */
import { register } from 'node:module';
import { setTimeout as realSleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { FakeXaiServer } from '../../../scripts/quality/audio/fakeXai';
import { exitWith, runAudioCli } from '../../../scripts/quality/audio/run';
import { currentWorld, FakePool } from '../../../scripts/quality/audio/world';

/** Long enough that on the old harness the tool result lands after the caller hung up, even on a slow box. */
export const LOADER_DELAY_MS = 1_000;
const DB_BUSY_MS = 1;
const DB_REAL_IO_MS = 2;
const STEP_BUSY_MS = 1;
const STEP_BUSY_EVERY = 25;

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // starve the event loop
  }
}

function slowDown(loaderDelayMs: number): void {
  register('./slowLoader.mjs', import.meta.url, { data: { delayMs: loaderDelayMs } });

  const query = FakePool.prototype.query;
  FakePool.prototype.query = async function (this: FakePool, text: unknown, values?: unknown[]) {
    busyWait(DB_BUSY_MS);
    const world = currentWorld();
    if (world) await world.trackReal(realSleep(DB_REAL_IO_MS));
    return query.call(this, text, values);
  };

  const tick = FakeXaiServer.prototype.tick;
  let steps = 0;
  FakeXaiServer.prototype.tick = function (this: FakeXaiServer) {
    steps += 1;
    if (steps % STEP_BUSY_EVERY === 0) busyWait(STEP_BUSY_MS);
    return tick.call(this);
  };
}

async function main(argv: string[]): Promise<number> {
  const delayArg = argv.find((arg) => arg.startsWith('--loader-delay-ms='));
  slowDown(delayArg ? Number(delayArg.slice('--loader-delay-ms='.length)) : LOADER_DELAY_MS);
  const keep = argv.includes('--keep-dynamic-imports');
  const { code } = await runAudioCli(['--pass-k=5', '--json'], { edges: { syncDynamicImports: !keep } });
  return code;
}

main(process.argv.slice(2))
  .then((code) => exitWith(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    exitWith(1);
  });
