import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getPlatformPool, withTenantContext, withPrivilegedClient } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { requireTenantContext } from './tenantGuard';
import { isProductionLike } from './security';

const logger = createLogger('ADMIN_AUTH');

function getJwtSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    // Evaluate per-call (not at module-load) so test setups that mutate
    // process.env between requests, and any nonstandard boot path that
    // skips start.ts's assertProductionSecrets(), still fail closed in
    // production *and* staging.
    if (isProductionLike()) {
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
      apiKeyScopes?: string[];
    }
  }
}

interface ResolvedAuth {
  role: string;
  isPlatformAdmin: boolean;
}

const TENANT_STATUS_CACHE_TTL_MS = 30_000;
const TENANT_STATUS_CACHE_MAX_ENTRIES = 1_000;

interface TenantStatusEntry {
  status: string;
  expiresAt: number;
}

const tenantStatusCache = new Map<string, TenantStatusEntry>();

function getCachedTenantStatus(tenantId: string, now: number = Date.now()): string | null {
  const entry = tenantStatusCache.get(tenantId);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    tenantStatusCache.delete(tenantId);
    return null;
  }
  // Touch to refresh insertion order — Map iteration is insertion-ordered,
  // so re-setting promotes this entry to the most-recently-used position.
  tenantStatusCache.delete(tenantId);
  tenantStatusCache.set(tenantId, entry);
  return entry.status;
}

function setCachedTenantStatus(
  tenantId: string,
  status: string,
  now: number = Date.now(),
): void {
  tenantStatusCache.set(tenantId, {
    status,
    expiresAt: now + TENANT_STATUS_CACHE_TTL_MS,
  });
  while (tenantStatusCache.size > TENANT_STATUS_CACHE_MAX_ENTRIES) {
    const oldestKey = tenantStatusCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    tenantStatusCache.delete(oldestKey);
  }
}

export function invalidateTenantStatusCache(tenantId: string): void {
  tenantStatusCache.delete(tenantId);
}

export function clearTenantStatusCache(): void {
  tenantStatusCache.clear();
}

export function tenantStatusCacheSize(): number {
  return tenantStatusCache.size;
}

async function resolveCurrentRole(
  userId: string,
  tenantId: string,
): Promise<ResolvedAuth | null> {
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
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
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
    // Pin to HS256 — without this, jsonwebtoken accepts whichever algorithm
    // the token's header advertises, which enables algorithm-confusion attacks
    // (e.g. an attacker signing with `none` or with the public key of an RSA
    // pair). The only signing algorithm we use anywhere is HS256.
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as Record<string, unknown>;
    const userId = payload.sub as string;
    const tenantId = payload.tenantId as string;
    const email = payload.email as string;

    resolveCurrentRole(userId, tenantId)
      .then(async (auth) => {
        if (auth === null) {
          res.status(403).json({ error: 'No active role in this tenant' });
          return;
        }
        req.user = { userId, tenantId, email, role: auth.role, isPlatformAdmin: auth.isPlatformAdmin };

        const allowedPendingPaths = ['/tenants/me/provisioning-status', '/tenants/me/verify-checkout', '/tenants/me', '/auth/me', '/me/preferences'];
        const path = req.path;
        const isAllowedForPending =
          allowedPendingPaths.some((p) => path === p) ||
          (req.method === 'GET' && path === '/agents');
        if (!isAllowedForPending) {
          let tenantStatus = getCachedTenantStatus(tenantId);
          if (tenantStatus === null) {
            try {
              const pool = getPlatformPool();
              const { rows } = await pool.query(
                `SELECT status FROM tenants WHERE id = $1`,
                [tenantId],
              );
              tenantStatus = (rows[0]?.status as string) ?? 'unknown';
              setCachedTenantStatus(tenantId, tenantStatus);
            } catch (checkErr) {
              const correlationId = crypto.randomUUID();
              logger.error('Failed to check tenant status for pending gate', {
                error: String(checkErr),
                correlationId,
                tenantId,
                userId,
              });
              res.status(500).json({
                error: 'Unable to verify tenant status',
                correlationId,
              });
              return;
            }
          }
          if (tenantStatus === 'pending') {
            res.status(403).json({
              error: 'TENANT_NOT_PROVISIONED',
              message: 'Your account setup is not complete. Please finish checkout.',
            });
            return;
          }
        }

        requireTenantContext(req, res, next);
      })
      .catch((err) => {
        const correlationId = crypto.randomUUID();
        logger.error('Failed to resolve user role from DB', {
          error: String(err),
          correlationId,
          userId,
          tenantId,
        });
        res.status(500).json({
          error: 'Failed to verify authorization',
          correlationId,
        });
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
    // Explicit `algorithm: 'HS256'` keeps signing in lock-step with the
    // verifier's `algorithms: ['HS256']` allow-list above. (HS256 is also
    // the jsonwebtoken default, but pinning it here makes the contract
    // explicit and protects against future default changes.)
    { algorithm: 'HS256', expiresIn } as jwt.SignOptions,
  );
}
