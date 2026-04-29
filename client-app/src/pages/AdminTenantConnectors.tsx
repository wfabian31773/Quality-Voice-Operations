import { useEffect, useMemo, useRef } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  Clock,
  Plug,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { api } from '../lib/api';
import GlobalScopeBanner from '../components/GlobalScopeBanner';

interface TenantInfo {
  id: string;
  name: string | null;
  slug: string | null;
  status: string | null;
  plan: string | null;
}

interface ConnectorRow {
  integrationId: string;
  connectorType: string;
  provider: string;
  name: string;
  isEnabled: boolean;
  configKeys: string[];
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
  autoDisabledAt: string | null;
}

interface AdminTenantConnectorsResponse {
  tenant: TenantInfo;
  connectors: ConnectorRow[];
}

interface ApiErrorShape {
  status?: number;
  message?: string;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function statusBadge(connector: ConnectorRow) {
  const status = connector.lastSyncStatus;
  if (!connector.isEnabled) {
    return {
      label: 'Disabled',
      icon: <Plug className="h-3.5 w-3.5" />,
      className:
        'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
    };
  }
  if (status === 'needs_reconnect') {
    return {
      label: 'Needs reconnect',
      icon: <ShieldAlert className="h-3.5 w-3.5" />,
      className:
        'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    };
  }
  if (status === 'error') {
    return {
      label: 'Sync error',
      icon: <AlertCircle className="h-3.5 w-3.5" />,
      className:
        'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    };
  }
  if (status === 'success') {
    return {
      label: 'Healthy',
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      className:
        'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    };
  }
  return {
    label: status ?? 'Pending',
    icon: <Clock className="h-3.5 w-3.5" />,
    className:
      'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  };
}

export default function AdminTenantConnectors() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const [searchParams] = useSearchParams();
  const focusIntegrationId = searchParams.get('integration');
  const focusRowRef = useRef<HTMLTableRowElement | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['admin-tenant-connectors', tenantId],
    queryFn: () =>
      api.get<AdminTenantConnectorsResponse>(
        `/platform/tenants/${tenantId}/connectors`,
      ),
    enabled: Boolean(tenantId),
    refetchInterval: 60_000,
    retry: (failureCount, err) => {
      const status = (err as ApiErrorShape | undefined)?.status ?? 0;
      // Don't keep hammering on 401/403/404 — those won't fix themselves.
      if (status === 401 || status === 403 || status === 404) return false;
      return failureCount < 2;
    },
  });

  const connectors = useMemo(() => data?.connectors ?? [], [data]);
  const tenant = data?.tenant ?? null;

  useEffect(() => {
    if (!focusIntegrationId || !focusRowRef.current) return;
    focusRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusIntegrationId, connectors.length]);

  const apiError = error as ApiErrorShape | undefined;
  const isForbidden = apiError?.status === 403;
  const isNotFound = apiError?.status === 404;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          to="/admin/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-purple-300 hover:text-purple-200"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Platform Admin
        </Link>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded border border-border bg-surface-secondary hover:bg-surface text-text-primary disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-white">
          {tenant ? `${tenant.name ?? 'Tenant'} · Connectors` : 'Tenant Connectors'}
        </h1>
        <p className="text-sm text-purple-200/70 mt-1">
          {tenant
            ? `Read-only view of connectors for ${tenant.slug ?? tenant.id} · plan ${tenant.plan ?? '—'} · status ${tenant.status ?? '—'}`
            : 'Loading tenant context…'}
        </p>
      </div>

      <GlobalScopeBanner
        variant="tenant"
        tenantName={tenant?.name ?? undefined}
        tenantSlug={tenant?.slug ?? undefined}
        description="You are inspecting another tenant's connector configuration as a platform admin. This view is read-only — make changes from inside that tenant's account if needed. Each load is logged in audit_logs."
      />

      {isForbidden && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          You don't have permission to view this tenant's connectors. This page
          requires platform-admin access.
        </div>
      )}

      {isNotFound && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          This tenant could not be found. It may have been deleted.
        </div>
      )}

      {error && !isForbidden && !isNotFound && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          Failed to load connectors for this tenant.
          {apiError?.message ? ` ${apiError.message}` : ''}
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold text-sm text-text-primary">
            Connectors{' '}
            <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
              {connectors.length}
            </span>
          </h2>
          {focusIntegrationId && (
            <span className="text-xs text-text-muted">
              Highlighting integration{' '}
              <span className="font-mono">{focusIntegrationId.slice(0, 8)}…</span>
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="px-4 py-12 text-center text-sm text-text-muted">
            Loading connectors…
          </div>
        ) : connectors.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-text-muted">
            This tenant hasn't configured any connectors yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Connector</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Last sync</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Last error</th>
                  <th className="text-left px-4 py-2 font-medium text-text-muted">Configured keys</th>
                </tr>
              </thead>
              <tbody>
                {connectors.map((c) => {
                  const isFocused = focusIntegrationId === c.integrationId;
                  const status = statusBadge(c);
                  const truncatedError =
                    c.lastSyncError && c.lastSyncError.length > 160
                      ? `${c.lastSyncError.slice(0, 160)}…`
                      : c.lastSyncError;
                  return (
                    <tr
                      key={c.integrationId}
                      ref={isFocused ? focusRowRef : null}
                      className={
                        'border-b border-border last:border-0 align-top ' +
                        (isFocused
                          ? 'bg-purple-50 dark:bg-purple-900/20 ring-1 ring-inset ring-purple-300 dark:ring-purple-700'
                          : '')
                      }
                    >
                      <td className="px-4 py-3 text-xs">
                        <div className="font-medium text-text-primary">{c.name}</div>
                        <div className="text-text-muted">
                          <span className="capitalize">{c.connectorType}</span>
                          {c.provider && c.provider !== c.name && (
                            <span className="font-mono"> · {c.provider}</span>
                          )}
                        </div>
                        <div className="text-text-muted/70 font-mono mt-0.5">
                          {c.integrationId.slice(0, 8)}…
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${status.className}`}
                        >
                          {status.icon}
                          {status.label}
                        </span>
                        {c.autoDisabledAt && (
                          <div className="text-text-muted mt-1">
                            Auto-disabled {formatRelativeTime(c.autoDisabledAt)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-text-muted whitespace-nowrap">
                        <span title={c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : 'never'}>
                          {formatRelativeTime(c.lastSyncAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {truncatedError ? (
                          <div
                            className="font-mono text-red-600 dark:text-red-400 break-all max-w-[420px]"
                            title={c.lastSyncError ?? ''}
                          >
                            {truncatedError}
                            {c.lastSyncErrorAt && (
                              <div className="text-text-muted font-sans mt-0.5">
                                {formatRelativeTime(c.lastSyncErrorAt)}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {c.configKeys.length === 0 ? (
                          <span className="text-text-muted">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {c.configKeys.map((k) => (
                              <span
                                key={k}
                                className="inline-flex items-center px-1.5 py-0.5 rounded bg-surface-secondary border border-border font-mono text-[10px] text-text-muted"
                              >
                                {k}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
