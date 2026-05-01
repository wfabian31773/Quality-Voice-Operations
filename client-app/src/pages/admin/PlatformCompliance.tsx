import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  Shield, Download, Lock, FileText, Building2, Users, Trash2,
  CheckCircle2, AlertTriangle, RefreshCw, ChevronLeft, ChevronRight,
  Plus, Server, Activity, KeyRound, Globe, Mail, Zap, ArrowUpRight,
  PhoneOff, BellOff, Bell,
} from 'lucide-react';
import { EmptyState, Skeleton } from '../../components/state';
import { StatCard, PageHeader } from '../../components/ui';

function TenantLink({
  tenantId,
  name,
  slug,
  compact = false,
}: {
  tenantId: string;
  name: string | null;
  slug: string | null;
  compact?: boolean;
}) {
  const displayName = name ?? slug ?? tenantId.slice(0, 8);
  const displaySlug = slug ?? tenantId.slice(0, 8);
  return (
    <Link
      to={`/admin/analytics/tenants/${tenantId}`}
      className="group inline-flex flex-col gap-0.5 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
      title={`View ${displayName}`}
      aria-label={`View ${displayName} tenant analytics`}
    >
      <span className={`inline-flex items-center gap-1 font-medium ${compact ? 'text-xs' : ''}`}>
        <span className="group-hover:underline">{displayName}</span>
        <ArrowUpRight className={`${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} opacity-0 group-hover:opacity-100 transition-opacity`} />
      </span>
      <span className={`${compact ? 'text-[10px]' : 'text-[11px]'} text-muted font-mono`}>{displaySlug}</span>
    </Link>
  );
}

type Tab =
  | 'overview'
  | 'audit'
  | 'encryption'
  | 'federal-dnc'
  | 'subprocessors'
  | 'deletions'
  | 'isolation'
  | 'admins';

interface OverviewData {
  tenants: { total_tenants: number; active_tenants: number; suspended_tenants: number };
  encryption: {
    encrypted_tenants: number; active_keys: number; rotated_keys: number;
    last_key_created_at: string | null; last_key_rotated_at: string | null;
  };
  subprocessors: { total: number; active: number };
  deletionRequests: { pending: number; cancelled: number; completed: number };
  auditEvents: { last_24h: number; last_7d: number; critical_7d: number; warning_7d: number };
  isolationTests: { total_runs: number; passed: number; failed: number; last_run_at: string | null };
  platformAdmins: { total: number };
}

interface PlatformAuditEvent {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  tenant_slug: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  changes: Record<string, unknown>;
  severity: string;
  ip_address: string | null;
  occurred_at: string;
  actor_email: string | null;
  actor_role: string | null;
}

interface EncryptionRow {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  tenant_status: string;
  plan: string;
  active_keys: number;
  total_keys: number;
  last_key_created_at: string | null;
  last_rotation_at: string | null;
  encrypted_field_count: number;
  encrypted_tables: string[];
  owner_user_id: string | null;
  owner_email: string | null;
  owner_first_name: string | null;
  owner_last_name: string | null;
  last_reminded_at: string | null;
  last_reminded_by_email: string | null;
  encryption_reminder_paused: boolean;
  encryption_reminder_paused_at: string | null;
  encryption_reminder_paused_reason: string | null;
  encryption_reminder_paused_by_email: string | null;
}

interface EncryptionResponse {
  tenants: EncryptionRow[];
  summary: {
    total: number;
    needs_initialization: number;
    with_active_keys: number;
  };
}

interface Subprocessor {
  id: string;
  name: string;
  purpose: string;
  data_types: string;
  location: string | null;
  website: string | null;
  is_active: boolean;
  display_order: number;
  added_at: string;
  updated_at: string;
}

interface DeletionRequest {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  tenant_status: string;
  requested_by: string;
  requested_by_email: string | null;
  requested_at: string;
  scheduled_for: string;
  cancelled_at: string | null;
  status: 'pending' | 'cancelled' | 'completed';
  reason: string | null;
  cancelled_by_email: string | null;
}

interface IsolationTest {
  id: string;
  test_name: string;
  test_result: 'pass' | 'fail';
  details: { details?: string } | Record<string, unknown>;
  run_at: string;
  source?: 'manual' | 'scheduled';
  run_id?: string | null;
}

interface IsolationRunSummary {
  passed: number;
  failed: number;
  run_at: string | null;
  run_id: string | null;
}

interface IsolationSchedulerStatus {
  intervalMs: number;
  isRunning: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  nextRunAt: string | null;
  lastRunFailed: number;
  lastRunPassed: number;
  lastRunId: string | null;
}

interface IsolationData {
  recent: IsolationTest[];
  summary: { passed: number; failed: number; last_run_at: string | null };
  lastRun: IsolationTest[];
  lastScheduledRunAt: string | null;
  lastManualRunAt: string | null;
  lastScheduledRunSummary: IsolationRunSummary | null;
  lastManualRunSummary: IsolationRunSummary | null;
  scheduler: IsolationSchedulerStatus;
}

interface PlatformAdmin {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  last_login_at: string | null;
  tenant_role_count: number;
}

const TABS: { id: Tab; label: string; icon: typeof Shield }[] = [
  { id: 'overview', label: 'Overview', icon: Shield },
  { id: 'audit', label: 'Platform Audit Log', icon: FileText },
  { id: 'encryption', label: 'Encryption', icon: Lock },
  { id: 'federal-dnc', label: 'Federal DNC', icon: PhoneOff },
  { id: 'subprocessors', label: 'Sub-processors', icon: Globe },
  { id: 'deletions', label: 'Deletion Requests', icon: Trash2 },
  { id: 'isolation', label: 'Tenant Isolation', icon: Server },
  { id: 'admins', label: 'Platform Admins', icon: Users },
];

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

