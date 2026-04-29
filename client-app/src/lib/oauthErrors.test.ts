/**
 * Regression suite for `parseOAuthNotConfigured`, the helper that translates
 * `/connectors/oauth/<provider>/init` failures into structured config-error
 * panels on the Connectors page.
 *
 * We particularly guard the `OAUTH_STATE_SECRET_NOT_CONFIGURED` branch
 * (added in Task #621): without it, tenant owners would see a generic
 * "something went wrong" toast on a misconfigured deployment instead of a
 * helpful "ask your platform admin to set ADMIN_JWT_SECRET" message.
 */
import { describe, expect, it } from 'vitest';

import { parseOAuthNotConfigured } from './oauthErrors';

const FALLBACK = { providerLabel: 'HubSpot', docsUrl: '/docs/connecting-hubspot' };

describe('parseOAuthNotConfigured', () => {
  it('returns null for non-object errors', () => {
    expect(parseOAuthNotConfigured(null, FALLBACK)).toBeNull();
    expect(parseOAuthNotConfigured(undefined, FALLBACK)).toBeNull();
    expect(parseOAuthNotConfigured('boom', FALLBACK)).toBeNull();
    expect(parseOAuthNotConfigured(42, FALLBACK)).toBeNull();
  });

  it('returns null when the error has no body', () => {
    expect(parseOAuthNotConfigured(new Error('network down'), FALLBACK)).toBeNull();
  });

  it('returns null for unrelated body codes', () => {
    expect(
      parseOAuthNotConfigured({ body: { code: 'SOMETHING_ELSE' } }, FALLBACK),
    ).toBeNull();
  });

  it('parses OAUTH_NOT_CONFIGURED with server-provided fields', () => {
    const result = parseOAuthNotConfigured(
      {
        body: {
          code: 'OAUTH_NOT_CONFIGURED',
          providerLabel: 'HubSpot CRM',
          missingEnv: 'HUBSPOT_CLIENT_ID',
          docsUrl: 'https://example.com/setup',
        },
      },
      FALLBACK,
    );
    expect(result).toEqual({
      kind: 'oauth_client',
      providerLabel: 'HubSpot CRM',
      missingEnv: 'HUBSPOT_CLIENT_ID',
      docsUrl: 'https://example.com/setup',
    });
  });

  it('falls back to caller-supplied label/docs for OAUTH_NOT_CONFIGURED when the server omits them', () => {
    const result = parseOAuthNotConfigured(
      { body: { code: 'OAUTH_NOT_CONFIGURED' } },
      FALLBACK,
    );
    expect(result).toEqual({
      kind: 'oauth_client',
      providerLabel: 'HubSpot',
      missingEnv: '',
      docsUrl: '/docs/connecting-hubspot',
    });
  });

  it('parses OAUTH_STATE_SECRET_NOT_CONFIGURED into a state_secret variant', () => {
    const result = parseOAuthNotConfigured(
      {
        body: {
          code: 'OAUTH_STATE_SECRET_NOT_CONFIGURED',
          missingEnv: 'ADMIN_JWT_SECRET',
          error: 'OAuth state signing secret not configured',
        },
      },
      FALLBACK,
    );
    expect(result).toEqual({
      kind: 'state_secret',
      providerLabel: 'HubSpot',
      missingEnv: 'ADMIN_JWT_SECRET',
      docsUrl: '/docs/connecting-hubspot',
    });
  });

  it('defaults missingEnv to ADMIN_JWT_SECRET if the server omits it', () => {
    const result = parseOAuthNotConfigured(
      { body: { code: 'OAUTH_STATE_SECRET_NOT_CONFIGURED' } },
      { providerLabel: 'Slack' },
    );
    expect(result).toEqual({
      kind: 'state_secret',
      providerLabel: 'Slack',
      missingEnv: 'ADMIN_JWT_SECRET',
      docsUrl: '',
    });
  });
});
