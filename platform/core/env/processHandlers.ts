const shutdownCallbacks: Array<() => Promise<void> | void> = [];

/**
 * Register a callback to be called on graceful shutdown (SIGINT / SIGTERM).
 * Call this from any service that holds resources.
 */
export function onShutdown(cb: () => Promise<void> | void): void {
  shutdownCallbacks.push(cb);
}

/**
 * Install global uncaught exception handlers that log but keep the process alive,
 * and a graceful shutdown handler.
 *
 * Call once at every server entry point.
 */
export function installProcessHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    console.error('[CRITICAL] Uncaught Exception — process staying alive:', error);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[CRITICAL] Unhandled Promise Rejection — process staying alive:', reason);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[SHUTDOWN] Received ${signal} — graceful shutdown starting`);
    try {
      await Promise.all(shutdownCallbacks.map((cb) => cb()));
    } catch (err) {
      console.error('[SHUTDOWN] Error during shutdown callbacks:', err);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
