import { Link, Outlet, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, X, Phone } from 'lucide-react';
import WebsiteSalesWidget from './WebsiteSalesWidget';
import CookieConsent from './CookieConsent';
import LanguageSwitcher from './LanguageSwitcher';

const navLinks = [
  { to: '/product', i18nKey: 'public_nav.product' },
  { to: '/features', i18nKey: 'public_nav.features' },
  { to: '/ai-agents', i18nKey: 'public_nav.agents' },
  { to: '/pricing', i18nKey: 'public_nav.pricing' },
  { to: '/use-cases', i18nKey: 'public_nav.use_cases' },
  { to: '/integrations', i18nKey: 'public_nav.integrations' },
  { to: '/demo', i18nKey: 'public_nav.demo' },
  { to: '/resources', i18nKey: 'public_nav.resources' },
  { to: '/contact', i18nKey: 'public_nav.contact' },
] as const;

export default function PublicLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { t } = useTranslation();

  return (
    <div className="min-h-screen flex flex-col bg-mist font-body text-slate-ink">
      <header className="bg-harbor text-white sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="flex items-center gap-2.5 shrink-0">
              <div className="w-8 h-8 rounded-lg bg-teal flex items-center justify-center">
                <Phone className="h-4 w-4 text-white" />
              </div>
              <span className="font-display text-xl font-bold tracking-tight">{t('brand.name')}</span>
            </Link>

            <nav className="hidden lg:flex items-center gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className={`px-3.5 py-2 text-sm font-medium rounded-lg transition-colors ${
                    location.pathname === link.to
                      ? 'bg-white/15 text-white'
                      : 'text-white/75 hover:text-white hover:bg-white/10'
                  }`}
                >
                  {t(link.i18nKey)}
                </Link>
              ))}
            </nav>

            <div className="hidden lg:flex items-center gap-2">
              <LanguageSwitcher variant="header" className="mr-1" />
              <Link
                to="/login"
                className="text-sm font-medium text-white/80 hover:text-white transition-colors px-3 py-2"
              >
                {t('actions.sign_in')}
              </Link>
              <Link
                to="/book-demo"
                className="text-sm font-medium text-white/90 hover:text-white border border-white/20 hover:border-white/40 px-3.5 py-2 rounded-lg transition-colors"
              >
                {t('actions.book_demo')}
              </Link>
              <Link
                to="/signup"
                className="text-sm font-medium bg-teal hover:bg-teal-hover text-white px-4 py-2 rounded-lg transition-colors"
              >
                {t('actions.start_trial')}
              </Link>
            </div>

            <button
              className="lg:hidden p-2 text-white/80 hover:text-white"
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label={t('actions.open_menu')}
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="lg:hidden border-t border-white/10 bg-harbor">
            <div className="px-6 py-4 space-y-1">
              {navLinks.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  onClick={() => setMobileOpen(false)}
                  className={`block px-3 py-2.5 text-sm font-medium rounded-lg ${
                    location.pathname === link.to
                      ? 'bg-white/15 text-white'
                      : 'text-white/75 hover:text-white hover:bg-white/10'
                  }`}
                >
                  {t(link.i18nKey)}
                </Link>
              ))}
              <div className="pt-3 border-t border-white/10 mt-3 space-y-2">
                <div className="flex items-center justify-center px-3 py-2">
                  <LanguageSwitcher variant="header" />
                </div>
                <Link
                  to="/login"
                  onClick={() => setMobileOpen(false)}
                  className="block text-center text-sm font-medium text-white/80 hover:text-white px-3 py-2.5"
                >
                  {t('actions.sign_in')}
                </Link>
                <Link
                  to="/book-demo"
                  onClick={() => setMobileOpen(false)}
                  className="block text-center text-sm font-medium text-white border border-white/20 hover:border-white/40 px-4 py-2.5 rounded-lg"
                >
                  {t('actions.book_demo')}
                </Link>
                <Link
                  to="/signup"
                  onClick={() => setMobileOpen(false)}
                  className="block text-center text-sm font-medium bg-teal hover:bg-teal-hover text-white px-4 py-2.5 rounded-lg"
                >
                  {t('actions.start_trial')}
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

      <footer className="bg-harbor text-white/70">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-16">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
            <div className="col-span-2 md:col-span-1">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-7 h-7 rounded-md bg-teal flex items-center justify-center">
                  <Phone className="h-3.5 w-3.5 text-white" />
                </div>
                <span className="font-display text-lg font-bold text-white tracking-tight">{t('brand.name')}</span>
              </div>
              <p className="text-sm leading-relaxed">{t('brand.tagline')}</p>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-white mb-4">{t('footer.section_product')}</h4>
              <ul className="space-y-2.5">
                <li><Link to="/product" className="text-sm hover:text-white transition-colors">{t('footer.platform')}</Link></li>
                <li><Link to="/features" className="text-sm hover:text-white transition-colors">{t('public_nav.features')}</Link></li>
                <li><Link to="/ai-agents" className="text-sm hover:text-white transition-colors">{t('public_nav.agents')}</Link></li>
                <li><Link to="/pricing" className="text-sm hover:text-white transition-colors">{t('public_nav.pricing')}</Link></li>
                <li><Link to="/integrations" className="text-sm hover:text-white transition-colors">{t('public_nav.integrations')}</Link></li>
                <li><Link to="/product/federated-ingest" className="text-sm hover:text-white transition-colors">{t('footer.federated_ingest')}</Link></li>
                <li><Link to="/product/global-intelligence-network" className="text-sm hover:text-white transition-colors">{t('footer.gin')}</Link></li>
                <li><Link to="/demo" className="text-sm hover:text-white transition-colors">{t('footer.live_demo')}</Link></li>
                <li><Link to="/book-demo" className="text-sm hover:text-white transition-colors">{t('actions.book_demo')}</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-white mb-4">{t('footer.section_solutions')}</h4>
              <ul className="space-y-2.5">
                <li><Link to="/industries/vertical-agents" className="text-sm hover:text-white transition-colors">{t('footer.vertical_agents')}</Link></li>
                <li><Link to="/industries/healthcare" className="text-sm hover:text-white transition-colors">{t('footer.healthcare')}</Link></li>
                <li><Link to="/industries/dental" className="text-sm hover:text-white transition-colors">{t('footer.dental')}</Link></li>
                <li><Link to="/industries/legal" className="text-sm hover:text-white transition-colors">{t('footer.legal')}</Link></li>
                <li><Link to="/industries/real-estate" className="text-sm hover:text-white transition-colors">{t('footer.real_estate')}</Link></li>
                <li><Link to="/industries/home-services" className="text-sm hover:text-white transition-colors">{t('footer.home_services')}</Link></li>
                <li><Link to="/case-studies" className="text-sm hover:text-white transition-colors">{t('footer.case_studies')}</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-white mb-4">{t('footer.section_company')}</h4>
              <ul className="space-y-2.5">
                <li><Link to="/contact" className="text-sm hover:text-white transition-colors">{t('public_nav.contact')}</Link></li>
                <li><Link to="/blog" className="text-sm hover:text-white transition-colors">{t('footer.blog')}</Link></li>
                <li><Link to="/resources" className="text-sm hover:text-white transition-colors">{t('public_nav.resources')}</Link></li>
                <li><Link to="/docs" className="text-sm hover:text-white transition-colors">{t('footer.documentation')}</Link></li>
                <li><Link to="/docs/api-overview" className="text-sm hover:text-white transition-colors">{t('footer.api_reference')}</Link></li>
                <li><Link to="/login" className="text-sm hover:text-white transition-colors">{t('actions.sign_in')}</Link></li>
              </ul>
            </div>
          </div>

          <div className="border-t border-white/10 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-xs text-white/50">
              {t('footer.rights', { year: new Date().getFullYear() })}
            </p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-white/60">
              <Link to="/privacy" className="hover:text-white transition-colors">{t('footer.privacy')}</Link>
              <Link to="/terms" className="hover:text-white transition-colors">{t('footer.terms')}</Link>
              <Link to="/security" className="hover:text-white transition-colors">{t('footer.security')}</Link>
              <Link to="/subprocessors" className="hover:text-white transition-colors">{t('footer.subprocessors')}</Link>
              <a href="/legal/dpa" className="hover:text-white transition-colors">{t('footer.dpa')}</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
