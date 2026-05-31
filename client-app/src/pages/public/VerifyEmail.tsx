import '../../styles/tw-public.css';
import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../../components/LanguageSwitcher';

type ErrorSource =
  | { kind: 'missing_token' }
  | { kind: 'request_failed' }
  | { kind: 'server'; message: string | null };

export default function VerifyEmail() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorSource, setErrorSource] = useState<ErrorSource | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setErrorSource({ kind: 'missing_token' });
      return;
    }

    let cancelled = false;
    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (cancelled) return;
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          setStatus('success');
        } else {
          setStatus('error');
          setErrorSource({ kind: 'server', message: data?.error ?? null });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
        setErrorSource({ kind: 'request_failed' });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  let errorMessage = '';
  if (errorSource) {
    if (errorSource.kind === 'missing_token') {
      errorMessage = t('verify_email.missing_token');
    } else if (errorSource.kind === 'request_failed') {
      errorMessage = t('verify_email.request_failed');
    } else {
      errorMessage = errorSource.message || t('verify_email.failed_default');
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-surface-secondary px-4">
      <div className="w-full flex justify-end pt-4">
        <LanguageSwitcher variant="muted" />
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="max-w-md w-full bg-surface rounded-xl shadow-lg p-8 text-center">
          {status === 'loading' && (
            <>
              <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-text-primary">{t('verify_email.verifying')}</h2>
            </>
          )}
          {status === 'success' && (
            <>
              <div className="w-16 h-16 bg-success-light rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-success dark:text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-text-primary mb-2">{t('verify_email.success_title')}</h2>
              <p className="text-text-secondary mb-6">{t('verify_email.success_message')}</p>
              <Link to="/login" className="inline-block bg-primary hover:bg-primary-hover text-white font-medium py-2 px-6 rounded-lg transition-colors">
                {t('verify_email.go_to_login')}
              </Link>
            </>
          )}
          {status === 'error' && (
            <>
              <div className="w-16 h-16 bg-danger-light rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-danger dark:text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-text-primary mb-2">{t('verify_email.failed_title')}</h2>
              <p className="text-text-secondary mb-6">{errorMessage}</p>
              <Link to="/login" className="inline-block bg-text-secondary hover:bg-text-primary text-on-inverse font-medium py-2 px-6 rounded-lg transition-colors">
                {t('verify_email.back_to_login')}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
