import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Shield, Download, Key, Users, Lock, CheckCircle2, AlertCircle,
  ChevronLeft, ChevronRight, FileText, Trash2, RefreshCw, RotateCcw,
} from 'lucide-react';

type Tab = 'audit' | 'api-keys' | 'roles' | 'encryption' | 'soc2' | 'gdpr';

interface AuditEvent {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  changes: Record<string, unknown>;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  severity: string;
  ip_address: string | null;
  occurred_at: string;
  actor_user_id: string | null;
  actor_role: string | null;
  actor_email: string | null;
}

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface RoleAssignment {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  role_assigned_at: string;
}

interface EncryptionStatus {
  encryptionEnabled: boolean;
  activeKeys: number;
  encryptedTables: string[];
  lastKeyRotation: string | null;
}

interface ChecklistItem {
  id: string;
  category: string;
  control: string;
  description: string;
  status: 'implemented' | 'available' | 'not_applicable' | 'action_required';
  details: string;
}

interface GdprRequest {
  id: string;
  request_type: string;
  subject_email: string;
  status: string;
  completed_at: string | null;
  created_at: string;
  requested_by_email: string;
}

const TABS: { id: Tab; label: string; icon: typeof Shield }[] = [
  { id: 'audit', label: 'Audit Log', icon: FileText },
  { id: 'api-keys', label: 'API Keys', icon: Key },
  { id: 'roles', label: 'Role Assignments', icon: Users },
  { id: 'encryption', label: 'Encryption', icon: Lock },
  { id: 'soc2', label: 'SOC2 Checklist', icon: CheckCircle2 },
  { id: 'gdpr', label: 'GDPR / Privacy', icon: Shield },
];

const ACTION_OPTIONS = [
  { value: '', label: 'All Actions' },
  { value: 'user.login', label: 'User Login' },
  { value: 'user.role_changed', label: 'Role Change' },
  { value: 'user.invited', label: 'User Invited' },
  { value: 'agent.updated', label: 'Agent Updated' },
  { value: 'api_key.created', label: 'API Key Created' },
  { value: 'api_key.revoked', label: 'API Key Revoked' },
  { value: 'encryption.initialized', label: 'Encryption Initialized' },
  { value: 'encryption.key_rotated', label: 'Key Rotated' },
  { value: 'gdpr.data_exported', label: 'GDPR Export' },
  { value: 'gdpr.data_erased', label: 'GDPR Erasure' },
  { value: 'audit_log.exported', label: 'Audit Log Export' },
];

