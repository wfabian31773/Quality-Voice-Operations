import '../styles/tw-public.css';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Menu, X, Phone, ChevronDown, Moon, Sun } from 'lucide-react';
import WebsiteSalesWidget from './WebsiteSalesWidget';
import CookieConsent from './CookieConsent';
import LanguageSwitcher from './LanguageSwitcher';
import { useTheme } from '../lib/theme';

type SimpleLink = { kind: 'link'; to: string; i18nKey: string };
type DropdownLink = {
  kind: 'dropdown';
  id: string;
  i18nKey: string;
  /** Path prefixes (or exact paths) that should mark this dropdown as active. */
  activePaths: string[];
  groups: Array<{
    label?: string;
    items: Array<{ to: string; label: string; description?: string; isNew?: boolean }>;
  }>;
};
type NavItem = SimpleLink | DropdownLink;

export default function PublicLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [mobileExpanded, setMobileExpanded] = useState<string | null>(null);
  const location = useLocation();
  const { t } = useTranslation();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { dark, toggle: toggleTheme } = useTheme();

  // Close dropdowns when route changes.
  useEffect(() => {
    setOpenDropdown(null);
    setMobileOpen(false);
    setMobileExpanded(null);
  }, [location.pathname]);

  // Close dropdowns on outside click.
  useEffect(() => {
    if (!openDropdown) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openDropdown]);

  // Close on Escape.
  useEffect(() => {
    if (!openDropdown) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenDropdown(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [openDropdown]);

  const navItems: NavItem[] = [
    {
      kind: 'dropdown',
      id: 'product',
      i18nKey: 'public_nav.product',
      activePaths: ['/product', '/features', '/ai-agents', '/integrations'],
      groups: [
        {
          label: t('public_nav_groups.platform'),
          items: [
            { to: '/product', label: t('public_nav.product_overview'), description: t('public_nav_desc.product_overview') },
            { to: '/features', label: t('public_nav.features'), description: t('public_nav_desc.features') },
            { to: '/ai-agents', label: t('public_nav.agents'), description: t('public_nav_desc.agents') },
            { to: '/integrations', label: t('public_nav.integrations'), description: t('public_nav_desc.integrations') },
          ],
        },
        {
          label: t('public_nav_groups.developer'),
          items: [
            {
              to: '/product/federated-ingest',
              label: t('public_nav.federated_ingest'),
              description: t('public_nav_desc.federated_ingest'),
              isNew: true,
            },
            {
              to: '/product/global-intelligence-network',
              label: t('public_nav.gin'),
              description: t('public_nav_desc.gin'),
              isNew: true,
            },
          ],
        },
      ],
    },
    {
      kind: 'dropdown',
      id: 'solutions',
      i18nKey: 'public_nav.solutions',
      activePaths: ['/industries', '/use-cases', '/case-studies'],
      groups: [
        {
          label: t('public_nav_groups.solutions_overview'),
          items: [
            {
              to: '/industries/vertical-agents',
              label: t('public_nav.vertical_agents'),
              description: t('public_nav_desc.vertical_agents'),
              isNew: true,
            },
            { to: '/use-cases', label: t('public_nav.use_cases'), description: t('public_nav_desc.use_cases') },
            { to: '/case-studies', label: t('footer.case_studies'), description: t('public_nav_desc.case_studies') },
          ],
        },
        {
          label: t('public_nav_groups.industries'),
          items: [
            { to: '/industries/healthcare', label: t('footer.healthcare') },
            { to: '/industries/dental', label: t('footer.dental') },
            { to: '/industries/legal', label: t('footer.legal') },
            { to: '/industries/real-estate', label: t('footer.real_estate') },
            { to: '/industries/home-services', label: t('footer.home_services') },
          ],
        },
      ],
    },
    { kind: 'link', to: '/pricing', i18nKey: 'public_nav.pricing' },
    { kind: 'link', to: '/demo', i18nKey: 'public_nav.demo' },
    { kind: 'link', to: '/resources', i18nKey: 'public_nav.resources' },
    { kind: 'link', to: '/contact', i18nKey: 'public_nav.contact' },
  ];

  const isItemActive = (item: NavItem) => {
    if (item.kind === 'link') return location.pathname === item.to;
    return item.activePaths.some(
      (p) => location.pathname === p || location.pathname.startsWith(`${p}/`),
    );
  };

  return (
    <div className="public-surface min-h-screen flex flex-col bg-surface-secondary font-body text-text-primary">
      <header
        className="bg-sidebar-bg text-on-sidebar sticky top-0 z-50 border-b border-on-sidebar/5"
        style={{ boxShadow: 'var(--elevation-1)' }}
      >
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="flex items-center gap-2.5 shrink-0">
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                <Phone className="h-4 w-4 text-on-primary" />
              </div>
              <span className="font-display text-xl font-bold tracking-tight">{t('brand.name')}</span>
            </Link>

            <nav className="hidden lg:flex items-center gap-1" ref={dropdownRef}>
              {navItems.map((item) => {
                if (item.kind === 'link') {
                  return (
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
                  );
                }

                const isOpen = openDropdown === item.id;
                return (
                  <div key={item.id} className="relative">
                    <button
                      type="button"
                      aria-haspopup="true"
                      aria-expanded={isOpen}
                      onClick={() => setOpenDropdown(isOpen ? null : item.id)}
                      onMouseEnter={() => setOpenDropdown(item.id)}
                      className={`px-3.5 py-2 text-sm font-medium rounded-lg transition-colors inline-flex items-center gap-1 ${
                        isItemActive(item) || isOpen
                          ? 'bg-on-sidebar/15 text-on-sidebar'
                          : 'text-on-sidebar/75 hover:text-on-sidebar hover:bg-on-sidebar/10'
                      }`}
                    >
                      {t(item.i18nKey)}
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                      />
                    </button>

                    {isOpen && (
                      <div
                        onMouseLeave={() => setOpenDropdown(null)}
                        className="absolute left-0 top-full pt-2 z-50"
                      >
                        <div
                          className="w-[28rem] bg-surface text-text-primary border border-border overflow-hidden"
                          style={{
                            borderRadius: 'var(--radius-xl)',
                            boxShadow: 'var(--elevation-3)',
                          }}
                        >
                          <div className="p-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {item.groups.map((group, gi) => (
                              <div key={gi}>
                                {group.label && (
                                  <p className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
                                    {group.label}
                                  </p>
                                )}
                                <ul className="space-y-0.5">
                                  {group.items.map((sub) => (
                                    <li key={sub.to}>
                                      <Link
                                        to={sub.to}
                                        onClick={() => setOpenDropdown(null)}
                                        className={`block px-2.5 py-2 rounded-lg transition-colors duration-[var(--motion-fast)] group ${
                                          location.pathname === sub.to
                                            ? 'bg-primary-light'
                                            : 'hover:bg-surface-hover'
                                        }`}
                                      >
                                        <div className="flex items-center gap-2">
                                          <span className="text-sm font-semibold text-text-primary group-hover:text-primary transition-colors">
                                            {sub.label}
                                          </span>
                                          {sub.isNew && (
                                            <span className="text-[9px] font-semibold uppercase tracking-wider text-primary bg-primary-light px-1.5 py-0.5 rounded">
                                              {t('public_nav.new_badge')}
                                            </span>
                                          )}
                                        </div>
                                        {sub.description && (
                                          <p className="text-xs text-text-secondary leading-snug mt-0.5 line-clamp-2">
                                            {sub.description}
                                          </p>
                                        )}
                                      </Link>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </nav>

            <div className="hidden lg:flex items-center gap-2">
              <LanguageSwitcher variant="header" className="mr-1" />
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-pressed={dark}
                className="inline-flex items-center justify-center w-10 h-10 rounded-lg text-on-sidebar/75 hover:text-on-sidebar hover:bg-on-sidebar/10 transition-colors duration-[var(--motion-fast)]"
              >
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
              <Link
                to="/login"
                className="text-sm font-medium text-on-sidebar/80 hover:text-on-sidebar transition-colors duration-[var(--motion-fast)] px-3 py-2 rounded-lg"
              >
                {t('actions.sign_in')}
              </Link>
              <Link
                to="/book-demo"
                className="text-sm font-medium text-on-sidebar/90 hover:text-on-sidebar border border-on-sidebar/20 hover:border-on-sidebar/40 px-3.5 py-2 rounded-lg transition-colors duration-[var(--motion-fast)]"
              >
                {t('actions.book_demo')}
              </Link>
              <Link
                to="/signup"
                className="btn-primary-glow text-sm font-medium bg-primary hover:bg-primary-hover text-on-primary px-4 py-2 rounded-lg transition-colors duration-[var(--motion-fast)]"
              >
                {t('actions.start_trial')}
              </Link>
            </div>

            <div className="lg:hidden flex items-center gap-1">
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-pressed={dark}
                className="inline-flex items-center justify-center w-11 h-11 rounded-lg text-on-sidebar/75 hover:text-on-sidebar hover:bg-on-sidebar/10 transition-colors"
              >
                {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
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
              {navItems.map((item) => {
                if (item.kind === 'link') {
                  return (
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
                  );
                }

                const isExpanded = mobileExpanded === item.id;
                return (
                  <div key={item.id}>
                    <button
                      type="button"
                      onClick={() => setMobileExpanded(isExpanded ? null : item.id)}
                      aria-expanded={isExpanded}
                      className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg ${
                        isItemActive(item)
                          ? 'bg-on-sidebar/15 text-on-sidebar'
                          : 'text-on-sidebar/75 hover:text-on-sidebar hover:bg-on-sidebar/10'
                      }`}
                    >
                      <span>{t(item.i18nKey)}</span>
                      <ChevronDown
                        className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        aria-hidden="true"
                      />
                    </button>
                    {isExpanded && (
                      <div className="pl-3 mt-1 mb-2 space-y-2 border-l border-on-sidebar/10 ml-3">
                        {item.groups.map((group, gi) => (
                          <div key={gi}>
                            {group.label && (
                              <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-on-sidebar/70">
                                {group.label}
                              </p>
                            )}
                            {group.items.map((sub) => (
                              <Link
                                key={sub.to}
                                to={sub.to}
                                onClick={() => setMobileOpen(false)}
                                className={`block px-3 py-2 text-sm rounded-lg ${
                                  location.pathname === sub.to
                                    ? 'bg-on-sidebar/15 text-on-sidebar'
                                    : 'text-on-sidebar/70 hover:text-on-sidebar hover:bg-on-sidebar/10'
                                }`}
                              >
                                <span className="inline-flex items-center gap-2">
                                  {sub.label}
                                  {sub.isNew && (
                                    <span className="text-[9px] font-semibold uppercase tracking-wider text-primary bg-primary/15 px-1.5 py-0.5 rounded">
                                      {t('public_nav.new_badge')}
                                    </span>
                                  )}
                                </span>
                              </Link>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
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
                <Link
                  to="/signup"
                  onClick={() => setMobileOpen(false)}
                  className="btn-primary-glow block text-center text-sm font-medium bg-primary hover:bg-primary-hover text-on-primary px-4 py-2.5 rounded-lg transition-colors"
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
                <li><Link to="/product" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.platform')}</Link></li>
                <li><Link to="/features" className="text-sm hover:text-on-sidebar transition-colors">{t('public_nav.features')}</Link></li>
                <li><Link to="/ai-agents" className="text-sm hover:text-on-sidebar transition-colors">{t('public_nav.agents')}</Link></li>
                <li><Link to="/pricing" className="text-sm hover:text-on-sidebar transition-colors">{t('public_nav.pricing')}</Link></li>
                <li><Link to="/integrations" className="text-sm hover:text-on-sidebar transition-colors">{t('public_nav.integrations')}</Link></li>
                <li><Link to="/product/federated-ingest" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.federated_ingest')}</Link></li>
                <li><Link to="/product/global-intelligence-network" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.gin')}</Link></li>
                <li><Link to="/demo" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.live_demo')}</Link></li>
                <li><Link to="/book-demo" className="text-sm hover:text-on-sidebar transition-colors">{t('actions.book_demo')}</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-on-sidebar mb-4">{t('footer.section_solutions')}</h4>
              <ul className="space-y-2.5">
                <li><Link to="/industries/vertical-agents" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.vertical_agents')}</Link></li>
                <li><Link to="/industries/healthcare" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.healthcare')}</Link></li>
                <li><Link to="/industries/dental" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.dental')}</Link></li>
                <li><Link to="/industries/legal" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.legal')}</Link></li>
                <li><Link to="/industries/real-estate" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.real_estate')}</Link></li>
                <li><Link to="/industries/home-services" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.home_services')}</Link></li>
                <li><Link to="/case-studies" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.case_studies')}</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-on-sidebar mb-4">{t('footer.section_company')}</h4>
              <ul className="space-y-2.5">
                <li><Link to="/contact" className="text-sm hover:text-on-sidebar transition-colors">{t('public_nav.contact')}</Link></li>
                <li><Link to="/blog" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.blog')}</Link></li>
                <li><Link to="/resources" className="text-sm hover:text-on-sidebar transition-colors">{t('public_nav.resources')}</Link></li>
                <li><Link to="/docs" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.documentation')}</Link></li>
                <li><Link to="/docs/api-overview" className="text-sm hover:text-on-sidebar transition-colors">{t('footer.api_reference')}</Link></li>
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
