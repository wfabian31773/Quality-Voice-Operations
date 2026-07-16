// @vitest-environment happy-dom
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

void React;

const apiPost = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({ api: { post: apiPost } }));

import PlatformAdminMfaFlow from './PlatformAdminMfaFlow';

afterEach(cleanup);

beforeEach(() => {
  apiPost.mockReset();
});

describe('PlatformAdminMfaFlow', () => {
  it('enrolls an authenticator and requires recovery-code acknowledgement before completing', async () => {
    apiPost
      .mockResolvedValueOnce({
        secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        otpauthUri: 'otpauth://totp/Quality%20Voice%20Operations:user?secret=abc',
        expiresAt: '2026-07-13T23:59:00.000Z',
      })
      .mockResolvedValueOnce({ token: 'session-token', recoveryCodes: ['ABCDE-FGHIJ', 'KLMNO-PQRST'] });
    const onComplete = vi.fn();

    render(<PlatformAdminMfaFlow mode="setup" flowToken="setup-token-with-safe-length" onComplete={onComplete} />);

    expect(await screen.findByText('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/authenticator code/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /enable mfa/i }));

    expect(await screen.findByText('ABCDE-FGHIJ')).toBeTruthy();
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /saved these recovery codes/i }));
    expect(onComplete).toHaveBeenCalledWith('session-token');
  });

  it('completes an existing administrator challenge with a six-digit code', async () => {
    apiPost.mockResolvedValueOnce({ token: 'session-token' });
    const onComplete = vi.fn();
    render(<PlatformAdminMfaFlow mode="challenge" flowToken="challenge-token-with-safe-length" onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText(/authenticator code/i), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: /verify and sign in/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledWith('session-token'));
    expect(apiPost).toHaveBeenCalledWith('/auth/mfa/challenge', {
      mfaChallengeToken: 'challenge-token-with-safe-length',
      code: '654321',
    });
  });
});
