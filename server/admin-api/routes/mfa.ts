import { Router } from 'express';
import { getPlatformPool } from '../../../platform/db';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import { createRateLimiter } from '../../../platform/infra/rate-limit/createRateLimiter';
import { authAttemptRateLimitMax } from '../../../platform/security/authAttemptRateLimit';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotpStep,
  verifyRecoveryCode,
} from '../../../platform/security/TotpMfa';
import {
  issueToken,
  verifyMfaFlowToken,
  type MfaFlowIdentity,
  type MfaFlowPurpose,
} from '../middleware/auth';
import { authCookieOptions } from '../middleware/security';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('PLATFORM_ADMIN_MFA');
const SETUP_EXPIRY_MINUTES = 10;
const LOCK_AFTER_FAILURES = 5;
const LOCK_MINUTES = 15;

const mfaRateLimit = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: authAttemptRateLimitMax(),
  message: 'Too many MFA attempts. Please wait before trying again.',
  keyGenerator: (req) => `${req.ip ?? req.socket?.remoteAddress ?? 'unknown'}:${req.path}`,
});

function readFlowToken(body: unknown, key: 'mfaSetupToken' | 'mfaChallengeToken'): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length >= 20 && value.length <= 4096 ? value : null;
}

function verifyFlow(body: unknown, key: 'mfaSetupToken' | 'mfaChallengeToken', purpose: MfaFlowPurpose): MfaFlowIdentity | null {
  const token = readFlowToken(body, key);
  if (!token) return null;
  try {
    return verifyMfaFlowToken(token, purpose);
  } catch {
    return null;
  }
}

function issueVerifiedSession(identity: MfaFlowIdentity): string {
  return issueToken({
    ...identity,
    isPlatformAdmin: true,
    mfaVerified: true,
  });
}

