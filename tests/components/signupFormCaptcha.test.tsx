// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  delete (window as unknown as { turnstile?: unknown }).turnstile;
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

  it('does not require a token when a site key exists but the server skips verification', async () => {
    apiGet.mockResolvedValue({ captchaRequired: false, siteKey: '0xpublic-site-key' });
    apiPost.mockResolvedValue({ token: '', checkoutUrl: '' });
    renderSignup();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /start free trial/i }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(screen.queryByTestId('signup-captcha-slot')).toBeNull();

    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password1' } });
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect((apiPost.mock.calls[0][1] as { captchaToken?: string }).captchaToken).toBeUndefined();
  });

  it('resets the single-use Turnstile token after the server rejects a signup', async () => {
    let solve: (token: string) => void = () => {};
    const turnstile = {
      render: vi.fn((_el: HTMLElement, opts: Record<string, unknown>) => {
        solve = opts.callback as (token: string) => void;
        return 'widget-1';
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    (window as unknown as { turnstile?: unknown }).turnstile = turnstile;
    apiGet.mockResolvedValue({ captchaRequired: true, siteKey: '0xpublic-site-key' });
    apiPost.mockRejectedValue(new Error('An account with this email already exists'));
    renderSignup();

    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1));
    solve('token-1');

    fireEvent.change(screen.getByLabelText(/organization name/i), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'password1' } });
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }));

    expect(await screen.findByText(/already exists/i)).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect((apiPost.mock.calls[0][1] as { captchaToken?: string }).captchaToken).toBe('token-1');
    expect(turnstile.reset).toHaveBeenCalledWith('widget-1');

    // Retrying without re-solving must not resubmit the consumed token.
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }));
    expect(await screen.findByText(/complete the CAPTCHA/i)).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});
