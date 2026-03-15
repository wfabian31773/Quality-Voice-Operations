import { createLogger } from '../../../platform/core/logger';

export interface SessionLogContext {
  tenantId: string;
  callId: string;
  callSid: string;
}

export interface SessionLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  debug(message: string, extra?: Record<string, unknown>): void;
}

export function createSessionLogger(module: string, ctx: SessionLogContext): SessionLogger {
  const base = createLogger(module);
  const baseCtx = { tenantId: ctx.tenantId, callId: ctx.callId, callSid: ctx.callSid };

  return {
    info(message: string, extra?: Record<string, unknown>): void {
      base.info(message, { ...baseCtx, ...extra });
    },
    warn(message: string, extra?: Record<string, unknown>): void {
      base.warn(message, { ...baseCtx, ...extra });
    },
    error(message: string, extra?: Record<string, unknown>): void {
      base.error(message, { ...baseCtx, ...extra });
    },
    debug(message: string, extra?: Record<string, unknown>): void {
      base.debug(message, { ...baseCtx, ...extra });
    },
  };
}
