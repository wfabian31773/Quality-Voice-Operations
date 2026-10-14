// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router-dom';
import '../../client-app/src/lib/i18n';

void React;

vi.mock('../../client-app/src/lib/auth', () => {
  const state = { user: null, login: vi.fn(), checkAuth: vi.fn() };
  const useAuth = () => state;
  useAuth.getState = () => state;
  return { useAuth };
});

vi.mock('../../client-app/src/components/LanguageSwitcher', () => ({
  default: () => <div data-testid="language-switcher" />,
}));

vi.mock('../../client-app/src/components/PlatformAdminMfaFlow', () => ({
  default: () => null,
}));

import Login from '../../client-app/src/pages/Login';

afterEach(() => {
  cleanup();
});

function SignupStub() {
  const [params] = useSearchParams();
  return <div data-testid="signup-page">{params.toString()}</div>;
}

function renderLogin(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<SignupStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Login signup handoff', () => {
  it('redirects /login?mode=signup to /signup and keeps plan/interval', () => {
    renderLogin('/login?mode=signup&plan=pro&interval=annual');
    expect(screen.getByTestId('signup-page')).toBeTruthy();
    expect(screen.getByTestId('signup-page').textContent).toContain('plan=pro');
    expect(screen.getByTestId('signup-page').textContent).toContain('interval=annual');
    expect(screen.getByTestId('signup-page').textContent).not.toContain('mode=');
  });

  it('sends the Sign up link to /signup instead of an inline form', () => {
    renderLogin('/login');
    const link = screen.getByRole('link', { name: /sign up/i });
    expect((link as HTMLAnchorElement).getAttribute('href')).toBe('/signup');
    expect(screen.queryByLabelText(/company name/i)).toBeNull();
  });
});
