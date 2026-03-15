import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getPlatformPool, withTenantContext, withPrivilegedClient } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('ADMIN_AUTH');

const IS_PROD = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').startsWith('prod');

function getJwtSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    if (IS_PROD) {
      throw new Error('ADMIN_JWT_SECRET is required in production');
    }
    const devSecret = 'qvo-dev-jwt-' + (process.env.REPL_ID ?? 'local');
    logger.warn('ADMIN_JWT_SECRET not set — using auto-generated dev secret (NOT for production)');
    return devSecret;
  }
  return secret;
}

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
  isPlatformAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

interface ResolvedAuth {
  role: string;
  isPlatformAdmin: boolean;
}

async function resolveCurrentRole(userId: string, tenantId: string): Promise<ResolvedAuth | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT role FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
      [userId, tenantId],
    );
    await client.query('COMMIT');
    if (rows.length === 0) return null;

    const { rows: userRows } = await withPrivilegedClient(async (privClient) => {
      return privClient.query(
        `SELECT is_platform_admin FROM users WHERE id = $1`,
        [userId],
      );
    });
    const isPlatformAdmin = (userRows[0]?.is_platform_admin as boolean) ?? false;

    return { role: rows[0].role as string, isPlatformAdmin };
  } catch {
    await client.query('ROLLBACK');
    return null;
  } finally {
    client.release();
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.cookies?.auth_token) {
    token = req.cookies.auth_token as string;
  }

  if (!token) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }
  try {
    const payload = jwt.verify(token, getJwtSecret()) as Record<string, unknown>;
    const userId = payload.sub as string;
    const tenantId = payload.tenantId as string;
    const email = payload.email as string;

    resolveCurrentRole(userId, tenantId)
      .then(async (auth) => {
        if (!auth) {
          res.status(403).json({ error: 'No active role in this tenant' });
          return;
        }
        req.user = { userId, tenantId, email, role: auth.role, isPlatformAdmin: auth.isPlatformAdmin };

        const allowedPendingPaths = ['/tenants/me/provisioning-status', '/tenants/me', '/auth/me'];
        const path = req.path;
        const isAllowedForPending =
          allowedPendingPaths.some((p) => path === p) ||
          (req.method === 'GET' && path === '/agents');
        if (!isAllowedForPending) {
          try {
            const pool = (await import('../../../platform/db')).getPlatformPool();
            const { rows } = await pool.query(`SELECT status FROM tenants WHERE id = $1`, [tenantId]);
            if (rows.length > 0 && rows[0].status === 'pending') {
              res.status(403).json({ error: 'Tenant is not yet provisioned. Complete checkout first.' });
              return;
            }
          } catch (checkErr) {
            logger.error('Failed to check tenant status for pending gate', { error: String(checkErr) });
            res.status(500).json({ error: 'Unable to verify tenant status' });
            return;
          }
        }

        next();
      })
      .catch((err) => {
        logger.error('Failed to resolve user role from DB', { error: String(err) });
        res.status(500).json({ error: 'Failed to verify authorization' });
      });
  } catch (err) {
    logger.warn('JWT verification failed', { error: String(err) });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function issueToken(user: AuthenticatedUser, expiresIn: string = '8h'): string {
  return jwt.sign(
    {
      sub: user.userId,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
      isPlatformAdmin: user.isPlatformAdmin ?? false,
    },
    getJwtSecret(),
    { expiresIn } as jwt.SignOptions,
  );
}
