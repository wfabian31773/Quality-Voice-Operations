import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TURNSTILE_ALLOWED_HOSTNAMES,
  TURNSTILE_ACTIONS,
  parseTurnstileAllowedHostnames,
  verifyTurnstile,
} from './turnstile';

describe('parseTurnstileAllowedHostnames', () => {
  it('defaults to the QVO apex plus api. and voice. subdomains', () => {
    expect(parseTurnstileAllowedHostnames(undefined)).toEqual([
      'qualityvoiceoperations.com',
      'api.qualityvoiceoperations.com',
      'voice.qualityvoiceoperations.com',
    ]);
    expect(parseTurnstileAllowedHostnames('')).toEqual([...DEFAULT_TURNSTILE_ALLOWED_HOSTNAMES]);
  });

  it('replaces the default list when an env list is set', () => {
    expect(parseTurnstileAllowedHostnames('localhost, preview.example.com.')).toEqual([
      'localhost',
      'preview.example.com',
    ]);
  });
});

describe('verifyTurnstile', () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.TURNSTILE_SECRET_KEY;
  const originalHosts = process.env.TURNSTILE_ALLOWED_HOSTNAMES;

  beforeEach(() => {
    process.env.TURNSTILE_SECRET_KEY = 'test-turnstile-secret';
    delete process.env.TURNSTILE_ALLOWED_HOSTNAMES;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = originalSecret;
    if (originalHosts === undefined) delete process.env.TURNSTILE_ALLOWED_HOSTNAMES;
    else process.env.TURNSTILE_ALLOWED_HOSTNAMES = originalHosts;
  });

  function mockSiteverify(body: Record<string, unknown>): void {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  it('accepts a matching hostname and action', async () => {
    mockSiteverify({
      success: true,
      hostname: 'qualityvoiceoperations.com',
      action: TURNSTILE_ACTIONS.signup,
    });

    await expect(verifyTurnstile({
      token: 'ok-token',
      ip: '203.0.113.10',
      expectedAction: TURNSTILE_ACTIONS.signup,
    })).resolves.toEqual({ ok: true });
  });

  it('rejects a hostname outside the allowed QVO list', async () => {
    mockSiteverify({
      success: true,
      hostname: 'evil.example',
      action: TURNSTILE_ACTIONS.signup,
    });

    const result = await verifyTurnstile({
      token: 'ok-token',
      ip: '203.0.113.10',
      expectedAction: TURNSTILE_ACTIONS.signup,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'hostname_mismatch',
      error: 'CAPTCHA hostname is not allowed for this form',
    });
  });

  it('rejects when the returned action does not match the form', async () => {
    mockSiteverify({
      success: true,
      hostname: 'api.qualityvoiceoperations.com',
      action: TURNSTILE_ACTIONS.signup,
    });

    const result = await verifyTurnstile({
      token: 'ok-token',
      ip: '203.0.113.10',
      expectedAction: TURNSTILE_ACTIONS.bookDemo,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'action_mismatch',
      error: 'CAPTCHA action does not match this form',
    });
  });

  it('accepts a hostname from TURNSTILE_ALLOWED_HOSTNAMES instead of the default list', async () => {
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'localhost,preview.qualityvoiceoperations.com';
    mockSiteverify({
      success: true,
      hostname: 'localhost',
      action: TURNSTILE_ACTIONS.bookDemo,
    });

    await expect(verifyTurnstile({
      token: 'ok-token',
      ip: '127.0.0.1',
      expectedAction: TURNSTILE_ACTIONS.bookDemo,
    })).resolves.toEqual({ ok: true });
  });

  it('rejects a missing token when the secret is configured', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await verifyTurnstile({
      token: undefined,
      ip: '203.0.113.10',
      expectedAction: TURNSTILE_ACTIONS.bookDemo,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'missing_token',
      error: 'CAPTCHA verification is required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
