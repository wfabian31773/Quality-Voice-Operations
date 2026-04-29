/**
 * Helpers for translating OAuth-init failures from `/connectors/oauth/<provider>/init`
 * into structured, user-friendly configuration messages on the Connectors page.
 *
 * Two distinct configuration errors come back from the server:
 *
 *   1. `OAUTH_NOT_CONFIGURED` (HTTP 400) — the per-provider OAuth client
 *      credentials (e.g. `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET`) are
 *      not set on the server. The response body includes `providerLabel`,
 *      `missingEnv`, and `docsUrl`.
 *
 *   2. `OAUTH_STATE_SECRET_NOT_CONFIGURED` (HTTP 500, added in Task #621) —
 *      the server has neither `ADMIN_JWT_SECRET` nor `CONNECTOR_ENCRYPTION_KEY`
 *      configured, so the OAuth state token can't be signed. The response
 *      body includes `code`, `missingEnv: 'ADMIN_JWT_SECRET'`, and `error`,
 *      but does NOT include a per-provider label or docs URL — this is a
 *      platform-wide misconfiguration, not a per-provider one.
 */

export type OAuthNotConfiguredKind = 'oauth_client' | 'state_secret';

export interface OAuthNotConfigured {
  kind: OAuthNotConfiguredKind;
  providerLabel: string;
  missingEnv: string;
  docsUrl: string;
}

interface InitErrorBody {
  code?: string;
  providerLabel?: string;
  missingEnv?: string;
  docsUrl?: string;
}

/**
 * Inspect a thrown init error and return a structured configuration message
 * if the failure is one of the two known "not configured" cases. Returns
 * `null` for any other error (callers should surface those as a generic
 * failure message).
 */
export function parseOAuthNotConfigured(
  err: unknown,
  fallback: { providerLabel: string; docsUrl?: string },
): OAuthNotConfigured | null {
  if (!err || typeof err !== 'object') return null;
  const body = (err as { body?: InitErrorBody }).body;
  if (!body || typeof body !== 'object') return null;

  if (body.code === 'OAUTH_NOT_CONFIGURED') {
    return {
      kind: 'oauth_client',
      providerLabel: body.providerLabel || fallback.providerLabel,
      missingEnv: body.missingEnv || '',
      docsUrl: body.docsUrl || fallback.docsUrl || '',
    };
  }

  if (body.code === 'OAUTH_STATE_SECRET_NOT_CONFIGURED') {
    return {
      kind: 'state_secret',
      providerLabel: fallback.providerLabel,
      missingEnv: body.missingEnv || 'ADMIN_JWT_SECRET',
      docsUrl: fallback.docsUrl || '',
    };
  }

  return null;
}
