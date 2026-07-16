import '../styles/tw-public.css';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, X, Phone, Moon, Sun } from 'lucide-react';
import WebsiteSalesWidget from './WebsiteSalesWidget';
import CookieConsent from './CookieConsent';
import LanguageSwitcher from './LanguageSwitcher';
import { useTheme } from '../lib/theme';

type SimpleLink = { kind: 'link'; to: string; i18nKey: string };

export default function PublicLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { t } = useTranslation();
  const { dark, toggle: toggleTheme } = useTheme();

  // Close the mobile menu when route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const navItems: SimpleLink[] = [
    { kind: 'link', to: '/industries/healthcare', i18nKey: 'footer.healthcare' },
    { kind: 'link', to: '/industries/dental', i18nKey: 'footer.dental' },
    { kind: 'link', to: '/pricing', i18nKey: 'public_nav.pricing' },
    { kind: 'link', to: '/demo', i18nKey: 'public_nav.demo' },
    { kind: 'link', to: '/contact', i18nKey: 'public_nav.contact' },
  ];

  const isItemActive = (item: SimpleLink) => location.pathname === item.to;

  return (
    // `data-accent="teal-forward"` per brand kit: marketing surface leads
    // with TEAL (primary), with harbor as the supporting accent. Authed
    // consoles inherit the default harbor-forward palette from <html>.
    <div
      data-accent="teal-forward"
      className="public-surface min-h-screen flex flex-col bg-surface-secondary font-body text-text-primary"
    >
      <header
        className="bg-sidebar-bg text-on-sidebar sticky top-0 z-dropdown border-b border-on-sidebar/5"
        style={{ boxShadow: 'var(--elevation-1)' }}
      >
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="shrink-0 inline-flex items-center" aria-label={t('brand.name')}>
              <img
                src="/brand/logo-lockup-white.png"
                alt={t('brand.name')}
                className="h-7 w-auto block"
                width="240"
                height="80"
              />
            </Link>

            <nav className="hidden lg:flex items-center gap-1">
              {navItems.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`px-3.5 py-2 text-sm font-medium rounded-lg transition-colors ${
                    isItemActive(item)
                      ? 'bg-on-sidebar/15 text-on-sidebar'
                      : 'text-on-sidebar/75 hover:text-on-sidebar hover:bg-on-sidebar/10'
                  }`}
                >
                  {t(item.i18nKey)}
                </Link>
              ))}
            </nav>

            <div className="hidden lg:flex items-center gap-2">
              <LanguageSwitcher variant="header" className="mr-1" />
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={dark ? t('theme.switch_to_light') : t('theme.switch_to_dark')}
                aria-pressed={dark}
                title={dark ? t('theme.switch_to_light') : t('theme.switch_to_dark')}
                className="inline-flex items-center gap-1.5 h-10 px-2.5 rounded-lg text-on-sidebar/80 hover:text-on-sidebar hover:bg-on-sidebar/10 transition-colors duration-[var(--motion-fast)] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {dark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
                <span className="text-xs font-medium">{dark ? t('theme.light') : t('theme.dark')}</span>
              </button>
              <Link
                to="/login"
                className="inline-flex items-center justify-center h-10 px-4 text-sm font-medium text-on-sidebar/80 hover:text-on-sidebar transition-colors rounded-md whitespace-nowrap shrink-0"
              >
                {t('actions.sign_in')}
              </Link>
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center h-10 px-4 text-sm font-medium text-on-sidebar border border-on-sidebar/25 hover:border-on-sidebar/50 hover:bg-on-sidebar/5 transition-colors rounded-md whitespace-nowrap shrink-0"
              >
                {t('actions.book_demo')}
              </Link>
            </div>

            <div className="lg:hidden flex items-center gap-1">
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={dark ? t('theme.switch_to_light') : t('theme.switch_to_dark')}
                aria-pressed={dark}
                title={dark ? t('theme.switch_to_light') : t('theme.switch_to_dark')}
                className="inline-flex items-center justify-center w-11 h-11 rounded-lg text-on-sidebar/80 hover:text-on-sidebar hover:bg-on-sidebar/10 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {dark ? <Sun className="h-5 w-5" aria-hidden="true" /> : <Moon className="h-5 w-5" aria-hidden="true" />}
              </button>
              <button
                className="inline-flex items-center justify-center w-11 h-11 rounded-lg text-on-sidebar/80 hover:text-on-sidebar hover:bg-on-sidebar/10 transition-colors"
                onClick={() => setMobileOpen(!mobileOpen)}
                aria-label={t('actions.open_menu')}
                aria-expanded={mobileOpen}
              >
                {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </div>

        {mobileOpen && (
          <div className="lg:hidden border-t border-on-sidebar/10 bg-sidebar-bg">
            <div className="px-6 py-4 space-y-1">
              {navItems.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  className={`block px-3 py-2.5 text-sm font-medium rounded-lg ${
                    isItemActive(item)
                      ? 'bg-on-sidebar/15 text-on-sidebar'
                      : 'text-on-sidebar/75 hover:text-on-sidebar hover:bg-on-sidebar/10'
                  }`}
                >
                  {t(item.i18nKey)}
                </Link>
              ))}
              <div className="pt-3 border-t border-on-sidebar/10 mt-3 space-y-2">
                <div className="flex items-center justify-center px-3 py-2">
                  <LanguageSwitcher variant="header" />
                </div>
                <Link
                  to="/login"
                  onClick={() => setMobileOpen(false)}
                  className="block text-center text-sm font-medium text-on-sidebar/80 hover:text-on-sidebar px-3 py-2.5"
                >
                  {t('actions.sign_in')}
                </Link>
                <Link
                  to="/book-demo"
                  onClick={() => setMobileOpen(false)}
                  className="block text-center text-sm font-medium text-on-sidebar border border-on-sidebar/20 hover:border-on-sidebar/40 px-4 py-2.5 rounded-lg"
                >
                  {t('actions.book_demo')}
                </Link>
              </div>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <WebsiteSalesWidget />
      <CookieConsent />

      <footer className="bg-sidebar-bg text-on-sidebar/70">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-16">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
            <div className="col-span-2 md:col-span-1">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
                  <Phone className="h-3.5 w-3.5 text-on-primary" />
                </div>
                <span className="font-display text-lg font-bold text-on-sidebar tracking-tight">{t('brand.name')}</span>
              </div>
              <p className="text-sm leading-relaxed">{t('brand.tagline')}</p>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-on-sidebar mb-4">{t('footer.section_product')}</h4>
              <ul className="space-y-2.5">
                <li><Link to="/pricing" className="text-sm hover:text-on-sidebar transition-colors">{t('public_nav.pricing')}</Link></li>
                <li><Link to="/demo" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.live_demo')}</Link></li>
                <li><Link to="/book-demo" className="text-sm hover:text-on-sidebar transition-colors">{t('actions.book_demo')}</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-on-sidebar mb-4">{t('footer.section_solutions')}</h4>
              <ul className="space-y-2.5">
                <li><Link to="/industries/healthcare" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.healthcare')}</Link></li>
                <li><Link to="/industries/dental" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.dental')}</Link></li>
                <li><Link to="/case-studies" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.case_studies')}</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-on-sidebar mb-4">{t('footer.section_company')}</h4>
              <ul className="space-y-2.5">
                <li><Link to="/contact" className="text-sm hover:text-on-sidebar transition-colors">{t('public_nav.contact')}</Link></li>
                <li><Link to="/login" className="text-sm hover:text-on-sidebar transition-colors">{t('actions.sign_in')}</Link></li>
              </ul>
            </div>
          </div>

          <div className="border-t border-on-sidebar/10 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-xs text-on-sidebar/50">
              {t('footer.rights', { year: new Date().getFullYear() })}
            </p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-on-sidebar/60">
              <Link to="/privacy" className="hover:text-on-sidebar transition-colors">{t('footer.privacy')}</Link>
              <Link to="/terms" className="hover:text-on-sidebar transition-colors">{t('footer.terms')}</Link>
              <Link to="/security" className="hover:text-on-sidebar transition-colors">{t('footer.security')}</Link>
              <Link to="/subprocessors" className="hover:text-on-sidebar transition-colors">{t('footer.subprocessors')}</Link>
              <a href="/legal/dpa" className="hover:text-on-sidebar transition-colors">{t('footer.dpa')}</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
