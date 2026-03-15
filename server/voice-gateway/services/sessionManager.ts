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

class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private draining = false;

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

  async drainAll(timeoutMs = 30_000): Promise<void> {
    this.draining = true;
    logger.info('Draining active sessions', { count: this.sessions.size });

    const sessions: ActiveSession[] = [];
    this.sessions.forEach((s) => sessions.push(s));
    const cleanups = sessions.map(async (session) => {
      try {
        await Promise.race([
          session.cleanup(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup timeout')), timeoutMs)),
        ]);
      } catch (err) {
        logger.error('Session cleanup failed', {
          callId: session.callSessionId,
          tenantId: session.tenantId,
          error: String(err),
        });
      }
    });

    await Promise.allSettled(cleanups);
    this.sessions.clear();
    logger.info('All sessions drained');
  }
}

export const sessionManager = new SessionManager();
