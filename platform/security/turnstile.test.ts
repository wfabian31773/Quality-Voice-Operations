import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));

vi.mock('../core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: log.warn, error: log.error }),
}));

import {
  TURNSTILE_ACTIONS,
  TURNSTILE_CAPTCHA_FAILED_ERROR,
  parseTurnstileAllowedHostnames,
  resetTurnstileHostnameAllowListWarning,
  verifyTurnstile,
} from './turnstile';

describe('parseTurnstileAllowedHostnames', () => {
  it('treats unset or blank input as an empty allow-list (no hostname check)', () => {
    expect(parseTurnstileAllowedHostnames(undefined)).toEqual([]);
    expect(parseTurnstileAllowedHostnames('')).toEqual([]);
    expect(parseTurnstileAllowedHostnames('  , ; ')).toEqual([]);
  });

  it('parses a comma-separated list and strips a trailing DNS dot', () => {
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
  const originalRender = process.env.RENDER;
  const originalAppEnv = process.env.APP_ENV;
  const originalReplitDomain = process.env.REPLIT_DEV_DOMAIN;
  const originalReplId = process.env.REPL_ID;

  beforeEach(() => {
    process.env.TURNSTILE_SECRET_KEY = 'test-turnstile-secret';
    process.env.APP_ENV = 'development';
    delete process.env.TURNSTILE_ALLOWED_HOSTNAMES;
    delete process.env.RENDER;
    delete process.env.REPLIT_DEV_DOMAIN;
    delete process.env.REPL_ID;
    resetTurnstileHostnameAllowListWarning();
    log.warn.mockReset();
    log.error.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = originalSecret;
    if (originalHosts === undefined) delete process.env.TURNSTILE_ALLOWED_HOSTNAMES;
    else process.env.TURNSTILE_ALLOWED_HOSTNAMES = originalHosts;
    if (originalRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = originalRender;
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    if (originalReplitDomain === undefined) delete process.env.REPLIT_DEV_DOMAIN;
    else process.env.REPLIT_DEV_DOMAIN = originalReplitDomain;
    if (originalReplId === undefined) delete process.env.REPL_ID;
    else process.env.REPL_ID = originalReplId;
  });

  function mockSiteverify(body: Record<string, unknown>): void {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  const okOpts = {
    token: 'ok-token',
    ip: '203.0.113.10',
    expectedAction: TURNSTILE_ACTIONS.signup,
  };

  it('accepts a matching hostname and action when the allow-list is set', async () => {
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'qualityvoiceoperations.com,api.qualityvoiceoperations.com';
    mockSiteverify({
      success: true,
      hostname: 'qualityvoiceoperations.com',
      action: TURNSTILE_ACTIONS.signup,
    });

    await expect(verifyTurnstile(okOpts)).resolves.toEqual({ ok: true });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('rejects a hostname outside TURNSTILE_ALLOWED_HOSTNAMES with the failed-captcha error', async () => {
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'qualityvoiceoperations.com';
    mockSiteverify({
      success: true,
      hostname: 'evil.example',
      action: TURNSTILE_ACTIONS.signup,
    });

    const result = await verifyTurnstile(okOpts);

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'hostname_mismatch',
      error: TURNSTILE_CAPTCHA_FAILED_ERROR,
    });
    expect(log.warn).toHaveBeenCalledWith('Turnstile verification rejected', expect.objectContaining({
      reason: 'hostname_mismatch',
      hostname: 'evil.example',
      expectedAction: TURNSTILE_ACTIONS.signup,
    }));
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toContain('ok-token');
    expect(logged).not.toContain('test-turnstile-secret');
  });

  it('rejects when the returned action does not match the form with the failed-captcha error', async () => {
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'api.qualityvoiceoperations.com';
    mockSiteverify({
      success: true,
      hostname: 'api.qualityvoiceoperations.com',
      action: TURNSTILE_ACTIONS.signup,
    });

    const result = await verifyTurnstile({
      ...okOpts,
      expectedAction: TURNSTILE_ACTIONS.bookDemo,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'action_mismatch',
      error: TURNSTILE_CAPTCHA_FAILED_ERROR,
    });
    expect(log.warn).toHaveBeenCalledWith('Turnstile verification rejected', expect.objectContaining({
      reason: 'action_mismatch',
      action: TURNSTILE_ACTIONS.signup,
      expectedAction: TURNSTILE_ACTIONS.bookDemo,
    }));
  });

  it('accepts any hostname when TURNSTILE_ALLOWED_HOSTNAMES is unset, and warns once', async () => {
    mockSiteverify({
      success: true,
      hostname: 'localhost',
      action: TURNSTILE_ACTIONS.signup,
    });

    await expect(verifyTurnstile(okOpts)).resolves.toEqual({ ok: true });
    await expect(verifyTurnstile(okOpts)).resolves.toEqual({ ok: true });

    const allowListWarnings = log.warn.mock.calls.filter(([message]) =>
      String(message).includes('TURNSTILE_ALLOWED_HOSTNAMES is unset'),
    );
    expect(allowListWarnings).toHaveLength(1);
  });

  it('rejects any hostname in production-like environments when TURNSTILE_ALLOWED_HOSTNAMES is unset', async () => {
    process.env.APP_ENV = 'production';
    mockSiteverify({
      success: true,
      hostname: 'qualityvoiceoperations.com',
      action: TURNSTILE_ACTIONS.signup,
    });

    const result = await verifyTurnstile(okOpts);
    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'hostname_mismatch',
      error: TURNSTILE_CAPTCHA_FAILED_ERROR,
    });
    expect(log.warn).toHaveBeenCalledWith('Turnstile verification rejected', expect.objectContaining({
      reason: 'hostname_mismatch',
      hostnameAllowListUnset: true,
    }));
  });

  it('accepts any hostname on Replit production when TURNSTILE_ALLOWED_HOSTNAMES is unset', async () => {
    process.env.APP_ENV = 'production';
    process.env.REPLIT_DEV_DOMAIN = 'x.replit.dev';
    mockSiteverify({
      success: true,
      hostname: 'x.replit.dev',
      action: TURNSTILE_ACTIONS.signup,
    });

    await expect(verifyTurnstile(okOpts)).resolves.toEqual({ ok: true });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('TURNSTILE_ALLOWED_HOSTNAMES is unset'));
  });

  it('rejects any hostname on Render when TURNSTILE_ALLOWED_HOSTNAMES is unset', async () => {
    process.env.RENDER = 'true';
    mockSiteverify({
      success: true,
      hostname: 'qualityvoiceoperations.com',
      action: TURNSTILE_ACTIONS.signup,
    });

    const result = await verifyTurnstile(okOpts);
    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'hostname_mismatch',
      error: TURNSTILE_CAPTCHA_FAILED_ERROR,
    });
    expect(log.warn).toHaveBeenCalledWith('Turnstile verification rejected', expect.objectContaining({
      reason: 'hostname_mismatch',
      hostnameAllowListUnset: true,
    }));
  });

  it('still rejects a wrong action when the hostname allow-list is unset', async () => {
    mockSiteverify({
      success: true,
      hostname: 'localhost',
      action: TURNSTILE_ACTIONS.bookDemo,
    });

    const result = await verifyTurnstile(okOpts);
    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'action_mismatch',
      error: TURNSTILE_CAPTCHA_FAILED_ERROR,
    });
  });

  it('accepts a hostname from TURNSTILE_ALLOWED_HOSTNAMES', async () => {
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
    expect(log.warn).toHaveBeenCalledWith('Turnstile verification rejected', expect.objectContaining({
      reason: 'missing_token',
      expectedAction: TURNSTILE_ACTIONS.bookDemo,
    }));
  });

  it('rejects success:false and logs the error codes without the token or secret', async () => {
    mockSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });

    const result = await verifyTurnstile({
      token: 'sensitive-token',
      ip: '203.0.113.10',
      expectedAction: TURNSTILE_ACTIONS.signup,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'verification_failed',
      error: TURNSTILE_CAPTCHA_FAILED_ERROR,
    });
    expect(log.warn).toHaveBeenCalledWith('Turnstile verification rejected', {
      reason: 'verification_failed',
      expectedAction: TURNSTILE_ACTIONS.signup,
      hostname: undefined,
      action: undefined,
      errorCodes: ['timeout-or-duplicate'],
    });
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toContain('sensitive-token');
    expect(logged).not.toContain('test-turnstile-secret');
  });

  it('logs the returned hostname and action on a mismatch without the token', async () => {
    process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'qualityvoiceoperations.com';
    mockSiteverify({
      success: true,
      hostname: 'evil.example',
      action: TURNSTILE_ACTIONS.signup,
    });

    await verifyTurnstile({
      token: 'sensitive-token',
      ip: '203.0.113.10',
      expectedAction: TURNSTILE_ACTIONS.bookDemo,
    });

    expect(log.warn).toHaveBeenCalledWith('Turnstile verification rejected', {
      reason: 'hostname_mismatch',
      expectedAction: TURNSTILE_ACTIONS.bookDemo,
      hostname: 'evil.example',
      action: TURNSTILE_ACTIONS.signup,
      errorCodes: undefined,
    });
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toContain('sensitive-token');
  });

  it('fails closed when the siteverify request rejects', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await verifyTurnstile({
      token: 'sensitive-token',
      ip: '203.0.113.10',
      expectedAction: TURNSTILE_ACTIONS.bookDemo,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      reason: 'verification_failed',
      error: TURNSTILE_CAPTCHA_FAILED_ERROR,
    });
    expect(log.error).toHaveBeenCalledWith('Turnstile verification failed', {
      reason: 'verification_failed',
      expectedAction: TURNSTILE_ACTIONS.bookDemo,
      error: 'Error: network down',
    });
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain('sensitive-token');
    expect(logged).not.toContain('test-turnstile-secret');
  });
});
