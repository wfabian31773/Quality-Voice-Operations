import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Compass, Home, ArrowLeft } from 'lucide-react';
import LanguageSwitcher from '../components/LanguageSwitcher';

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex flex-col bg-surface-secondary px-6">
      <div className="w-full flex justify-end pt-4">
        <LanguageSwitcher variant="muted" />
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div className="max-w-md w-full text-center">
          <div className="inline-flex items-center justify-center h-20 w-20 rounded-2xl bg-primary-light text-primary mb-6">
            <Compass className="h-10 w-10" />
          </div>
          <p className="text-sm font-semibold text-primary uppercase tracking-wider mb-2">{t('not_found.label')}</p>
          <h1 className="text-3xl font-bold text-text-primary font-display mb-3">{t('not_found.title')}</h1>
          <p className="text-text-secondary mb-8">
            {t('not_found.description')}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/dashboard"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-white font-medium hover:bg-primary-hover transition-colors"
            >
              <Home className="h-4 w-4" /> {t('not_found.go_dashboard')}
            </Link>
            <button
              onClick={() => window.history.back()}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-border text-text-primary font-medium hover:bg-surface-hover transition-colors"
            >
              <ArrowLeft className="h-4 w-4" /> {t('not_found.go_back')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
