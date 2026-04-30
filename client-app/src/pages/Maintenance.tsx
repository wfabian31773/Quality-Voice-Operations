import { useTranslation } from 'react-i18next';
import { Wrench, RefreshCw } from 'lucide-react';

interface MaintenanceProps {
  message?: string | null;
  scheduledFor?: string | null;
}

export default function Maintenance({ message, scheduledFor }: MaintenanceProps) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary px-6">
      <div className="max-w-md w-full text-center">
        <div className="inline-flex items-center justify-center h-20 w-20 rounded-2xl bg-amber-50 text-warning mb-6">
          <Wrench className="h-10 w-10" />
        </div>
        <p className="text-sm font-semibold text-warning uppercase tracking-wider mb-2">{t('maintenance.label')}</p>
        <h1 className="text-3xl font-bold text-text-primary font-display mb-3">{t('maintenance.title')}</h1>
        <p className="text-text-secondary mb-2">
          {message || t('maintenance.default_message')}
        </p>
        {scheduledFor && (
          <p className="text-sm text-text-muted mb-6">
            {t('maintenance.estimated_completion', { datetime: new Date(scheduledFor).toLocaleString() })}
          </p>
        )}
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-white font-medium hover:bg-primary-hover transition-colors mt-4"
        >
          <RefreshCw className="h-4 w-4" /> {t('maintenance.check_again')}
        </button>
      </div>
    </div>
  );
}
