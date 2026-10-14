import { describe, it, expect } from 'vitest';

import {
  parseSignupCaptchaConfig,
  resolveCaptchaConfigAfterFetchFailure,
} from '../../client-app/src/lib/signupCaptcha';

describe('parseSignupCaptchaConfig', () => {
  it('uses the runtime site key and required flag from a well-formed payload', () => {
    expect(parseSignupCaptchaConfig(
      { captchaRequired: true, siteKey: '0xpublic' },
      'vite-fallback',
    )).toEqual({ captchaRequired: true, siteKey: '0xpublic' });
  });

  it('falls back to the build-time site key when the server omits one', () => {
    expect(parseSignupCaptchaConfig(
      { captchaRequired: true, siteKey: null },
      'vite-fallback',
    )).toEqual({ captchaRequired: true, siteKey: 'vite-fallback' });
  });

  it('treats unexpected payloads as captcha-optional with the build-time key', () => {
    expect(parseSignupCaptchaConfig([], '')).toEqual({
      captchaRequired: false,
      siteKey: '',
    });
    expect(parseSignupCaptchaConfig(null, 'vite-fallback')).toEqual({
      captchaRequired: false,
      siteKey: 'vite-fallback',
    });
  });
});

describe('resolveCaptchaConfigAfterFetchFailure', () => {
  it('fails closed on a production build when no site key is available', () => {
    expect(resolveCaptchaConfigAfterFetchFailure('', true)).toEqual({
      captchaRequired: true,
      siteKey: '',
    });
  });

  it('allows the documented local/dev bypass when no site key is available', () => {
    expect(resolveCaptchaConfigAfterFetchFailure('', false)).toEqual({
      captchaRequired: false,
      siteKey: '',
    });
  });

  it('still requires a token when a build-time site key exists', () => {
    expect(resolveCaptchaConfigAfterFetchFailure('0xpublic', false)).toEqual({
      captchaRequired: true,
      siteKey: '0xpublic',
    });
  });
});
