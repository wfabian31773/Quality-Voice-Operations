// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

void React;

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('../../client-app/src/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  setToken: vi.fn(),
}));

vi.mock('../../client-app/src/lib/auth', () => ({
  useAuth: () => ({ user: null, initialized: true }),
}));

vi.mock('../../client-app/src/lib/analytics', () => ({
  trackPageView: vi.fn(),
  trackCTAClick: vi.fn(),
  trackConversionEvent: vi.fn(),
  trackSignupConversion: vi.fn(),
  captureUtmOnLoad: vi.fn(),
  getVisitorId: () => 'visitor-test',
}));

import '../../client-app/src/lib/i18n';
import Signup from '../../client-app/src/pages/public/Signup';

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderSignup() {
  return render(
    <MemoryRouter initialEntries={['/signup']}>
      <Routes>
        <Route path="/signup" element={<Signup />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Signup CAPTCHA gating', () => {
  it('renders the Turnstile slot when a site key is available', async () => {
    apiGet.mockResolvedValue({ captchaRequired: true, siteKey: '0xpublic-site-key' });
    renderSignup();
    expect(await screen.findByTestId('signup-captcha-slot')).toBeTruthy();
    expect(screen.queryByTestId('signup-captcha-unavailable')).toBeNull();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /start free trial/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('fails closed with a clear message when captcha is required but no site key exists', async () => {
    apiGet.mockResolvedValue({ captchaRequired: true, siteKey: null });
    renderSignup();
    expect(await screen.findByTestId('signup-captcha-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('signup-captcha-slot')).toBeNull();
    expect((screen.getByRole('button', { name: /start free trial/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('allows the documented local/dev bypass when captcha is not required', async () => {
    apiGet.mockResolvedValue({ captchaRequired: false, siteKey: null });
    renderSignup();
    await waitFor(() => {
      expect(screen.queryByTestId('signup-captcha-unavailable')).toBeNull();
      expect(screen.queryByTestId('signup-captcha-slot')).toBeNull();
      expect((screen.getByRole('button', { name: /start free trial/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
