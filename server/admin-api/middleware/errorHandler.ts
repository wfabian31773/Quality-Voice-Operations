import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../../../platform/core/logger';
import { logError } from '../../../platform/core/observability';

const logger = createLogger('ADMIN_ERROR');

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const error = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error('Unhandled error', { method: req.method, path: req.path, error });

  const tenantId = req.user?.tenantId ?? null;
  logError(tenantId, 'error', error, {
    service: 'admin-api',
    stackTrace: stack,
    extra: { method: req.method, path: req.path },
  });

  res.status(500).json({ error: 'Internal server error' });
}
