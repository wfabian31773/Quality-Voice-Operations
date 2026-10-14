import '../styles/tw-public.css';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useState, type FormEvent } from 'react';
import { useAuth, type MfaLoginFlow } from '../lib/auth';
import { setToken } from '../lib/api';
import { LogIn } from 'lucide-react';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { safeRedirect } from '../lib/safeRedirect';
import PlatformAdminMfaFlow from '../components/PlatformAdminMfaFlow';

/**
 * `next` is the canonical "where were you headed?" query parameter that
 * `<ProtectedRoute>` and the API 401-recovery path use today (Task #1513).
 * `redirectTo` is the legacy name; we keep accepting it so any in-flight
 * deep links bookmarked before the rename still work.
 */
function readPostLoginTarget(searchParams: URLSearchParams): string | null {
  return searchParams.get('next') ?? searchParams.get('redirectTo');
}

function signupHref(searchParams: URLSearchParams): string {
  const next = new URLSearchParams(searchParams);
  next.delete('mode');
  next.delete('cancelled');
  const qs = next.toString();
  return qs ? `/signup?${qs}` : '/signup';
}

export default function Login() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(searchParams.get('cancelled') ? t('auth.checkout_cancelled') : '');
  const [loading, setLoading] = useState(false);
  const [mfaFlow, setMfaFlow] = useState<MfaLoginFlow | null>(null);
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

  // The login page used to own an inline signup form that posted to
  // /auth/signup without a CAPTCHA token. Send visitors to the real
  // /signup route (and keep ?plan= / ?interval= query params).
  if (searchParams.get('mode') === 'signup') {
    return <Navigate to={signupHref(searchParams)} replace />;
  }

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const flow = await login(email, password);
      if (flow) {
        setMfaFlow(flow);
        return;
      }
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

  const completeMfaLogin = (token: string) => {
    setToken(token);
    useAuth.getState().checkAuth();
    const currentUser = useAuth.getState().user;
    navigate(currentUser ? destinationFor(currentUser) : '/admin/dashboard');
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
              <LogIn className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-bold text-text-primary font-display">{t('auth.brand_title')}</h1>
            <p className="text-sm text-text-secondary mt-1">
              {t('auth.sign_in_subtitle')}
            </p>
          </div>

          {mfaFlow ? (
            <PlatformAdminMfaFlow
              mode={mfaFlow.mode}
              flowToken={mfaFlow.flowToken}
              onComplete={completeMfaLogin}
            />
          ) : <form
            onSubmit={handleLogin}
            className="bg-surface rounded-xl border border-border p-6 space-y-4 shadow-sm"
          >
            {error && (
              <div className="bg-danger-light text-danger text-sm px-3 py-2 rounded-lg">
                {error}
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
                <Link
                  to="/forgot-password"
                  className="text-xs text-primary hover:underline font-medium"
                >
                  {t('auth.forgot_password_link')}
                </Link>
              </div>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
                placeholder={t('auth.password_placeholder')}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:opacity-50"
            >
              {loading ? t('auth.signing_in') : t('auth.sign_in_button')}
            </button>

            <div className="text-center text-sm text-text-secondary pt-1">
              {t('auth.no_account')}{' '}
              <Link to={signupHref(searchParams)} className="text-primary hover:underline font-medium">
                {t('auth.sign_up_link')}
              </Link>
            </div>
          </form>}
        </div>
      </div>
    </div>
  );
}
