import { Link } from 'react-router-dom';
import { Compass, Home, ArrowLeft } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-secondary px-6">
      <div className="max-w-md w-full text-center">
        <div className="inline-flex items-center justify-center h-20 w-20 rounded-2xl bg-primary-light text-primary mb-6">
          <Compass className="h-10 w-10" />
        </div>
        <p className="text-sm font-semibold text-primary uppercase tracking-wider mb-2">404 — Not Found</p>
        <h1 className="text-3xl font-bold text-text-primary font-display mb-3">We can't find that page</h1>
        <p className="text-text-secondary mb-8">
          The link you followed may be broken, or the page may have been moved. Let's get you back on track.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            to="/dashboard"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-white font-medium hover:bg-primary-hover transition-colors"
          >
            <Home className="h-4 w-4" /> Go to dashboard
          </Link>
          <button
            onClick={() => window.history.back()}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg border border-border text-text-primary font-medium hover:bg-surface-hover transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Go back
          </button>
        </div>
      </div>
    </div>
  );
}