function formatDateOnly(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString();
}

function severityClasses(sev: string): string {
  if (sev === 'critical') return 'bg-danger-light text-danger';
  if (sev === 'warning') return 'bg-warning-light text-warning';
  return 'bg-surface-hover text-text-secondary';
}

function OverviewTab() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['platform-compliance-overview'],
    queryFn: () => api.get<OverviewData>('/platform/compliance/overview'),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }
  if (error || !data) {
    return <EmptyState icon={AlertTriangle} title="Could not load overview" />;
  }

  const isolationTotal = data.isolationTests.passed + data.isolationTests.failed;
  const isolationPassRate = isolationTotal > 0
    ? Math.round((data.isolationTests.passed / isolationTotal) * 100)
    : null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Building2}
          label="Active tenants"
          value={data.tenants.active_tenants}
          sub={`${data.tenants.total_tenants} total · ${data.tenants.suspended_tenants} suspended`}
          tone="neutral"
        />
        <StatCard
          icon={Lock}
          label="Tenants with encryption"
          value={data.encryption.encrypted_tenants}
          sub={`${data.encryption.active_keys} active keys · ${data.encryption.rotated_keys} rotations`}
          tone={data.encryption.encrypted_tenants > 0 ? 'success' : 'warning'}
        />
        <StatCard
          icon={Globe}
          label="Active sub-processors"
          value={data.subprocessors.active}
          sub={`${data.subprocessors.total} on the published list`}
          tone="neutral"
        />
        <StatCard
          icon={Users}
          label="Platform admins"
          value={data.platformAdmins.total}
          sub="Users with cross-tenant access"
          tone="neutral"
        />
        <StatCard
          icon={Activity}
          label="Audit events (24h)"
          value={data.auditEvents.last_24h.toLocaleString()}
          sub={`${data.auditEvents.last_7d.toLocaleString()} in the last 7 days`}
          tone="neutral"
        />
        <StatCard
          icon={AlertTriangle}
          label="Critical events (7d)"
          value={data.auditEvents.critical_7d}
          sub={`${data.auditEvents.warning_7d} warnings`}
          tone={data.auditEvents.critical_7d > 0 ? 'danger' : 'success'}
        />
        <StatCard
          icon={Trash2}
          label="Pending deletions"
          value={data.deletionRequests.pending}
          sub={`${data.deletionRequests.completed} completed · ${data.deletionRequests.cancelled} cancelled`}
          tone={data.deletionRequests.pending > 0 ? 'warning' : 'neutral'}
        />
        <StatCard
          icon={Server}
          label="Isolation pass rate (30d)"
          value={isolationPassRate === null ? '—' : `${isolationPassRate}%`}
          sub={data.isolationTests.last_run_at
            ? `Last run ${formatDate(data.isolationTests.last_run_at)}`
            : 'Run the suite from the Tenant Isolation tab'}
          tone={data.isolationTests.failed > 0 ? 'danger' : isolationPassRate === 100 ? 'success' : 'neutral'}
        />
      </div>

      <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          Platform compliance posture
        </h3>
        <ul className="text-sm text-muted space-y-2">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
            Audit log is append-only at the database level (UPDATE/DELETE blocked by trigger).
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
            Every tenant is isolated by Row-Level Security policies that this view re-tests on demand.
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
            Tenant secrets and PII fields are encrypted with per-tenant data encryption keys (AES-256-GCM).
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
            All third parties that process customer data are listed publicly at <code>/subprocessors</code>.
          </li>
        </ul>
      </div>
    </div>
  );
}

