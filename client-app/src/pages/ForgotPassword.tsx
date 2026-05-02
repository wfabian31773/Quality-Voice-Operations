import '../styles/tw-public.css';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KeyRound, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import LanguageSwitcher from '../components/LanguageSwitcher';

/**
 * `/forgot-password` (Task #1513).
 *
 * Two modes on a single route, switched by the presence of a `?token=…`
 * search param (which is what the recovery email's CTA carries):
 *
 *  - Request mode (no token): single email field, submits to
 *    POST /auth/forgot-password. The backend always responds 200 with
 *    the same generic body so this page can't be used as an account-
 *    enumeration oracle, so the success copy is intentionally vague.
 *
 *  - Redeem mode (token present): "set a new password" form, submits to
 *    POST /auth/reset-password. On success we navigate the user to
 *    /login so they exercise the full login pipeline (audit log,
 *    last_login_at, role-based landing) with the freshly-set password.
 */
export default function ForgotPassword() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  if (token) {
    return <ResetPasswordForm token={token} />;
  }
  return <RequestRecoveryForm t={t} />;
}

function RequestRecoveryForm({ t }: { t: (k: string) => string }) {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSubmitted(true);
    } catch (err: unknown) {
      // The backend swallows "user not found" into a 200, so a non-2xx
      // here genuinely means something is wrong (validation, network,
      // outage). Surface it instead of pretending we sent a link.
      setError(err instanceof Error ? err.message : t('auth.forgot_password_failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Shell
      icon={submitted ? <CheckCircle2 className="h-6 w-6" /> : <KeyRound className="h-6 w-6" />}
      title={submitted ? t('auth.forgot_password_sent_title') : t('auth.forgot_password_title')}
      subtitle={submitted ? t('auth.forgot_password_sent_subtitle') : t('auth.forgot_password_subtitle')}
    >
      {submitted ? (
        <div className="bg-surface rounded-xl border border-border p-6 space-y-4 shadow-sm text-sm text-text-secondary">
          <p>{t('auth.forgot_password_sent_body')}</p>
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-primary hover:underline font-medium text-sm"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('auth.back_to_sign_in')}
          </Link>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="bg-surface rounded-xl border border-border p-6 space-y-4 shadow-sm"
        >
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 text-danger text-sm px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="forgot-email"
              className="block text-sm font-medium text-text-primary mb-1.5"
            >
              {t('auth.email')}
            </label>
            <input
              id="forgot-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
              placeholder={t('auth.email_placeholder')}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            {loading ? t('auth.forgot_password_sending') : t('auth.forgot_password_submit')}
          </button>

          <div className="text-center text-sm text-text-secondary pt-1">
            <Link
              to="/login"
              className="inline-flex items-center gap-1.5 text-primary hover:underline font-medium"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('auth.back_to_sign_in')}
            </Link>
          </div>
        </form>
      )}
    </Shell>
  );
}

function ResetPasswordForm({ token }: { token: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError(t('auth.password_too_short'));
      return;
    }
    if (password !== confirm) {
      setError(t('auth.reset_password_mismatch'));
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
      // Brief success state so the user sees the confirmation, then
      // funnel them to /login to actually sign in with the new password.
      setTimeout(() => navigate('/login'), 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('auth.reset_password_failed'));
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <Shell
        icon={<CheckCircle2 className="h-6 w-6" />}
        title={t('auth.reset_password_success_title')}
        subtitle={t('auth.reset_password_success_subtitle')}
      >
        <div className="bg-surface rounded-xl border border-border p-6 shadow-sm text-sm text-text-secondary text-center">
          <p>{t('auth.reset_password_success_body')}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      icon={<KeyRound className="h-6 w-6" />}
      title={t('auth.reset_password_title')}
      subtitle={t('auth.reset_password_subtitle')}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-surface rounded-xl border border-border p-6 space-y-4 shadow-sm"
      >
        {/*
          Hidden username field — Chrome/Edge warn about password forms
          that have no associated username (impacts both autofill and
          accessibility). The actual identity is bound to the token, so
          we don't ask for it, but we still need a non-empty username
          autocomplete hint for the password manager. Marking it
          aria-hidden + tabIndex={-1} keeps it out of the AT/keyboard
          flow.
        */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value=""
          readOnly
          aria-hidden="true"
          tabIndex={-1}
          style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', border: 0 }}
        />

        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 text-danger text-sm px-3 py-2 rounded-lg">
            {error}
          </div>
        )}

        <div>
          <label
            htmlFor="reset-password"
            className="block text-sm font-medium text-text-primary mb-1.5"
          >
            {t('auth.reset_password_new_label')}
          </label>
          <input
            id="reset-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
            placeholder={t('auth.password_min_8_placeholder')}
          />
        </div>

        <div>
          <label
            htmlFor="reset-password-confirm"
            className="block text-sm font-medium text-text-primary mb-1.5"
          >
            {t('auth.reset_password_confirm_label')}
          </label>
          <input
            id="reset-password-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition"
            placeholder={t('auth.password_min_8_placeholder')}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-primary hover:bg-primary-hover text-white font-medium py-2.5 px-4 rounded-lg text-sm transition-colors disabled:opacity-50"
        >
          {loading ? t('auth.reset_password_saving') : t('auth.reset_password_submit')}
        </button>

        <div className="text-center text-sm text-text-secondary pt-1">
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-primary hover:underline font-medium"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('auth.back_to_sign_in')}
          </Link>
        </div>
      </form>
    </Shell>
  );
}

function Shell({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-surface-secondary px-4">
      <div className="w-full flex justify-end pt-4">
        <LanguageSwitcher variant="muted" />
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary text-white mb-4">
              {icon}
            </div>
            <h1 className="text-2xl font-bold text-text-primary font-display">{title}</h1>
            <p className="text-sm text-text-secondary mt-1">{subtitle}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
