import { Link } from 'react-router-dom';

export default function AppFooter() {
  return (
    <footer className="border-t border-border bg-surface px-4 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-text-muted">
      <span>&copy; {new Date().getFullYear()} Quality Voice Operations</span>
      <nav className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link to="/privacy" className="hover:text-text-primary transition-colors">Privacy</Link>
        <Link to="/terms" className="hover:text-text-primary transition-colors">Terms</Link>
        <Link to="/security" className="hover:text-text-primary transition-colors">Security</Link>
        <Link to="/subprocessors" className="hover:text-text-primary transition-colors">Sub-processors</Link>
        <a href="/api/legal/dpa" className="hover:text-text-primary transition-colors">DPA</a>
        <Link to="/settings/privacy" className="hover:text-text-primary transition-colors">Your data</Link>
      </nav>
    </footer>
  );
}