function formatAction(action: string): string {
  const found = ACTION_OPTIONS.find((o) => o.value === action);
  return found ? found.label : action.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function AuditLogTab() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const limit = 25;

  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  if (action) params.set('action', action);
  if (userFilter) params.set('userId', userFilter);
  if (since) params.set('since', new Date(since).toISOString());
  if (until) params.set('until', new Date(until + 'T23:59:59').toISOString());

  const { data, isLoading } = useQuery({
    queryKey: ['compliance-audit-log', page, action, userFilter, since, until],
    queryFn: () => api.get<{ events: AuditEvent[]; total: number }>(`/audit-log?${params}`),
    refetchInterval: 30_000,
  });

  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  const handleExport = () => {
    const exportParams = new URLSearchParams();
    if (action) exportParams.set('action', action);
    if (userFilter) exportParams.set('userId', userFilter);
    if (since) exportParams.set('since', new Date(since).toISOString());
    if (until) exportParams.set('until', new Date(until + 'T23:59:59').toISOString());
    window.open(`/api/compliance/audit-log/export?${exportParams}`, '_blank');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={action}
          onChange={(e) => { setAction(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm"
        >
          {ACTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <input
          type="text"
          value={userFilter}
          onChange={(e) => { setUserFilter(e.target.value); setPage(1); }}
          placeholder="Filter by user ID..."
          className="px-3 py-2 rounded-lg border border-border bg-surface text-sm w-48"
        />
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
        {(action || userFilter || since || until) && (
          <button
            onClick={() => { setAction(''); setUserFilter(''); setSince(''); setUntil(''); setPage(1); }}
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
                <th className="text-left px-4 py-3 font-medium text-muted">Actor</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Action</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Resource</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Severity</th>
                <th className="text-left px-4 py-3 font-medium text-muted">Details</th>
                <th className="text-left px-4 py-3 font-medium text-muted">IP</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} className="text-center py-12 text-muted">Loading...</td></tr>
              ) : !data?.events.length ? (
                <tr><td colSpan={7} className="text-center py-12 text-muted">No audit events found</td></tr>
              ) : (
                data.events.map((event) => (
                  <tr key={event.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                    <td className="px-4 py-3 whitespace-nowrap text-muted text-xs">
                      {new Date(event.occurred_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-xs">{event.actor_email ?? 'System'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">
                        {formatAction(event.action)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted text-xs">
                      {event.resource_type}
                      {event.resource_id && <span className="ml-1 font-mono">{event.resource_id.slice(0, 8)}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        event.severity === 'critical' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                        event.severity === 'warning' ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' :
                        'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                      }`}>
                        {event.severity ?? 'info'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted text-xs max-w-48 truncate">
                      {Object.keys(event.changes).length > 0 ? JSON.stringify(event.changes) : '-'}
                    </td>
                    <td className="px-4 py-3 text-muted text-xs font-mono">
                      {event.ip_address ?? '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {data && data.total > limit && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-sm text-muted">{data.total} events total</span>
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

function ApiKeysTab() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyScope, setNewKeyScope] = useState('read-only');
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['compliance-api-keys'],
    queryFn: () => api.get<{ keys: ApiKey[] }>('/settings/api-keys'),
  });

  const createMutation = useMutation({
    mutationFn: (params: { name: string; scopes: string[] }) =>
      api.post<{ key: ApiKey; plaintextKey: string }>('/settings/api-keys', params),
    onSuccess: (result) => {
      setCreatedKey(result.plaintextKey);
      setNewKeyName('');
      setShowCreate(false);
      queryClient.invalidateQueries({ queryKey: ['compliance-api-keys'] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/api-keys/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compliance-api-keys'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">API keys are hashed with SHA-256 and never stored in plaintext.</p>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90"
        >
          Create API Key
        </button>
      </div>

      {createdKey && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
          <p className="text-sm font-medium text-green-800 dark:text-green-200 mb-2">API Key Created - Copy it now! It won't be shown again.</p>
          <code className="text-xs bg-green-100 dark:bg-green-900/40 px-3 py-2 rounded block break-all">{createdKey}</code>
          <button onClick={() => setCreatedKey(null)} className="mt-2 text-xs text-green-600 hover:text-green-800">Dismiss</button>
        </div>
      )}

      {showCreate && (
        <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
          <input
            type="text"
            placeholder="Key name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm"
          />
          <select
            value={newKeyScope}
            onChange={(e) => setNewKeyScope(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm"
          >
            <option value="read-only">Read Only</option>
            <option value="write">Read & Write</option>
            <option value="admin">Admin (Full Access)</option>
          </select>
          <div className="flex gap-2">
            <button
              onClick={() => createMutation.mutate({ name: newKeyName, scopes: [newKeyScope] })}
              disabled={!newKeyName.trim() || createMutation.isPending}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating...' : 'Create'}
            </button>
            <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-muted hover:text-foreground">Cancel</button>
          </div>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="text-left px-4 py-3 font-medium text-muted">Name</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Prefix</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Scopes</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Last Used</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Created</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="text-center py-8 text-muted">Loading...</td></tr>
            ) : !data?.keys.length ? (
              <tr><td colSpan={6} className="text-center py-8 text-muted">No API keys</td></tr>
            ) : (
              data.keys.map((key) => (
                <tr key={key.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium">{key.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{key.keyPrefix}...</td>
                  <td className="px-4 py-3">
                    {key.scopes.map((s) => (
                      <span key={s} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 mr-1">
                        {s}
                      </span>
                    ))}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{new Date(key.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => { if (confirm('Revoke this API key?')) revokeMutation.mutate(key.id); }}
                      className="text-red-500 hover:text-red-700 text-xs font-medium"
                    >
                      Revoke
                    </button>
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

function RolesTab() {
  const queryClient = useQueryClient();
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['compliance-roles'],
    queryFn: () => api.get<{ roles: RoleAssignment[] }>('/compliance/roles'),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api.patch(`/compliance/roles/${userId}`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['compliance-roles'] });
      setEditingUser(null);
    },
  });

  const revokeRoleMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/compliance/roles/${userId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compliance-roles'] }),
  });

  const ROLE_OPTIONS = [
    { value: 'tenant_owner', label: 'Owner' },
    { value: 'operations_manager', label: 'Manager' },
    { value: 'agent_developer', label: 'Operator' },
    { value: 'support_reviewer', label: 'Viewer' },
  ];

  const roleLabel = (role: string) => {
    return ROLE_OPTIONS.find(r => r.value === role)?.label ?? role;
  };

  const roleColor = (role: string) => {
    if (role === 'tenant_owner') return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400';
    if (['operations_manager', 'billing_admin'].includes(role))
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
    if (role === 'agent_developer')
      return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Manage role assignments for this tenant. Owners can assign and revoke roles.</p>
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="text-left px-4 py-3 font-medium text-muted">User</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Email</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Role</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Assigned</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={5} className="text-center py-8 text-muted">Loading...</td></tr>
            ) : !data?.roles.length ? (
              <tr><td colSpan={5} className="text-center py-8 text-muted">No role assignments</td></tr>
            ) : (
              data.roles.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium">
                    {[r.first_name, r.last_name].filter(Boolean).join(' ') || r.email}
                  </td>
                  <td className="px-4 py-3 text-muted text-xs">{r.email}</td>
                  <td className="px-4 py-3">
                    {editingUser === r.id ? (
                      <div className="flex items-center gap-2">
                        <select
                          value={selectedRole}
                          onChange={(e) => setSelectedRole(e.target.value)}
                          className="px-2 py-1 rounded border border-border bg-surface text-xs"
                        >
                          {ROLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => updateRoleMutation.mutate({ userId: r.id, role: selectedRole })}
                          disabled={updateRoleMutation.isPending}
                          className="text-xs text-primary font-medium hover:text-primary/80"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingUser(null)}
                          className="text-xs text-muted hover:text-foreground"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${roleColor(r.role)}`}>
                        {roleLabel(r.role)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {new Date(r.role_assigned_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {editingUser !== r.id && (
                        <button
                          onClick={() => { setEditingUser(r.id); setSelectedRole(r.role); }}
                          className="text-xs text-primary font-medium hover:text-primary/80"
                        >
                          Change Role
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (confirm(`Remove ${r.email} from this tenant?`))
                            revokeRoleMutation.mutate(r.id);
                        }}
                        disabled={revokeRoleMutation.isPending}
                        className="text-xs text-red-500 font-medium hover:text-red-700"
                      >
                        Revoke
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
  );
}

function EncryptionTab() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['compliance-encryption'],
    queryFn: () => api.get<EncryptionStatus>('/compliance/encryption-status'),
  });

  const initMutation = useMutation({
    mutationFn: () => api.post('/compliance/encryption/initialize'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compliance-encryption'] }),
  });

  const rotateMutation = useMutation({
    mutationFn: () => api.post('/compliance/encryption/rotate'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['compliance-encryption'] }),
  });

  if (isLoading) return <div className="text-center py-12 text-muted">Loading encryption status...</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface border border-border rounded-xl p-6">
          <div className="flex items-center gap-3 mb-2">
            {data?.encryptionEnabled ? (
              <CheckCircle2 className="h-5 w-5 text-green-500" />
            ) : (
              <AlertCircle className="h-5 w-5 text-yellow-500" />
            )}
            <h3 className="font-semibold">Encryption Status</h3>
          </div>
          <p className="text-sm text-muted">
            {data?.encryptionEnabled ? 'Encryption at rest is active' : 'Encryption not yet initialized'}
          </p>
        </div>

        <div className="bg-surface border border-border rounded-xl p-6">
          <div className="flex items-center gap-3 mb-2">
            <Key className="h-5 w-5 text-primary" />
            <h3 className="font-semibold">Active Keys</h3>
          </div>
          <p className="text-2xl font-bold">{data?.activeKeys ?? 0}</p>
        </div>

        <div className="bg-surface border border-border rounded-xl p-6">
          <div className="flex items-center gap-3 mb-2">
            <RotateCcw className="h-5 w-5 text-primary" />
            <h3 className="font-semibold">Last Rotation</h3>
          </div>
          <p className="text-sm text-muted">
            {data?.lastKeyRotation ? new Date(data.lastKeyRotation).toLocaleDateString() : 'Never'}
          </p>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <h3 className="font-semibold mb-2">Algorithm</h3>
        <p className="text-sm text-muted mb-4">AES-256-GCM with envelope encryption. Data Encryption Keys (DEK) are wrapped by a Key Encryption Key (KEK) derived from the master secret.</p>

        <h3 className="font-semibold mb-2">Protected Data</h3>
        <ul className="text-sm text-muted list-disc list-inside mb-4">
          <li>Integration credentials (connector configs)</li>
          <li>API key hashes</li>
          <li>User PII fields</li>
          <li>Call transcripts and recordings</li>
        </ul>

        <div className="flex gap-3">
          {!data?.encryptionEnabled && (
            <button
              onClick={() => initMutation.mutate()}
              disabled={initMutation.isPending}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {initMutation.isPending ? 'Initializing...' : 'Initialize Encryption'}
            </button>
          )}
          {data?.encryptionEnabled && (
            <button
              onClick={() => { if (confirm('Rotate encryption key? This is a critical operation.')) rotateMutation.mutate(); }}
              disabled={rotateMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm font-medium hover:bg-surface-secondary disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              {rotateMutation.isPending ? 'Rotating...' : 'Rotate Key'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Soc2Tab() {
  const { data, isLoading } = useQuery({
    queryKey: ['compliance-soc2'],
    queryFn: () => api.get<{ checklist: ChecklistItem[] }>('/compliance/soc2-checklist'),
  });

  if (isLoading) return <div className="text-center py-12 text-muted">Loading checklist...</div>;

  const categories = [...new Set(data?.checklist.map((c) => c.category) ?? [])];
  const implemented = data?.checklist.filter((c) => c.status === 'implemented').length ?? 0;
  const total = data?.checklist.length ?? 0;
  const pct = total > 0 ? Math.round((implemented / total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold">SOC2 Readiness</h3>
            <p className="text-sm text-muted">{implemented} of {total} controls implemented</p>
          </div>
          <div className="text-3xl font-bold text-primary">{pct}%</div>
        </div>
        <div className="w-full bg-surface-secondary rounded-full h-3">
          <div className="bg-primary h-3 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {categories.map((category) => (
        <div key={category} className="space-y-3">
          <h3 className="text-sm font-semibold text-muted uppercase tracking-wider">{category}</h3>
          {data?.checklist
            .filter((c) => c.category === category)
            .map((item) => (
              <div key={item.id} className="bg-surface border border-border rounded-lg p-4 flex items-start gap-4">
                {item.status === 'implemented' ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-yellow-500 shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="font-medium">{item.control}</h4>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      item.status === 'implemented'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : item.status === 'action_required'
                        ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                        : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                    }`}>
                      {item.status === 'implemented' ? 'Implemented' : item.status === 'action_required' ? 'Action Required' : 'Available'}
                    </span>
                  </div>
                  <p className="text-sm text-muted mt-1">{item.description}</p>
                  <p className="text-xs text-muted mt-1">{item.details}</p>
                </div>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function GdprTab() {
  const queryClient = useQueryClient();
  const [exportEmail, setExportEmail] = useState('');
  const [eraseEmail, setEraseEmail] = useState('');

  const { data: requestsData, isLoading } = useQuery({
    queryKey: ['compliance-gdpr-requests'],
    queryFn: () => api.get<{ requests: GdprRequest[] }>('/compliance/gdpr/requests'),
  });

  const exportMutation = useMutation({
    mutationFn: (email: string) => api.post<{ requestId: string; data: Record<string, unknown> }>('/compliance/gdpr/export', { email }),
    onSuccess: (result) => {
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gdpr-export-${exportEmail}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExportEmail('');
      queryClient.invalidateQueries({ queryKey: ['compliance-gdpr-requests'] });
    },
  });

  const eraseMutation = useMutation({
    mutationFn: (email: string) => api.post('/compliance/gdpr/erase', { email }),
    onSuccess: () => {
      setEraseEmail('');
      queryClient.invalidateQueries({ queryKey: ['compliance-gdpr-requests'] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-3">
            <Download className="h-5 w-5 text-primary" />
            <h3 className="font-semibold">Data Export (Right of Access)</h3>
          </div>
          <p className="text-sm text-muted mb-4">Export all data associated with a user email as JSON.</p>
          <div className="flex gap-2">
            <input
              type="email"
              placeholder="user@example.com"
              value={exportEmail}
              onChange={(e) => setExportEmail(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-sm"
            />
            <button
              onClick={() => exportMutation.mutate(exportEmail)}
              disabled={!exportEmail.trim() || exportMutation.isPending}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {exportMutation.isPending ? 'Exporting...' : 'Export'}
            </button>
          </div>
          {exportMutation.isError && (
            <p className="text-sm text-red-500 mt-2">Failed to export data</p>
          )}
        </div>

        <div className="bg-surface border border-border rounded-xl p-6">
          <div className="flex items-center gap-2 mb-3">
            <Trash2 className="h-5 w-5 text-red-500" />
            <h3 className="font-semibold">Right to Erasure</h3>
          </div>
          <p className="text-sm text-muted mb-4">Permanently delete or anonymize all PII for a user. This action cannot be undone.</p>
          <div className="flex gap-2">
            <input
              type="email"
              placeholder="user@example.com"
              value={eraseEmail}
              onChange={(e) => setEraseEmail(e.target.value)}
              className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-sm"
            />
            <button
              onClick={() => {
                if (confirm(`PERMANENTLY erase all PII for ${eraseEmail}? This cannot be undone.`)) {
                  eraseMutation.mutate(eraseEmail);
                }
              }}
              disabled={!eraseEmail.trim() || eraseMutation.isPending}
              className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
            >
              {eraseMutation.isPending ? 'Erasing...' : 'Erase'}
            </button>
          </div>
          {eraseMutation.isError && (
            <p className="text-sm text-red-500 mt-2">Failed to erase data</p>
          )}
          {eraseMutation.isSuccess && (
            <p className="text-sm text-green-600 mt-2">User data has been erased</p>
          )}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-semibold">Request History</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              <th className="text-left px-4 py-3 font-medium text-muted">Type</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Subject</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Status</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Requested By</th>
              <th className="text-left px-4 py-3 font-medium text-muted">Date</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={5} className="text-center py-8 text-muted">Loading...</td></tr>
            ) : !requestsData?.requests.length ? (
              <tr><td colSpan={5} className="text-center py-8 text-muted">No GDPR requests</td></tr>
            ) : (
              requestsData.requests.map((req) => (
                <tr key={req.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      req.request_type === 'export'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                    }`}>
                      {req.request_type === 'export' ? 'Export' : 'Erasure'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">{req.subject_email}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      req.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                      req.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                      'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                    }`}>
                      {req.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">{req.requested_by_email}</td>
                  <td className="px-4 py-3 text-xs text-muted">{new Date(req.created_at).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Compliance() {
  const [activeTab, setActiveTab] = useState<Tab>('soc2');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Security & Compliance</h1>
          <p className="text-sm text-muted">Enterprise security controls, audit logging, and compliance management</p>
        </div>
      </div>

      <div className="flex gap-1 bg-surface border border-border rounded-xl p-1 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.id
                ? 'bg-primary text-white'
                : 'text-muted hover:text-foreground hover:bg-surface-secondary'
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'audit' && <AuditLogTab />}
      {activeTab === 'api-keys' && <ApiKeysTab />}
      {activeTab === 'roles' && <RolesTab />}
      {activeTab === 'encryption' && <EncryptionTab />}
      {activeTab === 'soc2' && <Soc2Tab />}
      {activeTab === 'gdpr' && <GdprTab />}
    </div>
  );
}
