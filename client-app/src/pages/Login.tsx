import '../styles/tw-public.css';
import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/auth';
import { api, setToken } from '../lib/api';
import { LogIn, UserPlus } from 'lucide-react';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { safeRedirect } from '../lib/safeRedirect';

/**
 * `next` is the canonical "where were you headed?" query parameter that
 * `<ProtectedRoute>` and the API 401-recovery path use today (Task #1513).
 * `redirectTo` is the legacy name; we keep accepting it so any in-flight
 * deep links bookmarked before the rename still work.
 */
function readPostLoginTarget(searchParams: URLSearchParams): string | null {
  return searchParams.get('next') ?? searchParams.get('redirectTo');
}

export default function Login() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<'login' | 'signup'>(
    searchParams.get('mode') === 'signup' ? 'signup' : 'login'
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [plan, setPlan] = useState(searchParams.get('plan') || 'starter');
  const [error, setError] = useState(searchParams.get('cancelled') ? t('auth.checkout_cancelled') : '');
  const [loading, setLoading] = useState(false);
  const { login, user } = useAuth();
  const navigate = useNavigate();

  function getLandingPath(u: { isPlatformAdmin?: boolean; role: string }) {
    if (u.isPlatformAdmin) return '/admin/dashboard';
    if (u.role === 'operations_manager') return '/ops/monitor';
    return '/dashboard';
  }

  // Task #1513 / BL-012: `next` (and the legacy `redirectTo`) is allowed
  // but is sanitized so an attacker can't weaponize a phishing link like
  // `/login?next=https://evil.com`. `safeRedirect` falls back to the
  // role-aware landing path whenever the value isn't a same-origin
  // relative path.
  function destinationFor(u: { isPlatformAdmin?: boolean; role: string }) {
    return safeRedirect(readPostLoginTarget(searchParams), getLandingPath(u));
  }

  if (user) {
    return <Navigate to={destinationFor(user)} replace />;
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      const currentUser = useAuth.getState().user;
      if (currentUser) {
        navigate(destinationFor(currentUser));
      } else {
        navigate(safeRedirect(readPostLoginTarget(searchParams), '/dashboard'));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth.login_failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post<{ checkoutUrl: string; token: string }>('/auth/signup', { name, email, password, plan });
      if (res.token) {
        setToken(res.token);
      }
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        setError(t('auth.checkout_init_failed'));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth.signup_failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-surface-secondary px-4">
      <div className="w-full flex justify-end pt-4">
        <LanguageSwitcher variant="muted" />
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary text-white mb-4">
              {mode === 'login' ? <LogIn className="h-6 w-6" /> : <UserPlus className="h-6 w-6" />}
            </div>
            <h1 className="text-2xl font-bold text-text-primary font-display">{t('auth.brand_title')}</h1>
            <p className="text-sm text-text-secondary mt-1">
              {mode === 'login' ? t('auth.sign_in_subtitle') : t('auth.sign_up_subtitle')}
            </p>
          </div>

          <form
            onSubmit={mode === 'login' ? handleLogin : handleSignup}
            className="bg-surface rounded-xl border border-border p-6 space-y-4 shadow-sm"
          >
            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 text-danger text-sm px-3 py-2 rounded-lg">
                {error}
              </div>
            )}

            {mode === 'signup' && (
              <div>
                <label htmlFor="login-company-name" className="block text-sm font-medium text-text-primary mb-1.5">{t('auth.company_name')}</label>
                <input
                  id="login-company-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                  placeholder={t('auth.company_name_placeholder')}
                />
              </div>
            )}

            <div>
              <label htmlFor="login-email" className="block text-sm font-medium text-text-primary mb-1.5">{t('auth.email')}</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                placeholder={t('auth.email_placeholder')}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="login-password" className="block text-sm font-medium text-text-primary">{t('auth.password')}</label>
                {mode === 'login' && (
                  <Link
                    to="/forgot-password"
                    className="text-xs text-primary hover:underline font-medium"
                  >
                    {t('auth.forgot_password_link')}
                  </Link>
                )}
              </div>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === 'signup' ? 8 : undefined}
                // F-5: tell the browser/password-manager which credential
                // form this field belongs to so it can autofill / save the
                // right value (and it silences the React DOM warning).
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                placeholder={mode === 'signup' ? t('auth.password_min_placeholder') : t('auth.password_placeholder')}
              />
            </div>

            {mode === 'signup' && (
              <div>
                <label htmlFor="login-plan" className="block text-sm font-medium text-text-primary mb-1.5">{t('auth.plan')}</label>
                <select
                  id="login-plan"
                  value={plan}
                  onChange={(e) => setPlan(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                >
                  <option value="starter">{t('auth.plan_starter')}</option>
                  <option value="pro">{t('auth.plan_pro')}</option>
                  <option value="enterprise">{t('auth.plan_enterprise')}</option>
                </select>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:opacity-50"
            >
              {loading
                ? mode === 'login'
                  ? t('auth.signing_in')
                  : t('auth.creating_account')
                : mode === 'login'
                  ? t('auth.sign_in_button')
                  : t('auth.sign_up_button')}
            </button>

            <div className="text-center text-sm text-text-secondary pt-1">
              {mode === 'login' ? (
                <>
                  {t('auth.no_account')}{' '}
                  <button type="button" onClick={() => { setMode('signup'); setError(''); }} className="text-primary hover:underline font-medium">
                    {t('auth.sign_up_link')}
                  </button>
                </>
              ) : (
                <>
                  {t('auth.have_account')}{' '}
                  <button type="button" onClick={() => { setMode('login'); setError(''); }} className="text-primary hover:underline font-medium">
                    {t('auth.sign_in_link')}
                  </button>
                </>
              )}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
