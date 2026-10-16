/**
 * Voice-gateway shutdown paths (PR-00). Extracted from start.ts so the
 * zero-dropped-call drain is testable end to end.
 */
import { createLogger } from '../../platform/core/logger';
import { resolveDrainTimeoutMs, type SessionManager } from './services/sessionManager';

const logger = createLogger('VOICE_GATEWAY');

export interface VoiceShutdownDeps {
  server: { close: (cb?: () => void) => unknown; closeAllConnections?: () => void };
  sessions: Pick<SessionManager, 'drainGracefully' | 'drainAll' | 'getActiveCount'>;
  closePool: () => Promise<void>;
  stopCanary: () => void;
  exit: (code: number) => void;
  env?: Record<string, string | undefined>;
}

export function createVoiceShutdown(deps: VoiceShutdownDeps) {
  let shuttingDown = false;

  /**
   * SIGTERM/SIGINT (deploys): zero-dropped-call drain. Keep serving HTTP so
   * `/healthz` stays 200 and `/twilio/voice` can answer with a redirect,
   * refuse new streams, and wait for live calls to end on their own for up
   * to DRAIN_TIMEOUT_MS (default 285 s, below Render's 300 s shutdown delay).
   */
  async function drainAndExit(signal: string): Promise<void> {
    if (shuttingDown) {
      logger.info(`Received ${signal} while already shutting down — ignoring`);
      return;
    }
    shuttingDown = true;
    const timeoutMs = resolveDrainTimeoutMs(deps.env ?? process.env);
    logger.info(`Received ${signal}, draining (calls end naturally)`, {
      activeSessions: deps.sessions.getActiveCount(),
      drainTimeoutMs: timeoutMs,
    });

    deps.stopCanary();
    const result = await deps.sessions.drainGracefully({ timeoutMs });
    logger.info('Drain finished', { ...result });

    deps.server.close(() => {
      logger.info('HTTP server closed');
    });
    deps.server.closeAllConnections?.();

    await deps.closePool().catch((err) => {
      logger.warn('DB pool close failed', { error: String(err) });
    });
    logger.info('Shutdown complete');
    deps.exit(0);
  }

  /** uncaughtException: the pre-PR-00 fast path (clean up every call now). */
  async function fastShutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Fast shutdown (${reason})`);
    deps.stopCanary();
    deps.server.close(() => {
      logger.info('HTTP server closed — no new connections');
    });
    await deps.sessions.drainAll(30_000);
    await deps.closePool();
    logger.info('DB pool closed');
    logger.info('Shutdown complete');
    deps.exit(0);
  }

  return { drainAndExit, fastShutdown };
}
