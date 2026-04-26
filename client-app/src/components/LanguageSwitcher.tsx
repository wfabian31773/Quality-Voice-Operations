import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { SUPPORTED_LANGUAGES } from '../lib/i18n';

interface LanguageSwitcherProps {
  variant?: 'sidebar' | 'header';
  className?: string;
}

export default function LanguageSwitcher({ variant = 'header', className = '' }: LanguageSwitcherProps) {
  const { t, i18n } = useTranslation();
  const current = (i18n.language || 'en').split('-')[0];

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    void i18n.changeLanguage(e.target.value);
  };

  if (variant === 'sidebar') {
    return (
      <label
        className={
          'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-white w-full transition-colors cursor-pointer ' +
          className
        }
      >
        <Languages className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">{t('language.switcher_label')}</span>
        <select
          value={current}
          onChange={handleChange}
          aria-label={t('language.switcher_label')}
          className="bg-transparent text-sm font-medium text-sidebar-text hover:text-white focus:text-white focus:outline-none cursor-pointer w-full appearance-none"
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code} className="text-slate-ink bg-white">
              {lang.nativeLabel}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className={'inline-flex items-center gap-1.5 ' + className}>
      <Languages className="h-4 w-4 text-white/70" aria-hidden="true" />
      <span className="sr-only">{t('language.switcher_label')}</span>
      <select
        value={current}
        onChange={handleChange}
        aria-label={t('language.switcher_label')}
        className="bg-transparent text-sm font-medium text-white/85 hover:text-white focus:text-white focus:outline-none cursor-pointer appearance-none pr-1"
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code} className="text-slate-ink bg-white">
            {lang.nativeLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
