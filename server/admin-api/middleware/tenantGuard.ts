import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('TENANT_GUARD');

export function requireTenantContext(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!req.user.tenantId) {
    logger.error('Request missing tenant context', { userId: req.user.userId, path: req.path });
    res.status(403).json({ error: 'Tenant context required' });
    return;
  }

  const tenantId = req.user.tenantId;

  if (req.body && typeof req.body === 'object') {
    if ('tenantId' in req.body || 'tenant_id' in req.body) {
      const bodyTenantId = req.body.tenantId || req.body.tenant_id;
      if (bodyTenantId && bodyTenantId !== tenantId) {
        logger.error('Cross-tenant request blocked', {
          userId: req.user.userId,
          requestedTenantId: bodyTenantId,
          actualTenantId: tenantId,
        });
        res.status(403).json({ error: 'Cross-tenant access denied' });
        return;
      }
    }
  }

  if (req.query.tenantId || req.query.tenant_id) {
    const queryTenantId = (req.query.tenantId || req.query.tenant_id) as string;
    if (queryTenantId !== tenantId && !req.user.isPlatformAdmin) {
      logger.error('Cross-tenant query blocked', {
        userId: req.user.userId,
        requestedTenantId: queryTenantId,
        actualTenantId: tenantId,
      });
      res.status(403).json({ error: 'Cross-tenant access denied' });
      return;
    }
  }

  next();
}
