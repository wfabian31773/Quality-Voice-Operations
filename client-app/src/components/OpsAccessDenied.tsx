import { ShieldX } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/auth';

const OPS_PAGE_NAME_KEYS: Record<string, string> = {
  '/ops/monitor': 'admin_nav.ops.monitor',
  '/ops/reliability': 'admin_nav.ops.reliability',
  '/ops/call-debug': 'admin_nav.ops.debugger',
  '/ops/integration-diagnostics': 'admin_nav.ops.diagnostics',
  '/ops/cost': 'admin_nav.ops.cost',
  '/ops/backfill-calls': 'admin_nav.ops.backfill_calls',
  // Legacy aliases kept for backward-compatible deep links (App.tsx
  // redirects `/ops/tool-logs` and `/ops/observability` to
  // `/ops/reliability`). The Navigate runs before OpsGuard mounts, so
  // these entries normally aren't hit — they're here as insurance in
  // case the redirect is ever moved inside the guarded route block,
  // and so a stale link shared in Slack still resolves to a meaningful
  // label rather than the generic fallback.
  '/ops/tool-logs': 'admin_nav.ops.reliability',
  '/ops/observability': 'admin_nav.ops.reliability',
};

const REQUIRED_ROLE_KEYS = [
  'admin_nav.role.tenant_owner',
  'admin_nav.role.operations_manager',
  'admin_nav.role.platform_admin',
] as const;

export default function OpsAccessDenied() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const location = useLocation();
  const { user } = useAuth();

  const pageNameKey = OPS_PAGE_NAME_KEYS[location.pathname];
  const pageName = pageNameKey
    ? t(pageNameKey)
    : t('ops_access_denied.ops_page_fallback');

  const requiredRoles = REQUIRED_ROLE_KEYS.map((key) => t(key));
  const rolesText = requiredRoles.join(', ');

  return (
    <div
      data-testid="ops-access-denied"
      className="min-h-screen flex flex-col items-center justify-center px-4 bg-surface-secondary"
    >
      <div className="w-full max-w-lg bg-surface border border-border rounded-2xl shadow-sm p-8">
        <div className="flex flex-col items-center text-center">
          <div className="bg-danger/10 p-4 rounded-full mb-4">
            <ShieldX className="h-10 w-10 text-danger" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-semibold text-text-primary mb-2">
            {t('ops_access_denied.title')}
          </h1>
          <p
            data-testid="ops-access-denied-page-name"
            className="text-sm text-text-secondary mb-3"
          >
            {t('ops_access_denied.subtitle', { pageName })}
          </p>
          <p
            data-testid="ops-access-denied-roles"
            className="text-sm text-text-secondary mb-2"
          >
            {t('ops_access_denied.role_requirement', { roles: rolesText })}
          </p>
          {user?.email && (
            <p className="text-xs text-text-secondary/80 mb-6">
              {t('ops_access_denied.signed_in_as', { email: user.email })}
            </p>
          )}
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="px-4 py-2 text-sm font-medium bg-primary text-on-primary rounded-lg hover:bg-primary-hover transition"
          >
            {t('ops_access_denied.take_me_back')}
          </button>
        </div>
      </div>
    </div>
  );
}
