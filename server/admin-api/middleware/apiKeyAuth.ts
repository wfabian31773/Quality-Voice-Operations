import type { Request, Response, NextFunction } from 'express';
import { validateApiKey } from '../../../platform/rbac/ApiKeyService';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('API_KEY_AUTH');

export function requireApiKeyOrJwt(
  jwtMiddleware: (req: Request, res: Response, next: NextFunction) => void,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer vai_')) {
      const rawKey = authHeader.slice(7);
      try {
        const result = await validateApiKey(rawKey);
        if (!result) {
          res.status(401).json({ error: 'Invalid or expired API key' });
          return;
        }
        req.user = {
          userId: `apikey:${result.keyId}`,
          tenantId: result.tenantId,
          email: 'api-key@system',
          role: 'tenant_owner',
          isPlatformAdmin: false,
        };
        req.apiKeyScopes = result.scopes;
        next();
        return;
      } catch (err) {
        logger.error('API key validation error', { error: String(err) });
        res.status(500).json({ error: 'Authentication failed' });
        return;
      }
    }

    jwtMiddleware(req, res, next);
  };
}
