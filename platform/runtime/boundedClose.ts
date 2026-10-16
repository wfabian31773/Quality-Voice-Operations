/**
 * Bounded shutdown close (PR-00). `pool.end()` waits for every checked-out
 * client, so a stray timer holding a connection can hang shutdown until
 * Render SIGKILLs the process. This caps the wait so callers always reach
 * process.exit.
 */
import { createLogger } from '../core/logger';

const logger = createLogger('SHUTDOWN');

export const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Run `close`, giving up after `timeoutMs`. Never throws. Resolves true when
 * `close` finished, false when it failed or timed out (a warning is logged).
 */
export async function closeWithTimeout(
  name: string,
  close: () => Promise<void>,
  timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([close().then(() => 'closed' as const), timedOut]);
    if (result === 'timeout') {
      logger.warn(`${name} close timed out; exiting anyway`, { timeoutMs });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(`${name} close failed`, { error: err instanceof Error ? err.message : String(err) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
