import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguageCode,
  withLocalePrefix,
  stripLocalePrefix,
  DEFAULT_LANGUAGE,
} from '../lib/i18n';

interface LanguageSwitcherProps {
  variant?: 'sidebar' | 'header' | 'muted';
  className?: string;
}

export default function LanguageSwitcher({ variant = 'header', className = '' }: LanguageSwitcherProps) {
  const { t, i18n } = useTranslation();
  const supportedCodes = SUPPORTED_LANGUAGES.map((l) => l.code) as readonly string[];
  const resolved = i18n.resolvedLanguage || i18n.language || 'en';
  const current = supportedCodes.includes(resolved)
    ? resolved
    : supportedCodes.find((code) => code.split('-')[0] === resolved.split('-')[0]) || 'en';

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as SupportedLanguageCode;
    if (next === current) return;

    // Persist the choice so subsequent visits to un-prefixed URLs honor it.
    try {
      i18n.changeLanguage(next);
    } catch {
      // changeLanguage is best-effort here — the page reload below picks up
      // the new locale from the URL prefix regardless.
    }

    if (typeof window === 'undefined') return;
    // Build the new URL with (or without, for `en`) a locale prefix and
    // assign it. A full reload is intentional: BrowserRouter's `basename` is
    // computed once at boot, so swapping the prefix requires a remount.
    const currentPath = window.location.pathname;
    const pathWithoutLocale = stripLocalePrefix(currentPath);
    let nextPath = withLocalePrefix(next, pathWithoutLocale);
    if (next === DEFAULT_LANGUAGE && nextPath === '') nextPath = '/';

    // Drop ?lang= if present so the URL prefix is the single source of truth
    // after the switch — otherwise refreshing could surface a stale value.
    const search = new URLSearchParams(window.location.search);
    search.delete('lang');
    const qs = search.toString();
    const url = `${nextPath}${qs ? `?${qs}` : ''}${window.location.hash}`;
    window.location.assign(url);
  };

  if (variant === 'muted') {
    return (
      <label className={'inline-flex items-center gap-1.5 ' + className}>
        <Languages className="h-4 w-4 text-text-secondary" aria-hidden="true" />
        <span className="sr-only">{t('language.switcher_label')}</span>
        <select
          value={current}
          onChange={handleChange}
          aria-label={t('language.switcher_label')}
          className="bg-transparent text-sm font-medium text-text-secondary hover:text-text-primary focus:text-text-primary focus:outline-none cursor-pointer appearance-none pr-1"
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code} className="text-text-primary bg-white">
              {lang.nativeLabel}
            </option>
          ))}
        </select>
      </label>
    );
  }

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
            <option key={lang.code} value={lang.code} className="text-text-primary bg-white">
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
          <option key={lang.code} value={lang.code} className="text-text-primary bg-white">
            {lang.nativeLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