router.post('/auth/mfa/setup/start', mfaRateLimit, async (req, res) => {
  const identity = verifyFlow(req.body, 'mfaSetupToken', 'mfa_setup');
  if (!identity) return res.status(401).json({ error: 'Invalid or expired MFA setup session' });

  const client = await getPlatformPool().connect();
  try {
    const { rows } = await client.query(
      `SELECT is_platform_admin, mfa_enabled_at
       FROM users
       WHERE id = $1 AND lower(email) = lower($2)
       LIMIT 1`,
      [identity.userId, identity.email],
    );
    if (rows.length !== 1 || rows[0].is_platform_admin !== true) {
      return res.status(403).json({ error: 'Platform-admin enrollment is not authorized' });
    }
    if (rows[0].mfa_enabled_at) {
      return res.status(409).json({ error: 'MFA is already enabled' });
    }

    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    const expiresAt = new Date(Date.now() + SETUP_EXPIRY_MINUTES * 60_000);
    await client.query(
      `UPDATE users
       SET mfa_pending_totp_secret_encrypted = $1,
           mfa_pending_expires_at = $2,
           updated_at = NOW()
       WHERE id = $3 AND lower(email) = lower($4) AND is_platform_admin = TRUE`,
      [encrypted, expiresAt, identity.userId, identity.email],
    );

    const label = `${encodeURIComponent('Quality Voice Operations')}:${encodeURIComponent(identity.email)}`;
    const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Quality Voice Operations')}&algorithm=SHA1&digits=6&period=30`;

    await writeAuditLog({
      tenantId: identity.tenantId,
      actorUserId: identity.userId,
      actorRole: identity.role,
      action: 'platform_admin.mfa_setup_started',
      resourceType: 'user',
      resourceId: identity.userId,
      changes: { expiresAt: expiresAt.toISOString() },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ secret, otpauthUri, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    logger.error('Failed to start platform-admin MFA setup', { userId: identity.userId, error: String(error) });
    return res.status(500).json({ error: 'Unable to start MFA setup' });
  } finally {
    client.release();
  }
});

router.post('/auth/mfa/setup/confirm', mfaRateLimit, async (req, res) => {
  const identity = verifyFlow(req.body, 'mfaSetupToken', 'mfa_setup');
  const code = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).code : undefined;
  if (!identity) return res.status(401).json({ error: 'Invalid or expired MFA setup session' });
  if (typeof code !== 'string' || !/^\d{6}$/u.test(code)) {
    return res.status(400).json({ error: 'A six-digit authenticator code is required' });
  }

  const client = await getPlatformPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, email, is_platform_admin, mfa_enabled_at,
              mfa_pending_totp_secret_encrypted, mfa_pending_expires_at
       FROM users
       WHERE id = $1 AND lower(email) = lower($2) AND is_platform_admin = TRUE
       FOR UPDATE`,
      [identity.userId, identity.email],
    );
    const user = rows[0];
    if (!user || user.mfa_enabled_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: user ? 'MFA is already enabled' : 'Platform-admin enrollment is not authorized' });
    }
    if (!user.mfa_pending_totp_secret_encrypted || !user.mfa_pending_expires_at
      || new Date(user.mfa_pending_expires_at as string).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'MFA setup has expired; start again' });
    }

    const secret = decryptTotpSecret(user.mfa_pending_totp_secret_encrypted as string);
    const setupStep = matchTotpStep(secret, code);
    if (setupStep === null) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Invalid authenticator code' });
    }

    const recoveryCodes = generateRecoveryCodes();
    const recoveryHashes = recoveryCodes.map(hashRecoveryCode);
    await client.query(
      `UPDATE users
       SET mfa_totp_secret_encrypted = mfa_pending_totp_secret_encrypted,
           mfa_pending_totp_secret_encrypted = NULL,
           mfa_pending_expires_at = NULL,
           mfa_enabled_at = NOW(),
           mfa_recovery_code_hashes = $1,
           mfa_last_totp_step = $2,
           mfa_failed_attempts = 0,
           mfa_locked_until = NULL,
           mfa_last_verified_at = NOW(),
           last_login_at = NOW(),
           updated_at = NOW()
       WHERE id = $3`,
      [recoveryHashes, setupStep.toString(), identity.userId],
    );
    await client.query('COMMIT');

    const token = issueVerifiedSession(identity);
    res.cookie('auth_token', token, authCookieOptions());
    await writeAuditLog({
      tenantId: identity.tenantId,
      actorUserId: identity.userId,
      actorRole: identity.role,
      action: 'platform_admin.mfa_enabled',
      resourceType: 'user',
      resourceId: identity.userId,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ token, recoveryCodes });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to confirm platform-admin MFA setup', { userId: identity.userId, error: String(error) });
    return res.status(500).json({ error: 'Unable to enable MFA' });
  } finally {
    client.release();
  }
});

router.post('/auth/mfa/challenge', mfaRateLimit, async (req, res) => {
  const identity = verifyFlow(req.body, 'mfaChallengeToken', 'mfa_challenge');
  if (!identity) return res.status(401).json({ error: 'Invalid or expired MFA challenge' });
  const body = req.body as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code : null;
  const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode : null;
  if ((code ? 1 : 0) + (recoveryCode ? 1 : 0) !== 1) {
    return res.status(400).json({ error: 'Provide exactly one authenticator or recovery code' });
  }
  if (code && !/^\d{6}$/u.test(code)) return res.status(400).json({ error: 'Authenticator code must be six digits' });

  const client = await getPlatformPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, email, is_platform_admin, mfa_enabled_at,
              mfa_totp_secret_encrypted, mfa_recovery_code_hashes,
              mfa_last_totp_step, mfa_failed_attempts, mfa_locked_until
       FROM users
       WHERE id = $1 AND lower(email) = lower($2) AND is_platform_admin = TRUE
       FOR UPDATE`,
      [identity.userId, identity.email],
    );
    const user = rows[0];
    if (!user?.mfa_enabled_at || !user.mfa_totp_secret_encrypted) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Platform-admin MFA is not enabled' });
    }
    if (user.mfa_locked_until && new Date(user.mfa_locked_until as string).getTime() > Date.now()) {
      await client.query('ROLLBACK');
      return res.status(423).json({ error: 'MFA is temporarily locked; try again later' });
    }

    let matchedStep: bigint | null = null;
    let remainingRecoveryHashes: string[] | null = null;
    if (code) {
      matchedStep = matchTotpStep(decryptTotpSecret(user.mfa_totp_secret_encrypted as string), code);
      const lastStep = user.mfa_last_totp_step === null ? null : BigInt(user.mfa_last_totp_step as string);
      if (matchedStep !== null && lastStep !== null && matchedStep <= lastStep) matchedStep = null;
    } else if (recoveryCode) {
      const hashes = (user.mfa_recovery_code_hashes as string[] | null) ?? [];
      const index = hashes.findIndex((hash) => verifyRecoveryCode(recoveryCode, hash));
      if (index >= 0) remainingRecoveryHashes = hashes.filter((_, itemIndex) => itemIndex !== index);
    }

    if (matchedStep === null && remainingRecoveryHashes === null) {
      await client.query(
        `UPDATE users
         SET mfa_failed_attempts = mfa_failed_attempts + 1,
             mfa_locked_until = CASE
               WHEN mfa_failed_attempts + 1 >= $1 THEN NOW() + ($2 * INTERVAL '1 minute')
               ELSE NULL
             END,
             updated_at = NOW()
         WHERE id = $3`,
        [LOCK_AFTER_FAILURES, LOCK_MINUTES, identity.userId],
      );
      await client.query('COMMIT');
      return res.status(401).json({ error: 'Invalid or previously used MFA code' });
    }

    if (remainingRecoveryHashes !== null) {
      await client.query(
        `UPDATE users
         SET mfa_recovery_code_hashes = $1,
             mfa_failed_attempts = 0,
             mfa_locked_until = NULL,
             mfa_last_verified_at = NOW(),
             last_login_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [remainingRecoveryHashes, identity.userId],
      );
    } else {
      await client.query(
        `UPDATE users
         SET mfa_last_totp_step = $1,
             mfa_failed_attempts = 0,
             mfa_locked_until = NULL,
             mfa_last_verified_at = NOW(),
             last_login_at = NOW(),
             updated_at = NOW()
         WHERE id = $2`,
        [matchedStep!.toString(), identity.userId],
      );
    }
    await client.query('COMMIT');

    const token = issueVerifiedSession(identity);
    res.cookie('auth_token', token, authCookieOptions());
    await writeAuditLog({
      tenantId: identity.tenantId,
      actorUserId: identity.userId,
      actorRole: identity.role,
      action: remainingRecoveryHashes === null
        ? 'platform_admin.mfa_verified'
        : 'platform_admin.mfa_recovery_code_used',
      resourceType: 'user',
      resourceId: identity.userId,
      changes: remainingRecoveryHashes === null ? undefined : { recoveryCodesRemaining: remainingRecoveryHashes.length },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json({ token });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Platform-admin MFA challenge failed', { userId: identity.userId, error: String(error) });
    return res.status(500).json({ error: 'Unable to verify MFA' });
  } finally {
    client.release();
  }
});

export default router;
