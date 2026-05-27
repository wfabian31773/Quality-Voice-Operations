import '../styles/tw-public.css';
import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { api, setToken } from '../lib/api';
import { dbRoleToSimple, ROLE_LABELS } from '../lib/useRole';
import { KeyRound, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import LanguageSwitcher from '../components/LanguageSwitcher';

interface InvitationInfo {
  email: string;
  role: string;
  tenantName: string;
  inviterEmail: string;
  expiresAt: string;
}

export default function AcceptInvite() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [invitation, setInvitation] = useState<InvitationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    if (!token) {
      setErrorKey('accept_invite.invalid_link');
      setErrorMessage(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    api.get<InvitationInfo>(`/auth/invite-info?token=${encodeURIComponent(token)}`)
      .then((info) => {
        if (cancelled) return;
        setInvitation(info);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const serverMsg = err instanceof Error ? err.message : '';
        if (serverMsg) {
          setErrorMessage(serverMsg);
          setErrorKey(null);
        } else {
          setErrorKey('accept_invite.invalid_or_expired');
          setErrorMessage(null);
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;

    if (password.length < 8) {
      setErrorKey('accept_invite.password_too_short');
      setErrorMessage(null);
      return;
    }
    if (password !== confirmPassword) {
      setErrorKey('accept_invite.passwords_do_not_match');
      setErrorMessage(null);
      return;
    }

    setSubmitting(true);
    setErrorKey(null);
    setErrorMessage(null);

    try {
      const result = await api.post<{
        token: string;
        userId: string;
        email: string;
        role: string;
        tenantId: string;
      }>('/auth/accept-invite', { token, password });

      setToken(result.token);
      setSuccess(true);
      setTimeout(() => navigate('/'), 2000);
    } catch (err: unknown) {
      const serverMsg = err instanceof Error ? err.message : '';
      if (serverMsg) {
        setErrorMessage(serverMsg);
        setErrorKey(null);
      } else {
        setErrorKey('accept_invite.submit_failed');
        setErrorMessage(null);
      }
      setSubmitting(false);
    }
  };

  const errorText = errorKey ? t(errorKey) : errorMessage;

  const roleLabel = invitation
    ? ROLE_LABELS[dbRoleToSimple(invitation.role)] ?? invitation.role
    : '';

  return (
    <div className="min-h-screen flex flex-col bg-background p-4">
      <div className="w-full flex justify-end">
        <LanguageSwitcher variant="muted" />
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-md">
          <div className="flex justify-center mb-6">
            <div className="p-3 rounded-xl bg-primary-light">
              <KeyRound className="h-8 w-8 text-primary" />
            </div>
          </div>

          <h1 className="text-2xl font-bold text-center text-text-primary mb-2">
            {t('accept_invite.title')}
          </h1>

          {loading && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          )}

          {!loading && errorText && !invitation && (
            <div className="bg-surface border border-border rounded-xl p-6 text-center">
              <XCircle className="h-10 w-10 text-danger mx-auto mb-3" />
              <p className="text-text-secondary">{errorText}</p>
              <button
                onClick={() => navigate('/login')}
                className="mt-4 text-sm text-primary hover:underline"
              >
                {t('accept_invite.go_to_login')}
              </button>
            </div>
          )}

          {success && (
            <div className="bg-surface border border-border rounded-xl p-6 text-center">
              <CheckCircle className="h-10 w-10 text-success mx-auto mb-3" />
              <p className="text-text-primary font-medium">{t('accept_invite.activated')}</p>
              <p className="text-text-secondary text-sm mt-1">{t('accept_invite.redirecting')}</p>
            </div>
          )}

          {!loading && invitation && !success && (
            <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
              <p className="text-sm text-text-secondary mb-4">
                <Trans
                  i18nKey="accept_invite.invitation_intro"
                  values={{ tenantName: invitation.tenantName, role: roleLabel }}
                  components={{ strong: <strong /> }}
                />
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">{t('accept_invite.email_label')}</label>
                  <input
                    type="email"
                    value={invitation.email}
                    disabled
                    className="w-full px-3 py-2 rounded-lg bg-surface-hover border border-border text-text-secondary"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">{t('accept_invite.password_label')}</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('accept_invite.password_placeholder')}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary focus:ring-2 focus:ring-primary/50 focus:border-transparent"
                    required
                    minLength={8}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">{t('accept_invite.confirm_password_label')}</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('accept_invite.confirm_password_placeholder')}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary focus:ring-2 focus:ring-primary/50 focus:border-transparent"
                    required
                    minLength={8}
                  />
                </div>

                {errorText && (
                  <p className="text-sm text-danger">{errorText}</p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-2.5 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitting ? t('accept_invite.submitting') : t('accept_invite.submit_button')}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
