import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Plug,
  RotateCw,
  AlertCircle,
  CheckCircle,
  XCircle,
  Users,
  BookOpen,
} from 'lucide-react';
import { api } from '../../../../lib/api';

/**
 * Server-side env-var presence + per-tenant demand for each OAuth
 * connector provider. Lives in the Integrations tab. Extracted from
 * PlatformAdmin.tsx in Phase 2 of the god-file split.
 */
interface IntegrationProviderStatus {
  provider: string;
  connectorProvider: string;
  label: string;
  category: string;
  configured: boolean;
  requiredEnv: string[];
  missingEnv: string[];
  optionalEnv: { name: string; set: boolean }[];
  docsUrl: string;
  enabledTenantCount: number;
  totalTenantCount: number;
  attemptedTenantCount: number;
  /**
   * Distinct tenants who tried to start the OAuth flow for this provider
   * but were blocked because the server's credentials weren't configured
   * (Task #919). For un-configured providers this is usually the truest
   * demand signal since by definition no row will ever land in the
   * `integrations` table for them.
   */
  blockedAttemptCount: number;
}

interface IntegrationsStatusResponse {
  providers: IntegrationProviderStatus[];
  summary: {
    total: number;
    configured: number;
    missing: number;
    blockedTenantDemand: number;
  };
}

export function IntegrationsStatusPanel() {
  const { t: adminT } = useTranslation('admin');
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['platform-integrations-status'],
    queryFn: () => api.get<IntegrationsStatusResponse>('/platform/integrations-status'),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
        {adminT('platform_admin.integrations_panel.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center text-danger">
        {adminT('platform_admin.integrations_panel.load_failed', { error: error ? (error as Error).message : adminT('platform_admin.common.no_data') })}
      </div>
    );
  }

  const grouped = data.providers.reduce<Record<string, IntegrationProviderStatus[]>>((acc, p) => {
    (acc[p.category] ||= []).push(p);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-xl p-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold flex items-center gap-2">
            <Plug className="h-4 w-4 text-primary" /> {adminT('platform_admin.integrations_panel.title')}
          </h2>
          <p className="text-xs text-text-muted mt-1">
            {adminT('platform_admin.integrations_panel.subtitle_prefix')} <code className="font-mono">*_CLIENT_ID</code> /{' '}
            <code className="font-mono">*_CLIENT_SECRET</code> {adminT('platform_admin.integrations_panel.subtitle_suffix')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-text-muted">
            <span className="font-semibold text-success">{data.summary.configured}</span>
            {' / '}
            {adminT('platform_admin.integrations_panel.configured_count_suffix', { total: data.summary.total })}
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1.5 rounded hover:bg-surface-secondary text-text-muted hover:text-text-primary disabled:opacity-50"
            title={adminT('platform_admin.common.refresh_title')}
          >
            <RotateCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {data.summary.missing > 0 && (
        <div className="bg-warning-light border border-warning/40 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-warning flex-shrink-0 mt-0.5" />
          <div className="text-sm text-warning">
            <div className="font-medium">
              {adminT('platform_admin.integrations_panel.missing', { count: data.summary.missing })}
            </div>
            <p className="text-xs mt-1 opacity-80">
              {adminT('platform_admin.integrations_panel.missing_explainer')}
            </p>
            {data.summary.blockedTenantDemand > 0 && (
              <p className="text-xs mt-1 font-medium">
                {adminT('platform_admin.integrations_panel.blocked_demand', { count: data.summary.blockedTenantDemand })}
              </p>
            )}
          </div>
        </div>
      )}

      {Object.entries(grouped).map(([category, providers]) => (
        <div key={category} className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2 bg-surface-secondary/50 border-b border-border">
            <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{category}</h3>
          </div>
          <div className="divide-y divide-border">
            {[...providers]
              .sort((a, b) => {
                const aDemand = Math.max(
                  a.enabledTenantCount,
                  a.attemptedTenantCount,
                  a.blockedAttemptCount,
                );
                const bDemand = Math.max(
                  b.enabledTenantCount,
                  b.attemptedTenantCount,
                  b.blockedAttemptCount,
                );
                if (a.configured !== b.configured) return a.configured ? 1 : -1;
                return bDemand - aDemand;
              })
              .map((p) => (
              <div key={p.provider} className="px-4 py-4 flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{p.label}</span>
                    {p.configured ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-success-light text-success">
                        <CheckCircle className="h-3 w-3" /> {adminT('platform_admin.integrations_panel.configured_pill')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-danger-light text-danger">
                        <XCircle className="h-3 w-3" /> {adminT('platform_admin.integrations_panel.missing_pill')}
                      </span>
                    )}
                    {(p.enabledTenantCount > 0 || p.attemptedTenantCount > 0) && (
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          p.configured
                            ? 'bg-info-light text-info'
                            : 'bg-warning-light text-warning'
                        }`}
                        title={
                          p.configured
                            ? adminT('platform_admin.integrations_panel.active_title_configured', { enabled: p.enabledTenantCount, attempted: p.attemptedTenantCount })
                            : adminT('platform_admin.integrations_panel.active_title_unconfigured', { enabled: p.enabledTenantCount, attempted: p.attemptedTenantCount })
                        }
                      >
                        <Users className="h-3 w-3" />
                        {adminT('platform_admin.integrations_panel.active_pill', { active: p.enabledTenantCount })}
                        {p.attemptedTenantCount > p.enabledTenantCount && (
                          <span className="opacity-80">
                            {' '}{adminT('platform_admin.integrations_panel.active_ever', { count: p.attemptedTenantCount })}
                          </span>
                        )}
                      </span>
                    )}
                    {p.blockedAttemptCount > 0 && (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-danger-light text-danger"
                        title={adminT('platform_admin.integrations_panel.blocked_attempts_title', { count: p.blockedAttemptCount, vars: p.requiredEnv.join(' / ') })}
                      >
                        <AlertCircle className="h-3 w-3" />
                        {adminT('platform_admin.integrations_panel.blocked_attempts', { count: p.blockedAttemptCount })}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.requiredEnv.map((env) => {
                      const isMissing = p.missingEnv.includes(env);
                      return (
                        <code
                          key={env}
                          className={`text-xs font-mono px-2 py-0.5 rounded border ${
                            isMissing
                              ? 'bg-danger-light text-danger border-danger/30'
                              : 'bg-success-light text-success border-success/30'
                          }`}
                          title={isMissing ? adminT('platform_admin.integrations_panel.env_missing') : adminT('platform_admin.integrations_panel.env_set')}
                        >
                          {env}
                        </code>
                      );
                    })}
                  </div>
                  {p.optionalEnv.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 items-center">
                      <span className="text-xs text-text-muted">{adminT('platform_admin.integrations_panel.optional_label')}</span>
                      {p.optionalEnv.map((env) => (
                        <code
                          key={env.name}
                          className={`text-xs font-mono px-2 py-0.5 rounded border ${
                            env.set
                              ? 'bg-success-light text-success border-success/30'
                              : 'bg-surface-hover text-text-muted border-border'
                          }`}
                          title={env.set ? adminT('platform_admin.integrations_panel.env_set') : adminT('platform_admin.integrations_panel.env_optional_unset')}
                        >
                          {env.name}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
                <a
                  href={p.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-primary hover:underline whitespace-nowrap flex items-center gap-1 flex-shrink-0"
                >
                  <BookOpen className="h-3.5 w-3.5" /> {adminT('platform_admin.integrations_panel.setup_guide')}
                </a>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default IntegrationsStatusPanel;
