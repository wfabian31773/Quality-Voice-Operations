import jwt from 'jsonwebtoken';

export const STUDIO_PREVIEW_AUDIENCE = 'qvo-studio-preview';
export const STUDIO_PREVIEW_PURPOSE = 'studio_preview';
export const STUDIO_PREVIEW_TTL_SECONDS = 10 * 60;

export interface StudioPreviewClaims {
  tenantId: string;
  agentId: string;
  userId: string;
}

function previewSecret(): string {
  return process.env.ADMIN_JWT_SECRET || `qvo-dev-jwt-${process.env.REPL_ID ?? 'local'}`;
}

export function signStudioPreviewToken(
  claims: StudioPreviewClaims,
  expiresInSeconds = STUDIO_PREVIEW_TTL_SECONDS,
  secret = previewSecret(),
): string {
  return jwt.sign(
    {
      sub: claims.userId,
      tenantId: claims.tenantId,
      agentId: claims.agentId,
      purpose: STUDIO_PREVIEW_PURPOSE,
    },
    secret,
    {
      algorithm: 'HS256',
      audience: STUDIO_PREVIEW_AUDIENCE,
      expiresIn: expiresInSeconds,
    },
  );
}

export function verifyStudioPreviewToken(
  token: string,
  secret = previewSecret(),
): StudioPreviewClaims | null {
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: STUDIO_PREVIEW_AUDIENCE,
    });
    if (!decoded || typeof decoded !== 'object') return null;
    const payload = decoded as jwt.JwtPayload;
    if (payload.purpose !== STUDIO_PREVIEW_PURPOSE) return null;
    if (typeof payload.tenantId !== 'string' || typeof payload.agentId !== 'string' || typeof payload.sub !== 'string') {
      return null;
    }
    return {
      tenantId: payload.tenantId,
      agentId: payload.agentId,
      userId: payload.sub,
    };
  } catch {
    return null;
  }
}

export function studioPreviewStreamPath(token: string): string {
  return `/vg/studio/stream?token=${encodeURIComponent(token)}`;
}
