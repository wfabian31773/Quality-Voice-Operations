import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  Shield, Download, Lock, FileText, Building2, Users, Trash2,
  CheckCircle2, AlertTriangle, RefreshCw, ChevronLeft, ChevronRight,
  Plus, Server, Activity, KeyRound, Globe,
} from 'lucide-react';
import { EmptyState, Skeleton } from '../../components/state';

type Tab =
  | 'overview'
  | 'audit'
  | 'encryption'
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
}

interface IsolationData {
  recent: IsolationTest[];
  summary: { passed: number; failed: number; last_run_at: string | null };
  lastRun: IsolationTest[];
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
  if (sev === 'critical') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  if (sev === 'warning') return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300';
  return 'bg-surface-hover text-text-secondary';
}

function StatCard({
  icon: Icon, label, value, hint, tone = 'default',
}: {
  icon: typeof Shield;
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'success' | 'warn' | 'danger';
}) {
  const toneClasses = {
    default: 'bg-surface',
    success: 'bg-green-50 dark:bg-green-900/10',
    warn: 'bg-yellow-50 dark:bg-yellow-900/10',
    danger: 'bg-red-50 dark:bg-red-900/10',
  }[tone];

  return (
    <div className={`rounded-xl border border-border p-4 ${toneClasses}`}>
      <div className="flex items-center gap-2 text-muted text-xs font-medium uppercase tracking-wide">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
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
          hint={`${data.tenants.total_tenants} total · ${data.tenants.suspended_tenants} suspended`}
        />
        <StatCard
          icon={Lock}
          label="Tenants with encryption"
          value={data.encryption.encrypted_tenants}
          hint={`${data.encryption.active_keys} active keys · ${data.encryption.rotated_keys} rotations`}
          tone={data.encryption.encrypted_tenants > 0 ? 'success' : 'warn'}
        />
        <StatCard
          icon={Globe}
          label="Active sub-processors"
          value={data.subprocessors.active}
          hint={`${data.subprocessors.total} on the published list`}
        />
        <StatCard
          icon={Users}
          label="Platform admins"
          value={data.platformAdmins.total}
          hint="Users with cross-tenant access"
        />
        <StatCard
          icon={Activity}
          label="Audit events (24h)"
          value={data.auditEvents.last_24h.toLocaleString()}
          hint={`${data.auditEvents.last_7d.toLocaleString()} in the last 7 days`}
        />
        <StatCard
          icon={AlertTriangle}
          label="Critical events (7d)"
          value={data.auditEvents.critical_7d}
          hint={`${data.auditEvents.warning_7d} warnings`}
          tone={data.auditEvents.critical_7d > 0 ? 'danger' : 'success'}
        />
        <StatCard
          icon={Trash2}
          label="Pending deletions"
          value={data.deletionRequests.pending}
          hint={`${data.deletionRequests.completed} completed · ${data.deletionRequests.cancelled} cancelled`}
          tone={data.deletionRequests.pending > 0 ? 'warn' : 'default'}
        />
        <StatCard
          icon={Server}
          label="Isolation pass rate (30d)"
          value={isolationPassRate === null ? '—' : `${isolationPassRate}%`}
          hint={data.isolationTests.last_run_at
            ? `Last run ${formatDate(data.isolationTests.last_run_at)}`
            : 'Run the suite from the Tenant Isolation tab'}
          tone={data.isolationTests.failed > 0 ? 'danger' : isolationPassRate === 100 ? 'success' : 'default'}
        />
      </div>

      <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          Platform compliance posture
        </h3>
        <ul className="text-sm text-muted space-y-2">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
            Audit log is append-only at the database level (UPDATE/DELETE blocked by trigger).
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
            Every tenant is isolated by Row-Level Security policies that this view re-tests on demand.
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
            Tenant secrets and PII fields are encrypted with per-tenant data encryption keys (AES-256-GCM).
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
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
  const [page, setPage] = useState(1);
  const [tenantId, setTenantId] = useState('');
  const [action, setAction] = useState('');
  const [severity, setSeverity] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
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
          className="ml-auto flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90"
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
                data.events.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                    <td className="px-4 py-3 whitespace-nowrap text-muted text-xs">{formatDate(e.occurred_at)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-xs">{e.tenant_name ?? '—'}</div>
                      <div className="text-[10px] text-muted font-mono">{e.tenant_slug ?? e.tenant_id.slice(0, 8)}</div>
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
                ))
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
  const { data, isLoading } = useQuery({
    queryKey: ['platform-compliance-encryption'],
    queryFn: () => api.get<{ tenants: EncryptionRow[] }>('/platform/compliance/encryption'),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Per-tenant data encryption keys (DEKs) wrapped by the platform key. Keys are AES-256-GCM and rotated on demand from the tenant Compliance view.
      </p>
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-muted">Tenant</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Plan</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Active keys</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Encrypted fields</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Last rotation</th>
                <th className="text-left px-4 py-3 font-medium text-muted">First key</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} className="px-4 py-3"><Skeleton className="h-8 w-full" /></td></tr>
              ) : !data?.tenants.length ? (
                <tr><td colSpan={7} className="p-0"><EmptyState icon={Lock} title="No tenants" variant="compact" /></td></tr>
              ) : (
                data.tenants.map((t) => (
                  <tr key={t.tenant_id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{t.tenant_name}</div>
                      <div className="text-[11px] text-muted font-mono">{t.tenant_slug}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted capitalize">{t.plan}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
                        t.tenant_status === 'active'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                          : 'bg-surface-hover text-text-secondary'
                      }`}>
                        {t.tenant_status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {t.active_keys > 0 ? (
                        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400 text-xs font-medium">
                          <KeyRound className="h-3.5 w-3.5" /> {t.active_keys}
                        </span>
                      ) : (
                        <span className="text-xs text-muted">Not initialized</span>
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
                    <td className="px-4 py-3 text-xs text-muted">{formatDateOnly(t.last_key_created_at)}</td>
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

function SubprocessorsTab() {
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
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90"
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
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
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
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
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
                            if (confirm(`Delete ${s.name}? This cannot be undone.`)) deleteMutation.mutate(s.id);
                          }}
                          disabled={deleteMutation.isPending}
                          className="text-xs text-red-500 font-medium hover:text-red-700"
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
                      <div className="font-medium">{r.tenant_name}</div>
                      <div className="text-[11px] text-muted font-mono">{r.tenant_slug}</div>
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
                          ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'
                          : r.status === 'completed'
                            ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
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

function IsolationTab() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['platform-isolation-tests'],
    queryFn: () => api.get<IsolationData>('/platform/compliance/isolation-tests'),
  });

  const runMutation = useMutation({
    mutationFn: () => api.post<{ passed: number; failed: number }>('/platform/compliance/isolation-tests/run'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['platform-isolation-tests'] }),
  });

  const summary = data?.summary;
  const total = (summary?.passed ?? 0) + (summary?.failed ?? 0);
  const passRate = total > 0 ? Math.round(((summary?.passed ?? 0) / total) * 100) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm text-muted">
            Verifies that Row-Level Security is enabled on tenant-scoped tables and that one tenant cannot read another tenant's data. Re-run the suite anytime.
          </p>
          {summary?.last_run_at && (
            <p className="text-xs text-muted mt-1">Last run {formatDate(summary.last_run_at)}</p>
          )}
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${runMutation.isPending ? 'animate-spin' : ''}`} />
          {runMutation.isPending ? 'Running…' : 'Run isolation tests'}
        </button>
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
            tone={summary.failed > 0 ? 'danger' : 'default'}
          />
          <StatCard
            icon={Activity}
            label="Pass rate"
            value={passRate === null ? '—' : `${passRate}%`}
            tone={passRate === 100 ? 'success' : summary.failed > 0 ? 'danger' : 'default'}
          />
        </div>
      )}

      {data?.lastRun && data.lastRun.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-4 space-y-2">
          <h3 className="text-sm font-semibold">Latest run details</h3>
          <ul className="space-y-1.5 text-sm">
            {data.lastRun.map((r) => (
              <li key={r.id} className="flex items-start gap-2">
                {r.test_result === 'pass' ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
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
              <th className="text-left px-4 py-3 font-medium text-muted">Test</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Result</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Details</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={4} className="px-4 py-3"><Skeleton className="h-8 w-full" /></td></tr>
            ) : !data?.recent.length ? (
              <tr><td colSpan={4} className="p-0"><EmptyState icon={Server} title="No isolation tests recorded yet" variant="compact" /></td></tr>
            ) : (
              data.recent.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{formatDate(r.run_at)}</td>
                  <td className="px-4 py-3 text-xs font-medium">{r.test_name}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      r.test_result === 'pass'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
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

export default function PlatformCompliance() {
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Compliance &amp; Security</h1>
        <p className="text-sm text-muted mt-1">
          Platform-wide security posture across every tenant: audit trail, encryption, sub-processors, deletions, and RLS isolation tests.
        </p>
      </div>

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
      {tab === 'subprocessors' && <SubprocessorsTab />}
      {tab === 'deletions' && <DeletionRequestsTab />}
      {tab === 'isolation' && <IsolationTab />}
      {tab === 'admins' && <PlatformAdminsTab />}
    </div>
  );
}