const SEVERITY_OPTIONS = [
  { value: '', label: 'Any severity' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

function PlatformAuditTab() {
  // Honor query-string seed values so other admin surfaces can deep-link
  // straight into a pre-filtered audit view (e.g. the Plan Recommendation
  // Emails table opens an exact-match audit drilldown for a single
  // tenant + action). Read once on mount; further edits live in local
  // state so the user can broaden the filter without the URL fighting
  // them back.
  const [searchParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [tenantId, setTenantId] = useState(
    () => searchParams.get('tenantId')?.trim() ?? '',
  );
  const [action, setAction] = useState(
    () => searchParams.get('action')?.trim() ?? '',
  );
  const [severity, setSeverity] = useState(
    () => searchParams.get('severity')?.trim() ?? '',
  );
  const [since, setSince] = useState(() => searchParams.get('since') ?? '');
  const [until, setUntil] = useState(() => searchParams.get('until') ?? '');
  // When deep-linked from another admin surface (e.g. the Plan
  // Recommendation Emails table), highlight + scroll to the exact
  // matching audit row. Held in a ref so it doesn't survive a manual
  // filter change after the user starts exploring.
  const highlightAuditLogId = useMemo(
    () => searchParams.get('auditLogId')?.trim() ?? '',
    [searchParams],
  );
  const limit = 50;

  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  if (tenantId.trim()) params.set('tenantId', tenantId.trim());
  if (action.trim()) params.set('action', action.trim());
  if (severity) params.set('severity', severity);
  if (since) params.set('since', new Date(since).toISOString());
  if (until) params.set('until', new Date(until + 'T23:59:59').toISOString());

  const { data, isLoading } = useQuery({
    queryKey: ['platform-audit-log', page, tenantId, action, severity, since, until],
    queryFn: () => api.get<{ events: PlatformAuditEvent[]; total: number }>(`/platform/compliance/audit-log?${params}`),
    refetchInterval: 60_000,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  const highlightedRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (!highlightAuditLogId) return;
    if (!data?.events.some((e) => e.id === highlightAuditLogId)) return;
    // Defer to next tick so the row mounts before we scroll.
    const t = window.setTimeout(() => {
      highlightedRowRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 0);
    return () => window.clearTimeout(t);
  }, [highlightAuditLogId, data]);

  const handleExport = () => {
    const exportParams = new URLSearchParams();
    if (tenantId.trim()) exportParams.set('tenantId', tenantId.trim());
    if (action.trim()) exportParams.set('action', action.trim());
    if (severity) exportParams.set('severity', severity);
    if (since) exportParams.set('since', new Date(since).toISOString());
    if (until) exportParams.set('until', new Date(until + 'T23:59:59').toISOString());
    window.open(`/api/platform/compliance/audit-log/export?${exportParams}`, '_blank');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <input
          type="text"
          value={tenantId}
          onChange={(e) => { setTenantId(e.target.value); setPage(1); }}
          placeholder="Tenant ID"
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm w-48"
        />
        <input
          type="text"
          value={action}
          onChange={(e) => { setAction(e.target.value); setPage(1); }}
          placeholder="Action (e.g. user.role_changed)"
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm w-64"
        />
        <select
          value={severity}
          onChange={(e) => { setSeverity(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm"
        >
          {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input
          type="date"
          value={since}
          onChange={(e) => { setSince(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm"
        />
        <input
          type="date"
          value={until}
          onChange={(e) => { setUntil(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm"
        />
        {(tenantId || action || severity || since || until) && (
          <button
            onClick={() => {
              setTenantId(''); setAction(''); setSeverity(''); setSince(''); setUntil(''); setPage(1);
            }}
            className="px-3 py-2 text-sm text-muted hover:text-foreground"
          >
            Clear
          </button>
        )}
        <button
          onClick={handleExport}
          className="ml-auto flex items-center gap-2 px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:bg-primary/90"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </button>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-muted">Timestamp</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Tenant</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Actor</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Action</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Resource</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Severity</th>
                <th className="text-left px-4 py-3 font-medium text-muted">IP</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} className="px-4 py-3"><Skeleton className="h-8 w-full" /></td></tr>
              ) : !data?.events.length ? (
                <tr><td colSpan={7} className="p-0"><EmptyState icon={FileText} title="No matching audit events" variant="compact" /></td></tr>
              ) : (
                data.events.map((e) => {
                  const isHighlighted =
                    !!highlightAuditLogId && e.id === highlightAuditLogId;
                  return (
                  <tr
                    key={e.id}
                    ref={isHighlighted ? highlightedRowRef : undefined}
                    data-testid={
                      isHighlighted ? 'audit-row-highlighted' : undefined
                    }
                    className={`border-b border-border last:border-0 hover:bg-surface-secondary/50 ${
                      isHighlighted ? 'bg-primary/10 ring-2 ring-primary/40' : ''
                    }`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-muted text-xs">{formatDate(e.occurred_at)}</td>
                    <td className="px-4 py-3">
                      <TenantLink tenantId={e.tenant_id} name={e.tenant_name} slug={e.tenant_slug} compact />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-xs">{e.actor_email ?? 'System'}</div>
                      {e.actor_role && <div className="text-[10px] text-muted">{e.actor_role}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-primary/10 text-primary">
                        {e.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted text-xs">
                      {e.resource_type}
                      {e.resource_id && <span className="ml-1 font-mono">{e.resource_id.slice(0, 8)}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${severityClasses(e.severity)}`}>
                        {e.severity ?? 'info'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted text-xs font-mono">{e.ip_address ?? '—'}</td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {data && data.total > limit && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-sm text-muted">{data.total.toLocaleString()} events total</span>
            <div className="flex items-center gap-2">
              <button disabled={page === 1} onClick={() => setPage(page - 1)} className="p-1 rounded hover:bg-surface-secondary disabled:opacity-50">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm">Page {page} of {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="p-1 rounded hover:bg-surface-secondary disabled:opacity-50">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EncryptionTab() {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [actionMessage, setActionMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  const [pendingTenant, setPendingTenant] = useState<{
    action: 'remind' | 'initialize' | 'pause';
    tenantId: string;
  } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['platform-compliance-encryption'],
    queryFn: () => api.get<EncryptionResponse>('/platform/compliance/encryption'),
  });

  const remindMutation = useMutation({
    mutationFn: (tenantId: string) =>
      api.post<{ sent: boolean; ownerEmail: string; sentAt: string }>(
        `/platform/compliance/encryption/remind/${tenantId}`,
      ),
    onMutate: (tenantId) => {
      setActionMessage(null);
      setPendingTenant({ action: 'remind', tenantId });
    },
    onSuccess: (result) => {
      setActionMessage({
        kind: 'success',
        text: `Reminder sent to ${result.ownerEmail}.`,
      });
      queryClient.invalidateQueries({ queryKey: ['platform-compliance-encryption'] });
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : 'Failed to send reminder.';
      setActionMessage({ kind: 'error', text: message });
    },
    onSettled: () => setPendingTenant(null),
  });

  const pauseMutation = useMutation({
    mutationFn: (vars: { tenantId: string; paused: boolean; reason?: string | null }) =>
      api.patch<{
        tenantId: string;
        paused: boolean;
        pausedAt: string | null;
        reason: string | null;
      }>(`/platform/compliance/encryption/pause/${vars.tenantId}`, {
        paused: vars.paused,
        reason: vars.reason ?? null,
      }),
    onMutate: (vars) => {
      setActionMessage(null);
      setPendingTenant({ action: 'pause', tenantId: vars.tenantId });
    },
    onSuccess: (result) => {
      setActionMessage({
        kind: 'success',
        text: result.paused
          ? 'Automated encryption reminders paused for this tenant. The manual "Send reminder" button still works.'
          : 'Automated encryption reminders resumed for this tenant.',
      });
      queryClient.invalidateQueries({ queryKey: ['platform-compliance-encryption'] });
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : 'Failed to update reminder pause flag.';
      setActionMessage({ kind: 'error', text: message });
    },
    onSettled: () => setPendingTenant(null),
  });

  const initializeMutation = useMutation({
    mutationFn: (tenantId: string) =>
      api.post<{ keyId: string; status: string }>(
        `/platform/compliance/encryption/initialize/${tenantId}`,
      ),
    onMutate: (tenantId) => {
      setActionMessage(null);
      setPendingTenant({ action: 'initialize', tenantId });
    },
    onSuccess: () => {
      setActionMessage({
        kind: 'success',
        text: 'Encryption initialized. The tenant now has an active data encryption key.',
      });
      queryClient.invalidateQueries({ queryKey: ['platform-compliance-encryption'] });
      queryClient.invalidateQueries({ queryKey: ['platform-compliance-overview'] });
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : 'Failed to initialize encryption.';
      setActionMessage({ kind: 'error', text: message });
    },
    onSettled: () => setPendingTenant(null),
  });

  const summary = data?.summary;
  const allTenants = data?.tenants ?? [];
  const filteredTenants = onlyGaps
    ? allTenants.filter((t) => t.active_keys === 0)
    : allTenants;

  const needsInit = summary?.needs_initialization ?? 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Per-tenant data encryption keys (DEKs) wrapped by the platform key. Keys are AES-256-GCM and rotated on demand from the tenant Compliance view.
      </p>

      {summary && (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            icon={Building2}
            label="Tenants tracked"
            value={summary.total}
            sub="Includes active and suspended"
            tone="neutral"
          />
          <StatCard
            icon={KeyRound}
            label="With active key"
            value={summary.with_active_keys}
            sub="Encryption already enabled"
            tone={summary.with_active_keys > 0 ? 'success' : 'neutral'}
          />
          <StatCard
            icon={AlertTriangle}
            label="Needs initialization"
            value={summary.needs_initialization}
            sub={summary.needs_initialization > 0 ? 'Action required' : 'All tenants encrypted'}
            tone={summary.needs_initialization > 0 ? 'warning' : 'success'}
          />
        </div>
      )}

      {needsInit > 0 && (
        <div className="rounded-xl border border-warning bg-warning-light p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-warning mt-0.5 shrink-0" />
          <div className="flex-1 text-sm">
            <div className="font-semibold text-warning">
              {needsInit === 1
                ? '1 tenant has not enabled encryption yet'
                : `${needsInit} tenants have not enabled encryption yet`}
            </div>
            <p className="text-warning mt-1">
              These tenants are running without an active data encryption key. Send the owner a templated reminder, or initialize encryption on their behalf where policy allows. Both actions are written to the platform audit log.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={onlyGaps}
            onChange={(e) => setOnlyGaps(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          Only show tenants needing initialization
        </label>
        {!isLoading && (
          <span className="text-xs text-muted">
            Showing {filteredTenants.length} of {allTenants.length}
          </span>
        )}
      </div>

      {actionMessage && (
        <div
          className={`rounded-lg border p-3 text-sm flex items-start gap-2 ${
            actionMessage.kind === 'success'
              ? 'border-success bg-success-light text-success'
              : 'border-danger bg-danger-light text-danger'
          }`}
        >
          {actionMessage.kind === 'success' ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          )}
          <div className="flex-1">{actionMessage.text}</div>
          <button
            onClick={() => setActionMessage(null)}
            className="text-xs underline hover:no-underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-muted">Tenant</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Plan</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Active keys</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Owner</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Encrypted fields</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Last rotation</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Last reminder</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={9} className="px-4 py-3"><Skeleton className="h-8 w-full" /></td></tr>
              ) : !filteredTenants.length ? (
                <tr>
                  <td colSpan={9} className="p-0">
                    <EmptyState
                      icon={onlyGaps ? CheckCircle2 : Lock}
                      title={onlyGaps ? 'All tenants have an active encryption key' : 'No tenants'}
                      variant="compact"
                    />
                  </td>
                </tr>
              ) : (
                filteredTenants.map((t) => {
                  const needsInitialization = t.active_keys === 0;
                  const ownerName = [t.owner_first_name, t.owner_last_name]
                    .filter(Boolean)
                    .join(' ')
                    .trim();
                  const isRemindingThis =
                    pendingTenant?.action === 'remind' && pendingTenant.tenantId === t.tenant_id;
                  const isInitializingThis =
                    pendingTenant?.action === 'initialize' && pendingTenant.tenantId === t.tenant_id;
                  const isPausingThis =
                    pendingTenant?.action === 'pause' && pendingTenant.tenantId === t.tenant_id;
                  const reminderPaused = !!t.encryption_reminder_paused;

                  return (
                    <tr
                      key={t.tenant_id}
                      className={`border-b border-border last:border-0 ${
                        needsInitialization
                          ? 'bg-warning-light'
                          : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <TenantLink tenantId={t.tenant_id} name={t.tenant_name} slug={t.tenant_slug} />
                      </td>
                      <td className="px-4 py-3 text-xs text-muted capitalize">{t.plan}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                          t.tenant_status === 'active'
                            ? 'bg-success-light text-success'
                            : 'bg-surface-hover text-text-secondary'
                        }`}>
                          {t.tenant_status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {t.active_keys > 0 ? (
                          <span className="inline-flex items-center gap-1 text-success text-xs font-medium">
                            <KeyRound className="h-3.5 w-3.5" /> {t.active_keys}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warning-light text-warning text-[11px] font-medium">
                            <AlertTriangle className="h-3 w-3" /> Not initialized
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {t.owner_email ? (
                          <div>
                            {ownerName && <div className="font-medium">{ownerName}</div>}
                            <div className="text-[11px] text-muted break-all">{t.owner_email}</div>
                          </div>
                        ) : (
                          <span className="text-[11px] text-muted italic">No active owner</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {t.encrypted_field_count > 0 ? (
                          <div>
                            <div className="font-medium">{t.encrypted_field_count.toLocaleString()}</div>
                            <div className="text-[11px] text-muted">{t.encrypted_tables.join(', ')}</div>
                          </div>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">{formatDateOnly(t.last_rotation_at)}</td>
                      <td className="px-4 py-3 text-xs">
                        {t.last_reminded_at ? (
                          <div>
                            <div className="text-muted">{formatDate(t.last_reminded_at)}</div>
                            <div className="text-[10px] text-muted">
                              {t.last_reminded_by_email
                                ? `by ${t.last_reminded_by_email}`
                                : 'by automated scheduler'}
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                        {reminderPaused && (
                          <div
                            className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-hover text-[10px] text-muted"
                            title={
                              t.encryption_reminder_paused_reason
                                ? `Paused: ${t.encryption_reminder_paused_reason}`
                                : 'Automated nudge paused for this tenant'
                            }
                          >
                            <BellOff className="h-3 w-3" />
                            Auto-nudge paused
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {needsInitialization ? (
                          <div className="flex flex-col gap-1.5">
                            <button
                              onClick={() => remindMutation.mutate(t.tenant_id)}
                              disabled={
                                !t.owner_email ||
                                isRemindingThis ||
                                isInitializingThis
                              }
                              title={
                                t.owner_email
                                  ? `Send a templated reminder to ${t.owner_email}`
                                  : 'No active owner email on file'
                              }
                              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Mail className="h-3.5 w-3.5" />
                              {isRemindingThis ? 'Sending…' : 'Send reminder'}
                            </button>
                            <button
                              onClick={() => {
                                if (
                                  confirm(
                                    adminT('platform_admin.compliance.confirm_initialize_encryption', { tenant: t.tenant_name }),
                                  )
                                ) {
                                  initializeMutation.mutate(t.tenant_id);
                                }
                              }}
                              disabled={isRemindingThis || isInitializingThis || isPausingThis}
                              className="inline-flex items-center gap-1.5 text-xs font-medium text-warning hover:text-warning disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Zap className="h-3.5 w-3.5" />
                              {isInitializingThis ? 'Initializing…' : 'Initialize now'}
                            </button>
                            <button
                              onClick={() => {
                                if (reminderPaused) {
                                  pauseMutation.mutate({
                                    tenantId: t.tenant_id,
                                    paused: false,
                                  });
                                  return;
                                }
                                const reason =
                                  prompt(
                                    `Pause the automated encryption reminder for ${t.tenant_name}?\n\nThe daily scheduler will skip this tenant. The manual "Send reminder" button above will still work.\n\nOptional reason (visible to other platform admins):`,
                                    '',
                                  );
                                if (reason === null) return;
                                pauseMutation.mutate({
                                  tenantId: t.tenant_id,
                                  paused: true,
                                  reason: reason.trim() || null,
                                });
                              }}
                              disabled={isRemindingThis || isInitializingThis || isPausingThis}
                              title={
                                reminderPaused
                                  ? 'Resume the automated reminder cadence for this tenant'
                                  : 'Pause the automated reminder cadence (manual sends still work)'
                              }
                              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {reminderPaused ? (
                                <Bell className="h-3.5 w-3.5" />
                              ) : (
                                <BellOff className="h-3.5 w-3.5" />
                              )}
                              {isPausingThis
                                ? 'Updating…'
                                : reminderPaused
                                  ? 'Resume auto-nudge'
                                  : 'Pause auto-nudge'}
                            </button>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] text-success">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Compliant
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SubprocessorsTab() {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', purpose: '', data_types: '', location: 'United States', website: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['platform-subprocessors'],
    queryFn: () => api.get<{ subprocessors: Subprocessor[] }>('/admin/subprocessors'),
  });

  const createMutation = useMutation({
    mutationFn: () => api.post('/admin/subprocessors', form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-subprocessors'] });
      setShowAdd(false);
      setForm({ name: '', purpose: '', data_types: '', location: 'United States', website: '' });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api.patch(`/admin/subprocessors/${id}`, { is_active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-subprocessors'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/subprocessors/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-subprocessors'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Active sub-processors are published at <code>/subprocessors</code> and surface in the security posture document.
        </p>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          Add sub-processor
        </button>
      </div>

      {showAdd && (
        <div className="bg-surface border border-border rounded-xl p-4 grid gap-3 sm:grid-cols-2">
          <input
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="px-3 py-2 rounded-lg border border-border bg-surface text-sm"
          />
          <input
            placeholder="Location"
            value={form.location}
            onChange={(e) => setForm({ ...form, location: e.target.value })}
            className="px-3 py-2 rounded-lg border border-border bg-surface text-sm"
          />
          <input
            placeholder="Website (https://...)"
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
            className="px-3 py-2 rounded-lg border border-border bg-surface text-sm sm:col-span-2"
          />
          <input
            placeholder="Purpose"
            value={form.purpose}
            onChange={(e) => setForm({ ...form, purpose: e.target.value })}
            className="px-3 py-2 rounded-lg border border-border bg-surface text-sm sm:col-span-2"
          />
          <textarea
            placeholder="Data types processed"
            value={form.data_types}
            onChange={(e) => setForm({ ...form, data_types: e.target.value })}
            className="px-3 py-2 rounded-lg border border-border bg-surface text-sm sm:col-span-2 min-h-20"
          />
          <div className="flex gap-2 sm:col-span-2">
            <button
              onClick={() => createMutation.mutate()}
              disabled={!form.name || !form.purpose || !form.data_types || createMutation.isPending}
              className="px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm text-muted hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-muted">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Purpose</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Data types</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Location</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="px-4 py-3"><Skeleton className="h-8 w-full" /></td></tr>
              ) : !data?.subprocessors.length ? (
                <tr><td colSpan={6} className="p-0"><EmptyState icon={Globe} title="No sub-processors yet" variant="compact" /></td></tr>
              ) : (
                data.subprocessors.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{s.name}</div>
                      {s.website && (
                        <a href={s.website} target="_blank" rel="noopener noreferrer" className="text-[11px] text-primary hover:underline">
                          {s.website}
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">{s.purpose}</td>
                    <td className="px-4 py-3 text-xs text-muted">{s.data_types}</td>
                    <td className="px-4 py-3 text-xs text-muted">{s.location}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        s.is_active
                          ? 'bg-success-light text-success'
                          : 'bg-surface-hover text-text-secondary'
                      }`}>
                        {s.is_active ? 'Published' : 'Hidden'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => toggleMutation.mutate({ id: s.id, is_active: !s.is_active })}
                          disabled={toggleMutation.isPending}
                          className="text-xs text-primary font-medium hover:text-primary/80"
                        >
                          {s.is_active ? 'Hide' : 'Publish'}
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(adminT('platform_admin.compliance.confirm_delete_subprocessor', { name: s.name }))) deleteMutation.mutate(s.id);
                          }}
                          disabled={deleteMutation.isPending}
                          className="text-xs text-danger font-medium hover:text-danger"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function DeletionRequestsTab() {
  const [statusFilter, setStatusFilter] = useState('');
  const params = new URLSearchParams();
  if (statusFilter) params.set('status', statusFilter);

  const { data, isLoading } = useQuery({
    queryKey: ['platform-deletion-requests', statusFilter],
    queryFn: () => api.get<{ requests: DeletionRequest[] }>(`/platform/compliance/deletion-requests?${params}`),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm"
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="cancelled">Cancelled</option>
          <option value="completed">Completed</option>
        </select>
        <p className="text-sm text-muted">
          Tenants self-serve account deletion. Requests sit in a 30-day cool-off window before purge.
        </p>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-muted">Tenant</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Requested by</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Requested</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Scheduled purge</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Reason</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="px-4 py-3"><Skeleton className="h-8 w-full" /></td></tr>
              ) : !data?.requests.length ? (
                <tr><td colSpan={6} className="p-0"><EmptyState icon={Trash2} title="No deletion requests" variant="compact" /></td></tr>
              ) : (
                data.requests.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <TenantLink tenantId={r.tenant_id} name={r.tenant_name} slug={r.tenant_slug} />
                    </td>
                    <td className="px-4 py-3 text-xs">{r.requested_by_email ?? r.requested_by.slice(0, 8)}</td>
                    <td className="px-4 py-3 text-xs text-muted">{formatDate(r.requested_at)}</td>
                    <td className="px-4 py-3 text-xs">
                      {r.status === 'pending' ? (
                        <span className="font-medium">{formatDate(r.scheduled_for)}</span>
                      ) : (
                        <span className="text-muted">{formatDate(r.scheduled_for)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                        r.status === 'pending'
                          ? 'bg-warning-light text-warning'
                          : r.status === 'completed'
                            ? 'bg-danger-light text-danger'
                            : 'bg-surface-hover text-text-secondary'
                      }`}>
                        {r.status}
                      </span>
                      {r.cancelled_by_email && (
                        <div className="text-[10px] text-muted mt-1">cancelled by {r.cancelled_by_email}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted max-w-sm truncate">{r.reason ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function formatInterval(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? 'every day' : `every ${days} days`;
  }
  return hours === 1 ? 'every hour' : `every ${hours} hours`;
}

function IsolationTab() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['platform-isolation-tests'],
    queryFn: () => api.get<IsolationData>('/platform/compliance/isolation-tests'),
    refetchInterval: 60_000,
  });

  const runMutation = useMutation({
    mutationFn: () => api.post<{ passed: number; failed: number }>('/platform/compliance/isolation-tests/run'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-isolation-tests'] }),
  });

  const summary = data?.summary;
  const total = (summary?.passed ?? 0) + (summary?.failed ?? 0);
  const passRate = total > 0 ? Math.round(((summary?.passed ?? 0) / total) * 100) : null;
  const scheduler = data?.scheduler;
  const lastScheduled = data?.lastScheduledRunSummary;
  const lastManual = data?.lastManualRunSummary;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm text-muted">
            Verifies that Row-Level Security is enabled on tenant-scoped tables and that one tenant cannot read another tenant's data.
            A background job runs the full suite {scheduler ? formatInterval(scheduler.intervalMs) : 'every day'} and pages
            platform admins on any failure. You can also re-run it on demand.
          </p>
          {summary?.last_run_at && (
            <p className="text-xs text-muted mt-1">Most recent run {formatDate(summary.last_run_at)}</p>
          )}
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${runMutation.isPending ? 'animate-spin' : ''}`} />
          {runMutation.isPending ? 'Running…' : 'Run isolation tests'}
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-4 space-y-1">
          <div className="text-xs uppercase tracking-wide text-muted font-medium flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" /> Last automated run
          </div>
          <div className="text-sm font-semibold">
            {lastScheduled?.run_at ? formatDate(lastScheduled.run_at) : 'Not yet'}
          </div>
          {lastScheduled && lastScheduled.run_at && (
            <div className="text-[11px] text-muted">
              {lastScheduled.passed} passed · {lastScheduled.failed} failed
            </div>
          )}
        </div>
        <div className="rounded-xl border border-border bg-surface p-4 space-y-1">
          <div className="text-xs uppercase tracking-wide text-muted font-medium flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" /> Last manual run
          </div>
          <div className="text-sm font-semibold">
            {lastManual?.run_at ? formatDate(lastManual.run_at) : 'Not yet'}
          </div>
          {lastManual && lastManual.run_at && (
            <div className="text-[11px] text-muted">
              {lastManual.passed} passed · {lastManual.failed} failed
            </div>
          )}
        </div>
        <div className="rounded-xl border border-border bg-surface p-4 space-y-1">
          <div className="text-xs uppercase tracking-wide text-muted font-medium flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5" /> Next scheduled run
          </div>
          <div className="text-sm font-semibold">
            {scheduler?.nextRunAt ? formatDate(scheduler.nextRunAt) : 'Scheduler not running'}
          </div>
          <div className="text-[11px] text-muted">
            {scheduler?.isRunning
              ? `Background job runs ${formatInterval(scheduler.intervalMs)}`
              : 'Background job is not active in this environment'}
          </div>
        </div>
      </div>

      {summary && (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            icon={CheckCircle2}
            label="Passed (30d)"
            value={summary.passed}
            tone="success"
          />
          <StatCard
            icon={AlertTriangle}
            label="Failed (30d)"
            value={summary.failed}
            tone={summary.failed > 0 ? 'danger' : 'neutral'}
          />
          <StatCard
            icon={Activity}
            label="Pass rate"
            value={passRate === null ? '—' : `${passRate}%`}
            tone={passRate === 100 ? 'success' : summary.failed > 0 ? 'danger' : 'neutral'}
          />
        </div>
      )}

      {data?.lastRun && data.lastRun.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-4 space-y-2">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            Latest run details
            {data.lastRun[0]?.source && (
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide ${
                data.lastRun[0].source === 'scheduled'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-surface-hover text-text-secondary'
              }`}>
                {data.lastRun[0].source === 'scheduled' ? 'automated' : 'manual'}
              </span>
            )}
          </h3>
          <ul className="space-y-1.5 text-sm">
            {data.lastRun.map((r) => (
              <li key={r.id} className="flex items-start gap-2">
                {r.test_result === 'pass' ? (
                  <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-danger mt-0.5 shrink-0" />
                )}
                <div>
                  <div className="font-medium text-xs">{r.test_name}</div>
                  {r.details && typeof r.details === 'object' && 'details' in r.details && (
                    <div className="text-[11px] text-muted">{(r.details as { details?: string }).details}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="text-left px-4 py-3 font-medium text-muted">Run at</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Source</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Test</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Result</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Details</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={5} className="px-4 py-3"><Skeleton className="h-8 w-full" /></td></tr>
            ) : !data?.recent.length ? (
              <tr><td colSpan={5} className="p-0"><EmptyState icon={Server} title="No isolation tests recorded yet" variant="compact" /></td></tr>
            ) : (
              data.recent.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{formatDate(r.run_at)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide ${
                      r.source === 'scheduled'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-surface-hover text-text-secondary'
                    }`}>
                      {r.source === 'scheduled' ? 'automated' : 'manual'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs font-medium">{r.test_name}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      r.test_result === 'pass'
                        ? 'bg-success-light text-success'
                        : 'bg-danger-light text-danger'
                    }`}>
                      {r.test_result}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted max-w-md truncate">
                    {r.details && typeof r.details === 'object' && 'details' in r.details
                      ? (r.details as { details?: string }).details
                      : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface FederalDncStateResponse {
  state: {
    lastSyncStartedAt: string | null;
    lastSyncCompletedAt: string | null;
    lastRegistryVersion: string | null;
    lastRecordCount: number | null;
    lastStatus: string | null;
    lastError: string | null;
    updatedAt: string | null;
  };
  running: boolean;
}

function federalStatusTone(status: string | null): {
  label: string;
  classes: string;
} {
  if (!status) {
    return {
      label: 'Never synced',
      classes: 'bg-surface-hover text-text-secondary',
    };
  }
  if (status === 'completed') {
    return {
      label: 'Completed',
      classes: 'bg-success-light text-success',
    };
  }
  if (status === 'failed') {
    return {
      label: 'Failed',
      classes: 'bg-danger-light text-danger',
    };
  }
  if (status === 'skipped') {
    return {
      label: 'Skipped',
      classes: 'bg-warning-light text-warning',
    };
  }
  return {
    label: status,
    classes: 'bg-surface-hover text-text-secondary',
  };
}

function FederalDncTab() {
  const queryClient = useQueryClient();
  const [actionMessage, setActionMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['platform-compliance-federal-dnc'],
    queryFn: () => api.get<FederalDncStateResponse>('/platform/compliance/federal-dnc/state'),
    // Poll while a sync is in flight so the operator sees the result land
    // without manually refreshing. The federal load can take several
    // minutes; 5s gives a snappy UI without hammering the platform DB.
    refetchInterval: (query) => (query.state.data?.running ? 5_000 : 60_000),
  });

  const syncMutation = useMutation({
    mutationFn: () =>
      api.post<{ started: boolean; running: boolean; state: FederalDncStateResponse['state'] }>(
        '/platform/compliance/federal-dnc/sync',
      ),
    onMutate: () => {
      setActionMessage(null);
    },
    onSuccess: () => {
      setActionMessage({
        kind: 'success',
        text: 'Sync started. The federal snapshot is large; this view will update when the load finishes.',
      });
      queryClient.invalidateQueries({ queryKey: ['platform-compliance-federal-dnc'] });
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error ? err.message : 'Failed to start federal DNC sync.';
      setActionMessage({ kind: 'error', text: message });
    },
  });

  const state = data?.state;
  const running = data?.running ?? false;
  const status = state?.lastStatus ?? null;
  const tone = federalStatusTone(status);

  return (
    <div className="space-y-4">
      <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 max-w-2xl">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <PhoneOff className="h-4 w-4 text-primary" />
              Federal Do-Not-Call registry sync
            </h3>
            <p className="text-sm text-muted">
              The platform pulls the FTC National DNC Registry once a week. Use this only when a
              support case can't wait for the next scheduled run — e.g. a customer reports we
              dialed a number that's already on the public federal list. The federal snapshot
              is several gigabytes and the load typically takes a few minutes.
            </p>
          </div>
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || running}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`h-4 w-4 ${running || syncMutation.isPending ? 'animate-spin' : ''}`} />
            {running ? 'Sync in progress…' : 'Sync federal DNC now'}
          </button>
        </div>

        {actionMessage && (
          <div
            role="status"
            className={`text-sm rounded-lg px-3 py-2 border ${
              actionMessage.kind === 'success'
                ? 'bg-success-light border-success text-success'
                : 'bg-danger-light border-danger text-danger'
            }`}
          >
            {actionMessage.text}
          </div>
        )}

        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : error ? (
          <EmptyState
            icon={AlertTriangle}
            title="Could not load federal DNC sync state"
            variant="compact"
          />
        ) : state ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-border bg-surface-secondary/40 p-3 space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted">Status</div>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${tone.classes}`}
              >
                {tone.label}
              </span>
              {running && (
                <div className="text-[11px] text-muted">A sync cycle is currently running.</div>
              )}
            </div>
            <div className="rounded-lg border border-border bg-surface-secondary/40 p-3 space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted">Last sync started</div>
              <div className="text-sm font-medium">{formatDate(state.lastSyncStartedAt)}</div>
            </div>
            <div className="rounded-lg border border-border bg-surface-secondary/40 p-3 space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted">Last sync completed</div>
              <div className="text-sm font-medium">{formatDate(state.lastSyncCompletedAt)}</div>
            </div>
            <div className="rounded-lg border border-border bg-surface-secondary/40 p-3 space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted">Registry version</div>
              <div className="text-sm font-medium font-mono break-all">
                {state.lastRegistryVersion ?? '—'}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-surface-secondary/40 p-3 space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted">Numbers loaded</div>
              <div className="text-sm font-medium">
                {state.lastRecordCount === null
                  ? '—'
                  : state.lastRecordCount.toLocaleString()}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-surface-secondary/40 p-3 space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted">State updated</div>
              <div className="text-sm font-medium">{formatDate(state.updatedAt)}</div>
            </div>
          </div>
        ) : null}

        {state?.lastError && (
          <div className="rounded-lg border border-danger bg-danger-light p-3">
            <div className="text-[11px] uppercase tracking-wide text-danger font-semibold">
              Last error
            </div>
            <div className="text-xs text-danger mt-1 font-mono break-words whitespace-pre-wrap">
              {state.lastError}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PlatformAdminsTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['platform-compliance-admins'],
    queryFn: () => api.get<{ admins: PlatformAdmin[] }>('/platform/compliance/platform-admins'),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Users with the platform admin flag bypass tenant scoping and can access every tenant's data. Treat the list below as a privileged-access roster.
      </p>
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="text-left px-4 py-3 font-medium text-muted">User</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Email</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Tenant memberships</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Last login</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Account created</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={5} className="px-4 py-3"><Skeleton className="h-8 w-full" /></td></tr>
            ) : !data?.admins.length ? (
              <tr><td colSpan={5} className="p-0"><EmptyState icon={Users} title="No platform admins on file" variant="compact" /></td></tr>
            ) : (
              data.admins.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium">
                    {[a.first_name, a.last_name].filter(Boolean).join(' ') || a.email}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{a.email}</td>
                  <td className="px-4 py-3 text-xs text-muted">{a.tenant_role_count}</td>
                  <td className="px-4 py-3 text-xs text-muted">{formatDate(a.last_login_at)}</td>
                  <td className="px-4 py-3 text-xs text-muted">{formatDateOnly(a.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const VALID_COMPLIANCE_TABS: readonly Tab[] = [
  'overview',
  'audit',
  'encryption',
  'federal-dnc',
  'subprocessors',
  'deletions',
  'isolation',
  'admins',
];

function isComplianceTab(value: string | null): value is Tab {
  return value !== null && (VALID_COMPLIANCE_TABS as readonly string[]).includes(value);
}

export default function PlatformCompliance() {
  // Allow other admin pages (notably the Plan Recommendation Emails
  // table in PlatformAdmin) to deep-link into a specific compliance
  // tab. We only seed once on mount; further user clicks update local
  // state so navigating tabs in-page does not rewrite the URL.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const requested = searchParams.get('tab');
    return isComplianceTab(requested) ? requested : 'overview';
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Compliance & Security"
        description="Platform-wide security posture across every tenant: audit trail, encryption, sub-processors, deletions, and RLS isolation tests."
        icon={<Shield className="h-5 w-5" />}
      />

      <div className="border-b border-border">
        <nav className="-mb-px flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                tab === t.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted hover:text-foreground hover:border-border'
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'overview' && <OverviewTab />}
      {tab === 'audit' && <PlatformAuditTab />}
      {tab === 'encryption' && <EncryptionTab />}
      {tab === 'federal-dnc' && <FederalDncTab />}
      {tab === 'subprocessors' && <SubprocessorsTab />}
      {tab === 'deletions' && <DeletionRequestsTab />}
      {tab === 'isolation' && <IsolationTab />}
      {tab === 'admins' && <PlatformAdminsTab />}
    </div>
  );
}
