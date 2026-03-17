import type { Request, Response, NextFunction } from 'express';

export type ApiKeyPermission = 'read-only' | 'write' | 'admin';

const PERMISSION_HIERARCHY: Record<string, number> = {
  'read-only': 1,
  'write': 2,
  'admin': 3,
};

export function requireApiKeyPermission(minimumPermission: ApiKeyPermission) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const isApiKeyAuth = req.user.userId.startsWith('apikey:');
    if (!isApiKeyAuth) {
      next();
      return;
    }

    const scopes = req.apiKeyScopes;
    if (!scopes || scopes.length === 0) {
      res.status(403).json({ error: 'API key has no scopes configured' });
      return;
    }

    if (scopes.includes('*') || scopes.includes('admin')) {
      next();
      return;
    }

    const requiredLevel = PERMISSION_HIERARCHY[minimumPermission] ?? 0;
    const maxLevel = Math.max(
      ...scopes.map(s => PERMISSION_HIERARCHY[s] ?? 0),
      0,
    );

    if (maxLevel < requiredLevel) {
      res.status(403).json({
        error: `Insufficient API key permissions. Required: ${minimumPermission}`,
      });
      return;
    }

    next();
  };
}
