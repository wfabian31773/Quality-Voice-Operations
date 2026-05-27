import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

interface ServerErrorProps {
  error?: Error | null;
  onRetry?: () => void;
}

export default function ServerError({ error, onRetry }: ServerErrorProps) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary px-6">
      <div className="max-w-md w-full text-center">
        <div className="inline-flex items-center justify-center h-20 w-20 rounded-2xl bg-danger-light text-danger mb-6">
          <AlertTriangle className="h-10 w-10" />
        </div>
        <p className="text-sm font-semibold text-danger uppercase tracking-wider mb-2">{t('server_error.label')}</p>
        <h1 className="text-3xl font-bold text-text-primary font-display mb-3">{t('server_error.title')}</h1>
        <p className="text-text-secondary mb-6">
          {t('server_error.description')}
        </p>
        {error?.message && (
          <pre className="text-left text-xs bg-surface border border-border rounded-lg p-3 mb-6 overflow-auto max-h-40 text-text-secondary">
            {error.message}
          </pre>
        )}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={() => (onRetry ? onRetry() : window.location.reload())}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-white font-medium hover:bg-primary-hover transition-colors"
          >
            <RefreshCw className="h-4 w-4" /> {t('server_error.try_again')}
          </button>
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-border text-text-primary font-medium hover:bg-surface-hover transition-colors"
          >
            <Home className="h-4 w-4" /> {t('server_error.go_dashboard')}
          </Link>
        </div>
      </div>
    </div>
  );
}
