import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { sanitizeRedirectPath } from '../lib/sanitizeRedirectPath';

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, initialized } = useAuth();
  const location = useLocation();

  if (!initialized || loading) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-[#0f172a]">
        <div className="animate-spin h-10 w-10 border-4 border-primary border-t-transparent rounded-full mb-4" />
        <p className="text-sm text-slate-400">Loading...</p>
      </div>
    );
  }

  if (!user) {
    // BL-012: preserve the page the user was trying to reach so we can
    // bring them back after they log in. Login.tsx sanitizes this value
    // through `safeRedirect()`, but we ALSO build a same-origin relative
    // path here so a malicious deep link can't poison it before it ever
    // reaches the login page.
    //
    // Compliance hardening: the resulting `/login?redirectTo=…` URL ends
    // up in server access logs, the Referer header on outbound asset
    // loads from the login page, and analytics events. So before we
    // serialize the target into the login URL, we run it through
    // `sanitizeRedirectPath()` to drop the URL fragment and strip any
    // query params that look like tokens, codes, or email addresses.
    const rawTarget = `${location.pathname}${location.search}${location.hash}`;
    const isSameOriginPath =
      rawTarget.startsWith('/') && !rawTarget.startsWith('//') && !rawTarget.startsWith('/\\');
    const target = isSameOriginPath ? sanitizeRedirectPath(rawTarget) : rawTarget;
    const loginUrl =
      isSameOriginPath && target !== '/'
        ? `/login?redirectTo=${encodeURIComponent(target)}`
        : '/login';
    return <Navigate to={loginUrl} replace />;
  }
  return <>{children}</>;
}
