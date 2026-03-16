import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Plus, ArrowLeft, Play, Pause, XCircle, Upload, Trash2, X,
  Megaphone, Phone, Users, Clock, BarChart3, ShieldOff,
  ChevronLeft, ChevronRight, FileText, AlertCircle,
} from 'lucide-react';

type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';
type ContactStatus = 'pending' | 'dialing' | 'connected' | 'completed' | 'failed' | 'skipped' | 'no_answer' | 'voicemail' | 'opted_out';

interface Campaign {
  id: string;
  tenantId: string;
  agentId: string;
  name: string;
  type: string;
  status: CampaignStatus;
  config: Record<string, unknown>;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CampaignMetrics {
  total: number;
  attempted: number;
  pending: number;
  dialing: number;
  connected: number;
  completed: number;
  failed: number;
  noAnswer: number;
  voicemail: number;
  skipped: number;
  optedOut: number;
}

interface CampaignContact {
  id: string;
  phoneNumber: string;
  name: string | null;
  status: ContactStatus;
  outcome: string | null;
  attemptCount: number;
  lastAttemptedAt: string | null;
  createdAt: string;
}

interface Agent {
  id: string;
  name: string;
  type: string;
  status: string;
}

interface DncEntry {
  id: string;
  phoneNumber: string;
  reason: string | null;
  source: string;
  createdAt: string;
}

const STATUS_COLORS: Record<CampaignStatus, string> = {
  draft: 'bg-text-muted/10 text-text-muted',
  scheduled: 'bg-warning/10 text-warning',
  running: 'bg-success/10 text-success',
  paused: 'bg-warning/10 text-warning',
  completed: 'bg-primary/10 text-primary',
  cancelled: 'bg-danger/10 text-danger',
};

const CONTACT_STATUS_COLORS: Record<ContactStatus, string> = {
  pending: 'bg-text-muted/10 text-text-muted',
  dialing: 'bg-primary/10 text-primary',
  connected: 'bg-success/10 text-success',
  completed: 'bg-success/10 text-success',
  failed: 'bg-danger/10 text-danger',
  skipped: 'bg-text-muted/10 text-text-muted',
  no_answer: 'bg-warning/10 text-warning',
  voicemail: 'bg-primary/10 text-primary',
  opted_out: 'bg-danger/10 text-danger',
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function StatusBadge({ status, colors }: { status: string; colors: Record<string, string> }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${colors[status] ?? 'bg-text-muted/10 text-text-muted'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return raw;
}

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function CreateCampaignModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { data: agentsData } = useQuery({ queryKey: ['agents'], queryFn: () => api.get<{ agents: Agent[] }>('/agents') });
  const agents = agentsData?.agents ?? [];

  const [form, setForm] = useState({
    name: '',
    agentId: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    callWindowStart: '09:00',
    callWindowEnd: '17:00',
    daysOfWeek: [1, 2, 3, 4, 5] as number[],
    maxConcurrentCalls: 5,
    maxAttempts: 3,
    retryDelayMinutes: 30,
  });
  const [error, setError] = useState('');

  useEffect(() => {
    if (agents.length > 0 && !form.agentId) setForm((f) => ({ ...f, agentId: agents[0].id }));
  }, [agents, form.agentId]);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/campaigns', {
        name: form.name,
        agentId: form.agentId,
        config: {
          timezone: form.timezone,
          callWindowStart: form.callWindowStart,
          callWindowEnd: form.callWindowEnd,
          daysOfWeek: form.daysOfWeek,
          maxConcurrentCalls: form.maxConcurrentCalls,
          maxAttempts: form.maxAttempts,
          retryDelayMinutes: form.retryDelayMinutes,
        },
      }),
    onSuccess: () => { onCreated(); onClose(); },
    onError: (err: Error) => setError(err.message),
  });

  const toggleDay = (d: number) => {
    setForm((f) => ({
      ...f,
      daysOfWeek: f.daysOfWeek.includes(d) ? f.daysOfWeek.filter((x) => x !== d) : [...f.daysOfWeek, d].sort(),
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Create Campaign</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X className="h-5 w-5" /></button>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); if (form.name && form.agentId) mutation.mutate(); }}
          className="p-6 space-y-4"
        >
          {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>}

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Campaign Name</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder="March outreach"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Agent</label>
            <select
              value={form.agentId}
              onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Window Start</label>
              <input type="time" value={form.callWindowStart} onChange={(e) => setForm((f) => ({ ...f, callWindowStart: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Window End</label>
              <input type="time" value={form.callWindowEnd} onChange={(e) => setForm((f) => ({ ...f, callWindowEnd: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Timezone</label>
            <input
              type="text"
              value={form.timezone}
              onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Days of Week</label>
            <div className="flex gap-1">
              {DAYS.map((label, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggleDay(i)}
                  className={`px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
                    form.daysOfWeek.includes(i)
                      ? 'bg-primary text-white'
                      : 'bg-surface-hover text-text-secondary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Concurrency</label>
              <input type="number" min={1} max={50} value={form.maxConcurrentCalls} onChange={(e) => setForm((f) => ({ ...f, maxConcurrentCalls: parseInt(e.target.value) || 1 }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Max Attempts</label>
              <input type="number" min={1} max={10} value={form.maxAttempts} onChange={(e) => setForm((f) => ({ ...f, maxAttempts: parseInt(e.target.value) || 1 }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Retry (min)</label>
              <input type="number" min={1} value={form.retryDelayMinutes} onChange={(e) => setForm((f) => ({ ...f, retryDelayMinutes: parseInt(e.target.value) || 1 }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">Cancel</button>
            <button type="submit" disabled={mutation.isPending} className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50">
              {mutation.isPending ? 'Creating...' : 'Create Campaign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AddContactsModal({ campaignId, onClose, onAdded }: { campaignId: string; onClose: () => void; onAdded: () => void }) {
  const [mode, setMode] = useState<'manual' | 'csv'>('manual');
  const [manualPhone, setManualPhone] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualEntries, setManualEntries] = useState<Array<{ phone: string; name: string }>>([]);
  const [csvText, setCsvText] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ inserted: number; skippedInvalid: number }>(`/campaigns/${campaignId}/contacts`, body),
    onSuccess: (data) => {
      onAdded();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const addManualEntry = () => {
    if (!manualPhone.trim()) return;
    setManualEntries((prev) => [...prev, { phone: manualPhone.trim(), name: manualName.trim() }]);
    setManualPhone('');
    setManualName('');
  };

  const handleSubmit = () => {
    setError('');
    if (mode === 'csv') {
      if (!csvText.trim()) { setError('Paste CSV data'); return; }
      mutation.mutate({ csv: csvText });
    } else {
      if (manualEntries.length === 0) { setError('Add at least one contact'); return; }
      mutation.mutate({ contacts: manualEntries.map((e) => ({ phoneNumber: e.phone, name: e.name || undefined })) });
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setCsvText(ev.target?.result as string ?? ''); setMode('csv'); };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Add Contacts</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>}

          <div className="flex gap-2">
            <button onClick={() => setMode('manual')} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${mode === 'manual' ? 'bg-primary text-white' : 'bg-surface-hover text-text-secondary'}`}>Manual Entry</button>
            <button onClick={() => setMode('csv')} className={`px-3 py-1.5 rounded-lg text-xs font-medium ${mode === 'csv' ? 'bg-primary text-white' : 'bg-surface-hover text-text-secondary'}`}>CSV Upload</button>
          </div>

          {mode === 'manual' ? (
            <>
              <div className="flex gap-2">
                <input type="text" placeholder="Phone number" value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <input type="text" placeholder="Name (optional)" value={manualName} onChange={(e) => setManualName(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                <button type="button" onClick={addManualEntry} className="px-3 py-2 bg-primary hover:bg-primary-hover text-white text-sm rounded-lg"><Plus className="h-4 w-4" /></button>
              </div>
              {manualEntries.length > 0 && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {manualEntries.map((e, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-1.5 bg-surface-hover rounded text-sm">
                      <span className="text-text-primary">{e.phone} {e.name && <span className="text-text-muted">({e.name})</span>}</span>
                      <button onClick={() => setManualEntries((prev) => prev.filter((_, j) => j !== i))} className="text-text-muted hover:text-danger"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ))}
                  <p className="text-xs text-text-muted">{manualEntries.length} contact{manualEntries.length !== 1 ? 's' : ''} ready</p>
                </div>
              )}
            </>
          ) : (
            <>
              <div>
                <label className="flex items-center gap-2 px-4 py-3 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary/50 transition-colors">
                  <Upload className="h-5 w-5 text-text-muted" />
                  <span className="text-sm text-text-secondary">Choose a CSV file</span>
                  <input type="file" accept=".csv,.txt" onChange={handleFileUpload} className="hidden" />
                </label>
              </div>
              <textarea
                rows={6}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                placeholder={'phone,name\n2125551234,Jane Smith\n3105559876,Bob Jones'}
              />
              <p className="text-xs text-text-muted">CSV must have a header row with a "phone" or "phone_number" column.</p>
            </>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">Cancel</button>
            <button onClick={handleSubmit} disabled={mutation.isPending} className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50">
              {mutation.isPending ? 'Uploading...' : 'Add Contacts'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-3 text-center">
      <p className={`text-2xl font-bold ${color ?? 'text-text-primary'}`}>{value.toLocaleString()}</p>
      <p className="text-xs text-text-muted mt-0.5 capitalize">{label}</p>
    </div>
  );
}

function CampaignDetail({ campaignId, onBack }: { campaignId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'overview' | 'contacts' | 'dnc'>('overview');
  const [showAddContacts, setShowAddContacts] = useState(false);
  const [contactPage, setContactPage] = useState(1);

  const { data: campaignData, isLoading: loadingCampaign } = useQuery({
    queryKey: ['campaign', campaignId],
    queryFn: () => api.get<{ campaign: Campaign }>(`/campaigns/${campaignId}`),
  });
  const campaign = campaignData?.campaign;

  const { data: metricsData } = useQuery({
    queryKey: ['campaign-metrics', campaignId],
    queryFn: () => api.get<{ metrics: CampaignMetrics }>(`/campaigns/${campaignId}/metrics`),
    refetchInterval: campaign?.status === 'running' ? 5000 : 30000,
  });
  const metrics = metricsData?.metrics;

  const { data: contactsData } = useQuery({
    queryKey: ['campaign-contacts', campaignId, contactPage],
    queryFn: () => api.get<{ contacts: CampaignContact[]; total: number }>(`/campaigns/${campaignId}/contacts?page=${contactPage}&limit=20`),
    enabled: tab === 'contacts',
  });

  const statusMutation = useMutation({
    mutationFn: (status: string) => api.patch(`/campaigns/${campaignId}`, { status }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['campaign', campaignId] }); queryClient.invalidateQueries({ queryKey: ['campaigns'] }); },
  });

  if (loadingCampaign) return <div className="flex items-center justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" /></div>;
  if (!campaign) return <div className="text-center py-20 text-text-muted">Campaign not found</div>;

  const config = campaign.config;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="p-1.5 rounded-lg hover:bg-surface-hover text-text-muted hover:text-text-primary">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-text-primary">{campaign.name}</h1>
            <StatusBadge status={campaign.status} colors={STATUS_COLORS} />
          </div>
          <p className="text-sm text-text-muted mt-0.5">Created {formatDate(campaign.createdAt)}</p>
        </div>
        <div className="flex items-center gap-2">
          {campaign.status === 'draft' && (
            <button onClick={() => statusMutation.mutate('running')} disabled={statusMutation.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 bg-success hover:bg-success/90 text-white text-sm font-medium rounded-lg disabled:opacity-50">
              <Play className="h-4 w-4" /> Start
            </button>
          )}
          {campaign.status === 'running' && (
            <button onClick={() => statusMutation.mutate('paused')} disabled={statusMutation.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 bg-warning hover:bg-warning/90 text-white text-sm font-medium rounded-lg disabled:opacity-50">
              <Pause className="h-4 w-4" /> Pause
            </button>
          )}
          {campaign.status === 'paused' && (
            <button onClick={() => statusMutation.mutate('running')} disabled={statusMutation.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 bg-success hover:bg-success/90 text-white text-sm font-medium rounded-lg disabled:opacity-50">
              <Play className="h-4 w-4" /> Resume
            </button>
          )}
          {['draft', 'running', 'paused'].includes(campaign.status) && (
            <button onClick={() => statusMutation.mutate('cancelled')} disabled={statusMutation.isPending} className="inline-flex items-center gap-1.5 px-3 py-2 bg-danger hover:bg-danger/90 text-white text-sm font-medium rounded-lg disabled:opacity-50">
              <XCircle className="h-4 w-4" /> Cancel
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border">
        {(['overview', 'contacts', 'dnc'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              tab === t ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            {t === 'dnc' ? 'DNC List' : t}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-6">
          {metrics && (
            <div>
              <h3 className="text-sm font-semibold text-text-primary mb-3">Campaign Metrics</h3>
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                <MetricCard label="Total" value={metrics.total} />
                <MetricCard label="Pending" value={metrics.pending} color="text-text-muted" />
                <MetricCard label="Dialing" value={metrics.dialing} color="text-primary" />
                <MetricCard label="Connected" value={metrics.connected} color="text-success" />
                <MetricCard label="Completed" value={metrics.completed} color="text-success" />
                <MetricCard label="Failed" value={metrics.failed} color="text-danger" />
                <MetricCard label="No Answer" value={metrics.noAnswer} color="text-warning" />
                <MetricCard label="Voicemail" value={metrics.voicemail} color="text-primary" />
                <MetricCard label="Skipped" value={metrics.skipped} color="text-text-muted" />
                <MetricCard label="Opted Out" value={metrics.optedOut} color="text-danger" />
                <MetricCard label="Attempted" value={metrics.attempted} />
              </div>
              {metrics.total > 0 && (
                <div className="mt-3 h-3 bg-surface-hover rounded-full overflow-hidden flex">
                  {metrics.completed > 0 && <div className="bg-success h-full" style={{ width: `${(metrics.completed / metrics.total) * 100}%` }} />}
                  {metrics.failed > 0 && <div className="bg-danger h-full" style={{ width: `${(metrics.failed / metrics.total) * 100}%` }} />}
                  {metrics.noAnswer > 0 && <div className="bg-warning h-full" style={{ width: `${(metrics.noAnswer / metrics.total) * 100}%` }} />}
                  {metrics.voicemail > 0 && <div className="bg-primary h-full" style={{ width: `${(metrics.voicemail / metrics.total) * 100}%` }} />}
                  {metrics.optedOut > 0 && <div className="bg-danger/50 h-full" style={{ width: `${(metrics.optedOut / metrics.total) * 100}%` }} />}
                </div>
              )}
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold text-text-primary mb-3">Configuration</h3>
            <div className="bg-surface border border-border rounded-lg divide-y divide-border">
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-text-muted">Type</span>
                <span className="text-sm text-text-primary capitalize">{campaign.type.replace(/_/g, ' ')}</span>
              </div>
              {config.timezone && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-text-muted">Timezone</span>
                  <span className="text-sm text-text-primary">{config.timezone as string}</span>
                </div>
              )}
              {config.callWindowStart && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-text-muted">Call Window</span>
                  <span className="text-sm text-text-primary">{config.callWindowStart as string} — {config.callWindowEnd as string}</span>
                </div>
              )}
              {config.daysOfWeek && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-text-muted">Days</span>
                  <span className="text-sm text-text-primary">{(config.daysOfWeek as number[]).map((d) => DAYS[d]).join(', ')}</span>
                </div>
              )}
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-text-muted">Concurrency</span>
                <span className="text-sm text-text-primary">{(config.maxConcurrentCalls as number) ?? (config.maxConcurrent as number) ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-text-muted">Max Attempts</span>
                <span className="text-sm text-text-primary">{(config.maxAttempts as number) ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm text-text-muted">Retry Delay</span>
                <span className="text-sm text-text-primary">{(config.retryDelayMinutes as number) ?? '—'} min</span>
              </div>
              {campaign.startedAt && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-text-muted">Started</span>
                  <span className="text-sm text-text-primary">{formatDate(campaign.startedAt)}</span>
                </div>
              )}
              {campaign.completedAt && (
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm text-text-muted">Completed</span>
                  <span className="text-sm text-text-primary">{formatDate(campaign.completedAt)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'contacts' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-text-primary">
              Contacts {contactsData && <span className="text-text-muted font-normal">({contactsData.total})</span>}
            </h3>
            {['draft', 'paused'].includes(campaign.status) && (
              <button onClick={() => setShowAddContacts(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg">
                <Upload className="h-3.5 w-3.5" /> Add Contacts
              </button>
            )}
          </div>

          {!contactsData ? (
            <div className="flex items-center justify-center py-12"><div className="animate-spin h-6 w-6 border-3 border-primary border-t-transparent rounded-full" /></div>
          ) : contactsData.contacts.length === 0 ? (
            <div className="text-center py-12 text-text-muted">
              <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No contacts yet</p>
              {['draft', 'paused'].includes(campaign.status) && (
                <button onClick={() => setShowAddContacts(true)} className="mt-3 text-sm text-primary hover:underline">Add contacts to get started</button>
              )}
            </div>
          ) : (
            <>
              <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-surface-secondary">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">Phone</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">Name</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">Status</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">Attempts</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">Last Attempt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {contactsData.contacts.map((c) => (
                      <tr key={c.id} className="hover:bg-surface-hover">
                        <td className="px-4 py-2.5 text-sm text-text-primary font-mono">{formatPhone(c.phoneNumber)}</td>
                        <td className="px-4 py-2.5 text-sm text-text-primary">{c.name ?? '—'}</td>
                        <td className="px-4 py-2.5"><StatusBadge status={c.status} colors={CONTACT_STATUS_COLORS} /></td>
                        <td className="px-4 py-2.5 text-sm text-text-muted">{c.attemptCount}</td>
                        <td className="px-4 py-2.5 text-sm text-text-muted">{c.lastAttemptedAt ? formatDate(c.lastAttemptedAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {contactsData.total > 20 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-text-muted">Page {contactPage} of {Math.ceil(contactsData.total / 20)}</p>
                  <div className="flex gap-2">
                    <button disabled={contactPage <= 1} onClick={() => setContactPage((p) => p - 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronLeft className="h-4 w-4" /></button>
                    <button disabled={contactPage >= Math.ceil(contactsData.total / 20)} onClick={() => setContactPage((p) => p + 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronRight className="h-4 w-4" /></button>
                  </div>
                </div>
              )}
            </>
          )}

          {showAddContacts && (
            <AddContactsModal
              campaignId={campaignId}
              onClose={() => setShowAddContacts(false)}
              onAdded={() => queryClient.invalidateQueries({ queryKey: ['campaign-contacts', campaignId] })}
            />
          )}
        </div>
      )}

      {tab === 'dnc' && <DncPanel />}
    </div>
  );
}

function DncPanel() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [addPhone, setAddPhone] = useState('');
  const [addReason, setAddReason] = useState('');
  const [error, setError] = useState('');

  const { data: dncData, isLoading } = useQuery({
    queryKey: ['dnc', page],
    queryFn: () => api.get<{ entries: DncEntry[]; total: number }>(`/campaigns/dnc?page=${page}&limit=50`),
  });

  const addMutation = useMutation({
    mutationFn: () => api.post('/campaigns/dnc', { phone: addPhone, reason: addReason || undefined }),
    onSuccess: () => { setAddPhone(''); setAddReason(''); queryClient.invalidateQueries({ queryKey: ['dnc'] }); },
    onError: (err: Error) => setError(err.message),
  });

  const handleRemove = async (phone: string) => {
    try {
      await fetch('/api/campaigns/dnc', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
        body: JSON.stringify({ phone }),
      });
      queryClient.invalidateQueries({ queryKey: ['dnc'] });
    } catch (err) {
      setError('Failed to remove number from DNC list');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">
          Do Not Call List {dncData && <span className="text-text-muted font-normal">({dncData.total})</span>}
        </h3>
      </div>

      <div className="mb-4 flex gap-2">
        <input type="text" placeholder="Phone number" value={addPhone} onChange={(e) => setAddPhone(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
        <input type="text" placeholder="Reason (optional)" value={addReason} onChange={(e) => setAddReason(e.target.value)} className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
        <button onClick={() => { setError(''); addMutation.mutate(); }} disabled={!addPhone.trim() || addMutation.isPending} className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg disabled:opacity-50">
          Add
        </button>
      </div>
      {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg mb-3">{error}</div>}

      {isLoading ? (
        <div className="flex items-center justify-center py-12"><div className="animate-spin h-6 w-6 border-3 border-primary border-t-transparent rounded-full" /></div>
      ) : !dncData || dncData.entries.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          <ShieldOff className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No numbers on the DNC list</p>
        </div>
      ) : (
        <>
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">Phone</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">Reason</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">Source</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-text-muted">Added</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dncData.entries.map((e) => (
                  <tr key={e.id} className="hover:bg-surface-hover">
                    <td className="px-4 py-2.5 text-sm text-text-primary font-mono">{formatPhone(e.phoneNumber)}</td>
                    <td className="px-4 py-2.5 text-sm text-text-muted">{e.reason ?? '—'}</td>
                    <td className="px-4 py-2.5 text-sm text-text-muted capitalize">{e.source}</td>
                    <td className="px-4 py-2.5 text-sm text-text-muted">{formatDate(e.createdAt)}</td>
                    <td className="px-4 py-2.5">
                      <button onClick={() => handleRemove(e.phoneNumber)} className="text-text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {dncData.total > 50 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-text-muted">Page {page} of {Math.ceil(dncData.total / 50)}</p>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronLeft className="h-4 w-4" /></button>
                <button disabled={page >= Math.ceil(dncData.total / 50)} onClick={() => setPage((p) => p + 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Campaigns() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | ''>('');
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['campaigns', statusFilter, page],
    queryFn: () =>
      api.get<{ campaigns: Campaign[]; total: number }>(
        `/campaigns?page=${page}&limit=20${statusFilter ? `&status=${statusFilter}` : ''}`,
      ),
  });

  if (selectedId) {
    return (
      <CampaignDetail
        campaignId={selectedId}
        onBack={() => { setSelectedId(null); queryClient.invalidateQueries({ queryKey: ['campaigns'] }); }}
      />
    );
  }

  const campaigns = data?.campaigns ?? [];
  const total = data?.total ?? 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Campaigns</h1>
          <p className="text-sm text-text-muted mt-0.5">Create and manage outbound calling campaigns</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg">
          <Plus className="h-4 w-4" /> New Campaign
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        {(['', 'draft', 'running', 'paused', 'completed', 'cancelled'] as const).map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              statusFilter === s ? 'bg-primary text-white' : 'bg-surface-hover text-text-secondary hover:text-text-primary'
            }`}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" /></div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-20 text-text-muted">
          <Megaphone className="h-10 w-10 mx-auto mb-3 opacity-50" />
          <p className="text-lg font-medium text-text-primary mb-1">No campaigns yet</p>
          <p className="text-sm">Create your first outbound campaign to get started.</p>
          <button onClick={() => setShowCreate(true)} className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg">
            <Plus className="h-4 w-4" /> New Campaign
          </button>
        </div>
      ) : (
        <>
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">Name</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">Created</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-text-muted">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {campaigns.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className="hover:bg-surface-hover cursor-pointer"
                  >
                    <td className="px-4 py-3 text-sm font-medium text-text-primary">{c.name}</td>
                    <td className="px-4 py-3"><StatusBadge status={c.status} colors={STATUS_COLORS} /></td>
                    <td className="px-4 py-3 text-sm text-text-muted capitalize">{c.type.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3 text-sm text-text-muted">{formatDate(c.createdAt)}</td>
                    <td className="px-4 py-3 text-sm text-text-muted">{formatDate(c.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > 20 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-text-muted">Showing {campaigns.length} of {total} campaigns</p>
              <div className="flex gap-2">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronLeft className="h-4 w-4" /></button>
                <button disabled={page >= Math.ceil(total / 20)} onClick={() => setPage((p) => p + 1)} className="p-1.5 rounded border border-border disabled:opacity-30 hover:bg-surface-hover"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>
          )}
        </>
      )}

      {showCreate && (
        <CreateCampaignModal
          onClose={() => setShowCreate(false)}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ['campaigns'] })}
        />
      )}
    </div>
  );
}
