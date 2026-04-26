import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function AppFooter() {
  const { t } = useTranslation();
  return (
    <footer className="border-t border-border bg-surface px-4 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-text-muted">
      <span>{t('footer.compact_copyright', { year: new Date().getFullYear() })}</span>
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link to="/privacy" className="hover:text-text-primary transition-colors">{t('footer.compact_privacy')}</Link>
        <Link to="/terms" className="hover:text-text-primary transition-colors">{t('footer.compact_terms')}</Link>
        <Link to="/security" className="hover:text-text-primary transition-colors">{t('footer.security')}</Link>
        <Link to="/subprocessors" className="hover:text-text-primary transition-colors">{t('footer.subprocessors')}</Link>
        <a href="/api/legal/dpa" className="hover:text-text-primary transition-colors">{t('footer.dpa')}</a>
        <Link to="/settings/privacy" className="hover:text-text-primary transition-colors">{t('footer.your_data')}</Link>
      </nav>
    </footer>
  );
}
