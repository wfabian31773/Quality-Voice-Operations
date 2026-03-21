import { Link, Outlet, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { Menu, X, Phone } from 'lucide-react';
import WebsiteSalesWidget from './WebsiteSalesWidget';

const navLinks = [
  { to: '/product', label: 'Product' },
  { to: '/features', label: 'Features' },
  { to: '/ai-agents', label: 'Agents' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/use-cases', label: 'Use Cases' },
  { to: '/integrations', label: 'Integrations' },
  { to: '/demo', label: 'Demo' },
  { to: '/resources', label: 'Resources' },
  { to: '/contact', label: 'Contact' },
];

export default function PublicLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="min-h-screen flex flex-col bg-mist font-body text-slate-ink">
      <header className="bg-harbor text-white sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="flex items-center gap-2.5 shrink-0">
              <div className="w-8 h-8 rounded-lg bg-teal flex items-center justify-center">
                <Phone className="h-4 w-4 text-white" />
              </div>
              <span className="font-display text-xl font-bold tracking-tight">QVO</span>
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
                  {link.label}
                </Link>
              ))}
            </nav>

            <div className="hidden lg:flex items-center gap-3">
              <Link
                to="/login"
                className="text-sm font-medium text-white/80 hover:text-white transition-colors px-3 py-2"
              >
                Sign In
              </Link>
              <Link
                to="/signup"
                className="text-sm font-medium bg-teal hover:bg-teal-hover text-white px-4 py-2 rounded-lg transition-colors"
              >
                Start Free Trial
              </Link>
            </div>

            <button
              className="lg:hidden p-2 text-white/80 hover:text-white"
              onClick={() => setMobileOpen(!mobileOpen)}
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
                  {link.label}
                </Link>
              ))}
              <div className="pt-3 border-t border-white/10 mt-3 space-y-2">
                <Link
                  to="/login"
                  onClick={() => setMobileOpen(false)}
                  className="block text-center text-sm font-medium text-white/80 hover:text-white px-3 py-2.5"
                >
                  Sign In
                </Link>
                <Link
                  to="/signup"
                  onClick={() => setMobileOpen(false)}
                  className="block text-center text-sm font-medium bg-teal hover:bg-teal-hover text-white px-4 py-2.5 rounded-lg"
                >
                  Start Free Trial
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

      <footer className="bg-harbor text-white/70">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-16">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
            <div className="col-span-2 md:col-span-1">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="w-7 h-7 rounded-md bg-teal flex items-center justify-center">
                  <Phone className="h-3.5 w-3.5 text-white" />
                </div>
                <span className="font-display text-lg font-bold text-white tracking-tight">QVO</span>
              </div>
              <p className="text-sm leading-relaxed">
                Quality Voice Operations. The voice operations hub for small businesses.
              </p>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-white mb-4">Product</h4>
              <ul className="space-y-2.5">
                <li><Link to="/product" className="text-sm hover:text-white transition-colors">Platform</Link></li>
                <li><Link to="/features" className="text-sm hover:text-white transition-colors">Features</Link></li>
                <li><Link to="/ai-agents" className="text-sm hover:text-white transition-colors">Agents</Link></li>
                <li><Link to="/pricing" className="text-sm hover:text-white transition-colors">Pricing</Link></li>
                <li><Link to="/integrations" className="text-sm hover:text-white transition-colors">Integrations</Link></li>
                <li><Link to="/demo" className="text-sm hover:text-white transition-colors">Live Demo</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-white mb-4">Solutions</h4>
              <ul className="space-y-2.5">
                <li><Link to="/industries/healthcare" className="text-sm hover:text-white transition-colors">Healthcare</Link></li>
                <li><Link to="/industries/dental" className="text-sm hover:text-white transition-colors">Dental</Link></li>
                <li><Link to="/industries/legal" className="text-sm hover:text-white transition-colors">Legal</Link></li>
                <li><Link to="/industries/real-estate" className="text-sm hover:text-white transition-colors">Real Estate</Link></li>
                <li><Link to="/industries/home-services" className="text-sm hover:text-white transition-colors">Home Services</Link></li>
                <li><Link to="/case-studies" className="text-sm hover:text-white transition-colors">Case Studies</Link></li>
              </ul>
            </div>

            <div>
              <h4 className="font-display text-sm font-semibold text-white mb-4">Company</h4>
              <ul className="space-y-2.5">
                <li><Link to="/contact" className="text-sm hover:text-white transition-colors">Contact</Link></li>
                <li><Link to="/blog" className="text-sm hover:text-white transition-colors">Blog</Link></li>
                <li><Link to="/resources" className="text-sm hover:text-white transition-colors">Resources</Link></li>
                <li><Link to="/docs" className="text-sm hover:text-white transition-colors">API Docs</Link></li>
                <li><Link to="/login" className="text-sm hover:text-white transition-colors">Sign In</Link></li>
              </ul>
            </div>
          </div>

          <div className="border-t border-white/10 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-xs text-white/50">
              &copy; {new Date().getFullYear()} Quality Voice Operations. All rights reserved.
            </p>
            <div className="flex items-center gap-6 text-xs text-white/50">
              <span>Privacy Policy</span>
              <span>Terms of Service</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
