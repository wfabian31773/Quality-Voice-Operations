import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('SESSION_MANAGER');

export interface ActiveSession {
  callSessionId: string;
  tenantId: string;
  agentId: string;
  callSid: string;
  startedAt: Date;
  cleanup: () => Promise<void>;
}

export interface DrainStatus {
  draining: boolean;
  activeSessions: number;
  oldestSessionAgeSec: number;
  /** Open media/widget WebSockets, including ones not yet registered as sessions. */
  openStreams: number;
}

export interface GracefulDrainOptions {
  /** How long to wait for calls to end on their own (DRAIN_TIMEOUT_MS). */
  timeoutMs: number;
  pollIntervalMs?: number;
  /** Per-straggler cleanup bound once the timeout has passed. */
  stragglerCleanupTimeoutMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

export interface GracefulDrainResult {
  endedNaturally: boolean;
  waitedMs: number;
  stragglers: number;
}

/** Default natural-end drain window: below Render's 300 s maxShutdownDelaySeconds. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 285_000;

export function resolveDrainTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = parseInt(env.DRAIN_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DRAIN_TIMEOUT_MS;
}

/**
 * Call SIDs are not PHI on their own, but when DISABLE_PHI_LOGGING is on we
 * keep logs free of joinable identifiers: only the prefix and last 4 chars.
 */
export function redactCallSidForLog(callSid: string, env: Record<string, string | undefined> = process.env): string {
  if (env.DISABLE_PHI_LOGGING !== 'true') return callSid;
  if (!callSid) return callSid;
  return callSid.length <= 6 ? '***' : `${callSid.slice(0, 2)}…${callSid.slice(-4)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private draining = false;
  private openConnections = 0;

  register(session: ActiveSession): void {
    this.sessions.set(session.callSessionId, session);
    logger.info('Session registered', {
      callId: session.callSessionId,
      tenantId: session.tenantId,
      activeSessions: this.sessions.size,
    });
  }

  unregister(callSessionId: string): void {
    this.sessions.delete(callSessionId);
    logger.info('Session unregistered', {
      callId: callSessionId,
      activeSessions: this.sessions.size,
    });
  }

  get(callSessionId: string): ActiveSession | undefined {
    return this.sessions.get(callSessionId);
  }

  getByCallSid(callSid: string): ActiveSession | undefined {
    let found: ActiveSession | undefined;
    this.sessions.forEach((session) => {
      if (session.callSid === callSid) found = session;
    });
    return found;
  }

  getActiveCount(): number {
    return this.sessions.size;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** Stop admitting new calls/streams. Idempotent. */
  beginDrain(): void {
    if (!this.draining) {
      this.draining = true;
      logger.info('Draining: new calls are redirected and new streams refused', {
        activeSessions: this.sessions.size,
        openStreams: this.openConnections,
      });
    }
  }

  /**
   * Count an accepted WebSocket until it closes. A Twilio stream is only
   * registered as a session after its `start` frame, so the drain also waits
   * on open sockets to avoid exiting under a call that is still connecting.
   */
  trackConnection(): () => void {
    this.openConnections++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.openConnections = Math.max(0, this.openConnections - 1);
    };
  }

  getDrainStatus(nowMs: number = Date.now()): DrainStatus {
    let oldest = 0;
    this.sessions.forEach((s) => {
      const age = Math.max(0, Math.floor((nowMs - s.startedAt.getTime()) / 1000));
      if (age > oldest) oldest = age;
    });
    return {
      draining: this.draining,
      activeSessions: this.sessions.size,
      oldestSessionAgeSec: oldest,
      openStreams: this.openConnections,
    };
  }

  getMetrics(): {
    activeSessions: number;
    draining: boolean;
    sessionsByTenant: Record<string, number>;
  } {
    const byTenant: Record<string, number> = {};
    this.sessions.forEach((s) => {
      byTenant[s.tenantId] = (byTenant[s.tenantId] ?? 0) + 1;
    });
    return {
      activeSessions: this.sessions.size,
      draining: this.draining,
      sessionsByTenant: byTenant,
    };
  }

  /**
   * Zero-dropped-call drain (SIGTERM/SIGINT). Marks the manager draining,
   * then waits for live calls to end on their own, polling every second,
   * until `timeoutMs`. Only sessions still active at the timeout are cleaned
   * up, each logged with its (redacted) call SID and age.
   */
  async drainGracefully(opts: GracefulDrainOptions): Promise<GracefulDrainResult> {
    const now = opts.now ?? Date.now;
    const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    const startedAt = now();
    this.beginDrain();

    while (this.sessions.size + this.openConnections > 0 && now() - startedAt < opts.timeoutMs) {
      await sleep(Math.min(pollIntervalMs, Math.max(1, opts.timeoutMs - (now() - startedAt))));
    }

    const waitedMs = now() - startedAt;
    if (this.sessions.size === 0) {
      logger.info('Drain complete: all calls ended naturally', {
        waitedMs,
        openStreams: this.openConnections,
      });
      return { endedNaturally: true, waitedMs, stragglers: 0 };
    }

    const stragglers: ActiveSession[] = [];
    this.sessions.forEach((s) => stragglers.push(s));
    const nowMs = now();
    for (const s of stragglers) {
      logger.warn('Drain timeout: cleaning up call still active', {
        callSid: redactCallSidForLog(s.callSid),
        callId: s.callSessionId,
        tenantId: s.tenantId,
        ageSec: Math.max(0, Math.floor((nowMs - s.startedAt.getTime()) / 1000)),
        drainTimeoutMs: opts.timeoutMs,
      });
    }
    await this.cleanupSessions(stragglers, opts.stragglerCleanupTimeoutMs ?? 10_000);
    this.sessions.clear();
    return { endedNaturally: false, waitedMs, stragglers: stragglers.length };
  }

  /**
   * Fast path (uncaughtException): clean up every live session immediately.
   * Not used for SIGTERM/SIGINT any more; see drainGracefully.
   */
  async drainAll(timeoutMs = 30_000): Promise<void> {
    this.draining = true;
    logger.info('Draining active sessions', { count: this.sessions.size });

    const sessions: ActiveSession[] = [];
    this.sessions.forEach((s) => sessions.push(s));
    await this.cleanupSessions(sessions, timeoutMs);
    this.sessions.clear();
    logger.info('All sessions drained');
  }

  private async cleanupSessions(sessions: ActiveSession[], timeoutMs: number): Promise<void> {
    const cleanups = sessions.map(async (session) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.cleanup(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('cleanup timeout')), timeoutMs);
          }),
        ]);
      } catch (err) {
        logger.error('Session cleanup failed', {
          callId: session.callSessionId,
          tenantId: session.tenantId,
          error: String(err),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    await Promise.allSettled(cleanups);
  }

  /** Test seam: reset all state. */
  __resetForTests(): void {
    this.sessions.clear();
    this.draining = false;
    this.openConnections = 0;
  }
}

export { SessionManager };
export const sessionManager = new SessionManager();
