import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import Modal from '../components/Modal';
import { PageHeader } from '../components/ui';
import {
  TICKET_TEMPLATE_TOKENS,
  findUnknownTicketTemplateTokens,
} from '../../../shared/tickets/templateTokens';
import {
  ArrowLeft, Settings2, Plus, X, Trash2, Edit, Tag, Shield,
  Zap, FileText, Columns, GitBranch, Save, ToggleLeft, ToggleRight,
  Users, Archive,
} from 'lucide-react';

interface Category { id: string; name: string; description: string; is_active: boolean; sort_order: number; }
interface SlaPolicy { id: string; name: string; description: string; priority: string; first_response_minutes: number; resolution_minutes: number; escalation_minutes: number | null; is_active: boolean; category_name: string | null; }
interface Macro { id: string; name: string; description: string; actions: Array<{ type: string; field?: string; value?: string; content?: string }>; is_active: boolean; }
interface Template { id: string; name: string; subject: string; body: string; is_active: boolean; category_name: string | null; }
interface CustomField { id: string; name: string; field_key: string; field_type: string; options: string[]; is_required: boolean; is_active: boolean; sort_order: number; }
interface WorkflowRule { id: string; name: string; description: string; trigger_event: string; conditions: Record<string, unknown>; actions: Array<Record<string, unknown>>; is_active: boolean; }

interface QueueConfig { id: string; name: string; description: string; assignment_strategy: string; eligible_user_ids: string[]; filter_priority: string[]; filter_department: string; max_tickets_per_agent: number; is_active: boolean; }
interface RetentionPolicy { id: string; name: string; description: string; target_status: string; days_after_close: number; action: string; is_active: boolean; last_run_at: string | null; }

type AdminTab = 'categories' | 'sla' | 'macros' | 'templates' | 'fields' | 'rules' | 'queues' | 'retention' | 'operations';

function OperationsPanel({ isReadOnly }: { isReadOnly: boolean }) {
  const [slaResult, setSlaResult] = useState<{ breaches_processed: number; tickets_checked: number } | null>(null);
  const [closeResult, setCloseResult] = useState<{ auto_closed: number; resolved_closed: number; pending_closed: number } | null>(null);
  const [running, setRunning] = useState('');
  const [daysResolved, setDaysResolved] = useState(14);
  const [daysPending, setDaysPending] = useState(30);

  const runSlaBreach = async () => {
    setRunning('sla');
    setSlaResult(null);
    try {
      const data = await api.post<{ breaches_processed: number; tickets_checked: number }>('/tickets/sla/process-breaches', {});
      setSlaResult(data);
    } catch { setSlaResult({ breaches_processed: -1, tickets_checked: 0 }); }
    setRunning('');
  };

  const runAutoClose = async () => {
    setRunning('close');
    setCloseResult(null);
    try {
      const data = await api.post<{ auto_closed: number; resolved_closed: number; pending_closed: number }>('/tickets/auto-close', { days_resolved: daysResolved, days_pending: daysPending });
      setCloseResult(data);
    } catch { setCloseResult({ auto_closed: -1, resolved_closed: 0, pending_closed: 0 }); }
    setRunning('');
  };

  return (
    <div className="p-6 space-y-6">
      <div className="border border-border rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-heading">SLA Breach Detection</h3>
        <p className="text-xs text-muted">Scan all active tickets for SLA breaches. Tickets with breached resolution times are automatically escalated.</p>
        {!isReadOnly && (
          <button onClick={runSlaBreach} disabled={running === 'sla'} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50">
            {running === 'sla' ? 'Processing...' : 'Run SLA Breach Check'}
          </button>
        )}
        {slaResult && (
          <div className={`text-sm p-3 rounded-lg ${slaResult.breaches_processed < 0 ? 'bg-red-50 dark:bg-red-900/20 text-red-600' : 'bg-green-50 dark:bg-green-900/20 text-green-600'}`}>
            {slaResult.breaches_processed < 0 ? 'Failed to process' : `Checked ${slaResult.tickets_checked} tickets, processed ${slaResult.breaches_processed} breaches`}
          </div>
        )}
      </div>

      <div className="border border-border rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-heading">Auto-Close Inactive Tickets</h3>
        <p className="text-xs text-muted">Automatically close tickets that have been resolved or pending beyond the configured thresholds.</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-muted mb-1">Close resolved after (days)</label>
            <input type="number" value={daysResolved} onChange={e => setDaysResolved(parseInt(e.target.value) || 14)} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm" />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Close pending after (days)</label>
            <input type="number" value={daysPending} onChange={e => setDaysPending(parseInt(e.target.value) || 30)} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm" />
          </div>
        </div>
        {!isReadOnly && (
          <button onClick={runAutoClose} disabled={running === 'close'} className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50">
            {running === 'close' ? 'Processing...' : 'Run Auto-Close'}
          </button>
        )}
        {closeResult && (
          <div className={`text-sm p-3 rounded-lg ${closeResult.auto_closed < 0 ? 'bg-red-50 dark:bg-red-900/20 text-red-600' : 'bg-green-50 dark:bg-green-900/20 text-green-600'}`}>
            {closeResult.auto_closed < 0 ? 'Failed to process' : `Closed ${closeResult.auto_closed} tickets (${closeResult.resolved_closed} resolved, ${closeResult.pending_closed} pending)`}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TicketAdmin() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isReadOnly = !['tenant_owner', 'operations_manager'].includes(user?.role ?? '');

  const [tab, setTab] = useState<AdminTab>('categories');
  const [categories, setCategories] = useState<Category[]>([]);
  const [slaPolicies, setSlaPolicies] = useState<SlaPolicy[]>([]);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [workflowRules, setWorkflowRules] = useState<WorkflowRule[]>([]);
  const [queueConfigs, setQueueConfigs] = useState<QueueConfig[]>([]);
  const [retentionPolicies, setRetentionPolicies] = useState<RetentionPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState<Record<string, unknown> | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [cats, sla, mac, tmpl, fields, rules, queues, retention] = await Promise.all([
        api.get<{ categories: Category[] }>('/ticket-categories'),
        api.get<{ policies: SlaPolicy[] }>('/ticket-sla-policies'),
        api.get<{ macros: Macro[] }>('/ticket-macros'),
        api.get<{ templates: Template[] }>('/ticket-templates'),
        api.get<{ fields: CustomField[] }>('/ticket-custom-fields'),
        api.get<{ rules: WorkflowRule[] }>('/ticket-workflow-rules'),
        api.get<{ queues: QueueConfig[] }>('/ticket-queue-configs'),
        api.get<{ policies: RetentionPolicy[] }>('/ticket-retention-policies'),
      ]);
      setCategories(cats.categories);
      setSlaPolicies(sla.policies);
      setMacros(mac.macros);
      setTemplates(tmpl.templates);
      setCustomFields(fields.fields);
      setWorkflowRules(rules.rules);
      setQueueConfigs(queues.queues);
      setRetentionPolicies(retention.policies);
    } catch {
      setError('Failed to load configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const deleteItem = async (endpoint: string, id: string) => {
    try {
      await api.delete(`/${endpoint}/${id}`);
      fetchAll();
    } catch {
      setError('Failed to delete');
    }
  };

  // Surface typos like {{custmer_name}} before they ship in a
  // customer-facing reply — see task #806 and
  // shared/tickets/templateTokens.ts. The renderer (insertTemplate in
  // TicketDetail) only substitutes tokens in the same allowlist, so
  // anything else would leak through as raw braces.
  const unknownTemplateBodyTokens = useMemo(
    () => (tab === 'templates' && editItem
      ? findUnknownTicketTemplateTokens(editItem.body as string | undefined)
      : []),
    [tab, editItem],
  );
  const hasUnknownTemplateTokens = unknownTemplateBodyTokens.length > 0;

  const saveItem = async () => {
    if (!editItem) return;
    if (tab === 'templates' && hasUnknownTemplateTokens) {
      setError(`Unknown merge token${unknownTemplateBodyTokens.length === 1 ? '' : 's'}: ${unknownTemplateBodyTokens.map(t => `{{${t}}}`).join(', ')}. Fix or remove them before saving.`);
      return;
    }
    try {
      const { _endpoint, _isNew, id, ...data } = editItem as Record<string, unknown>;
      if (_isNew) {
        await api.post(`/${_endpoint as string}`, data);
      } else {
        await api.put(`/${_endpoint as string}/${id as string}`, data);
      }
      setShowModal(false);
      setEditItem(null);
      fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const openNew = () => {
    const defaults: Record<AdminTab, Record<string, unknown>> = {
      categories: { _endpoint: 'ticket-categories', _isNew: true, name: '', description: '', sort_order: 0 },
      sla: { _endpoint: 'ticket-sla-policies', _isNew: true, name: '', description: '', priority: 'medium', first_response_minutes: 480, resolution_minutes: 2880, escalation_minutes: '' },
      macros: { _endpoint: 'ticket-macros', _isNew: true, name: '', description: '', actions: [{ type: 'set_field', field: 'status', value: 'in_progress' }] },
      templates: { _endpoint: 'ticket-templates', _isNew: true, name: '', subject: '', body: '' },
      fields: { _endpoint: 'ticket-custom-fields', _isNew: true, name: '', field_key: '', field_type: 'text', options: [], is_required: false, sort_order: 0 },
      rules: { _endpoint: 'ticket-workflow-rules', _isNew: true, name: '', description: '', trigger_event: 'ticket_created', conditions: [], actions: [{ type: 'set_field', field: 'status', value: 'in_progress' }] },
      queues: { _endpoint: 'ticket-queue-configs', _isNew: true, name: '', description: '', assignment_strategy: 'round_robin', eligible_user_ids: [], filter_priority: [], filter_department: '', max_tickets_per_agent: 0 },
      retention: { _endpoint: 'ticket-retention-policies', _isNew: true, name: '', description: '', target_status: 'closed', days_after_close: 90, action: 'archive' },
      operations: {},
    };
    setEditItem(defaults[tab]);
    setShowModal(true);
  };

  const openEdit = (item: object, endpoint: string) => {
    setEditItem({ ...(item as Record<string, unknown>), _endpoint: endpoint, _isNew: false });
    setShowModal(true);
  };

  const tabs: { key: AdminTab; label: string; icon: typeof Tag }[] = [
    { key: 'categories', label: 'Categories', icon: Tag },
    { key: 'sla', label: 'SLA Policies', icon: Shield },
    { key: 'macros', label: 'Macros', icon: Zap },
    { key: 'templates', label: 'Templates', icon: FileText },
    { key: 'fields', label: 'Custom Fields', icon: Columns },
    { key: 'rules', label: 'Workflow Rules', icon: GitBranch },
    { key: 'queues', label: 'Queue Config', icon: Users },
    { key: 'retention', label: 'Retention', icon: Archive },
    { key: 'operations', label: 'Operations', icon: Settings2 },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Settings2 className="h-5 w-5" />}
        title="Ticket Administration"
        description="Configure categories, SLAs, macros, and automation"
        breadcrumbs={(
          <button onClick={() => navigate('/tickets')} className="inline-flex items-center gap-1 hover:text-text-primary">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to tickets
          </button>
        )}
        actions={!isReadOnly && (
          <button onClick={openNew} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2">
            <Plus className="h-4 w-4" /> Add New
          </button>
        )}
      />

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              tab === t.key ? 'bg-primary text-white' : 'bg-surface border border-border text-muted hover:text-heading'
            }`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        {tab === 'categories' && (
          <table className="w-full">
            <thead><tr className="border-b border-border">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Description</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-muted">Actions</th>
            </tr></thead>
            <tbody>
              {categories.length === 0 ? <tr><td colSpan={4} className="text-center py-8 text-sm text-muted">No categories configured</td></tr> :
              categories.map(c => (
                <tr key={c.id} className="border-b border-border">
                  <td className="px-4 py-3 text-sm text-heading font-medium">{c.name}</td>
                  <td className="px-4 py-3 text-sm text-muted">{c.description || '-'}</td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full ${c.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-surface-hover text-text-secondary'}`}>{c.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td className="px-4 py-3 text-right">
                    {!isReadOnly && <>
                      <button onClick={() => openEdit(c, 'ticket-categories')} className="text-xs text-primary hover:underline mr-2">Edit</button>
                      <button onClick={() => deleteItem('ticket-categories', c.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'sla' && (
          <table className="w-full">
            <thead><tr className="border-b border-border">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Priority</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">First Response</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Resolution</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-muted">Actions</th>
            </tr></thead>
            <tbody>
              {slaPolicies.length === 0 ? <tr><td colSpan={6} className="text-center py-8 text-sm text-muted">No SLA policies configured</td></tr> :
              slaPolicies.map(p => (
                <tr key={p.id} className="border-b border-border">
                  <td className="px-4 py-3 text-sm text-heading font-medium">{p.name}</td>
                  <td className="px-4 py-3 text-sm text-muted capitalize">{p.priority}</td>
                  <td className="px-4 py-3 text-sm text-muted">{p.first_response_minutes}m ({Math.round(p.first_response_minutes / 60)}h)</td>
                  <td className="px-4 py-3 text-sm text-muted">{p.resolution_minutes}m ({Math.round(p.resolution_minutes / 60)}h)</td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full ${p.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-surface-hover text-text-secondary'}`}>{p.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td className="px-4 py-3 text-right">
                    {!isReadOnly && <>
                      <button onClick={() => openEdit(p, 'ticket-sla-policies')} className="text-xs text-primary hover:underline mr-2">Edit</button>
                      <button onClick={() => deleteItem('ticket-sla-policies', p.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'macros' && (
          <table className="w-full">
            <thead><tr className="border-b border-border">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Description</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Actions</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-muted">Manage</th>
            </tr></thead>
            <tbody>
              {macros.length === 0 ? <tr><td colSpan={5} className="text-center py-8 text-sm text-muted">No macros configured</td></tr> :
              macros.map(m => (
                <tr key={m.id} className="border-b border-border">
                  <td className="px-4 py-3 text-sm text-heading font-medium">{m.name}</td>
                  <td className="px-4 py-3 text-sm text-muted">{m.description || '-'}</td>
                  <td className="px-4 py-3 text-xs text-muted">{Array.isArray(m.actions) ? m.actions.length : 0} action(s)</td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full ${m.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-surface-hover text-text-secondary'}`}>{m.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td className="px-4 py-3 text-right">
                    {!isReadOnly && <>
                      <button onClick={() => openEdit(m, 'ticket-macros')} className="text-xs text-primary hover:underline mr-2">Edit</button>
                      <button onClick={() => deleteItem('ticket-macros', m.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'templates' && (
          <table className="w-full">
            <thead><tr className="border-b border-border">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Subject</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Category</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-muted">Actions</th>
            </tr></thead>
            <tbody>
              {templates.length === 0 ? <tr><td colSpan={5} className="text-center py-8 text-sm text-muted">No templates configured</td></tr> :
              templates.map(t => (
                <tr key={t.id} className="border-b border-border">
                  <td className="px-4 py-3 text-sm text-heading font-medium">{t.name}</td>
                  <td className="px-4 py-3 text-sm text-muted">{t.subject || '-'}</td>
                  <td className="px-4 py-3 text-sm text-muted">{t.category_name || '-'}</td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full ${t.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-surface-hover text-text-secondary'}`}>{t.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td className="px-4 py-3 text-right">
                    {!isReadOnly && <>
                      <button onClick={() => openEdit(t, 'ticket-templates')} className="text-xs text-primary hover:underline mr-2">Edit</button>
                      <button onClick={() => deleteItem('ticket-templates', t.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'fields' && (
          <table className="w-full">
            <thead><tr className="border-b border-border">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Key</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Type</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Required</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-muted">Actions</th>
            </tr></thead>
            <tbody>
              {customFields.length === 0 ? <tr><td colSpan={6} className="text-center py-8 text-sm text-muted">No custom fields configured</td></tr> :
              customFields.map(f => (
                <tr key={f.id} className="border-b border-border">
                  <td className="px-4 py-3 text-sm text-heading font-medium">{f.name}</td>
                  <td className="px-4 py-3 text-xs text-muted font-mono">{f.field_key}</td>
                  <td className="px-4 py-3 text-sm text-muted capitalize">{f.field_type.replace('_', ' ')}</td>
                  <td className="px-4 py-3 text-sm text-muted">{f.is_required ? 'Yes' : 'No'}</td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full ${f.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-surface-hover text-text-secondary'}`}>{f.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td className="px-4 py-3 text-right">
                    {!isReadOnly && <>
                      <button onClick={() => openEdit(f, 'ticket-custom-fields')} className="text-xs text-primary hover:underline mr-2">Edit</button>
                      <button onClick={() => deleteItem('ticket-custom-fields', f.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'rules' && (
          <table className="w-full">
            <thead><tr className="border-b border-border">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Trigger</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Description</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-muted">Actions</th>
            </tr></thead>
            <tbody>
              {workflowRules.length === 0 ? <tr><td colSpan={5} className="text-center py-8 text-sm text-muted">No workflow rules configured</td></tr> :
              workflowRules.map(r => (
                <tr key={r.id} className="border-b border-border">
                  <td className="px-4 py-3 text-sm text-heading font-medium">{r.name}</td>
                  <td className="px-4 py-3 text-xs text-muted capitalize">{r.trigger_event.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-3 text-sm text-muted">{r.description || '-'}</td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full ${r.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-surface-hover text-text-secondary'}`}>{r.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td className="px-4 py-3 text-right">
                    {!isReadOnly && <>
                      <button onClick={() => openEdit(r, 'ticket-workflow-rules')} className="text-xs text-primary hover:underline mr-2">Edit</button>
                      <button onClick={() => deleteItem('ticket-workflow-rules', r.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'queues' && (
          <table className="w-full">
            <thead><tr className="border-b border-border">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Name</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Strategy</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Agents</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Max/Agent</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
              <th className="text-right px-4 py-3 text-xs font-medium text-muted">Actions</th>
            </tr></thead>
            <tbody>
              {queueConfigs.length === 0 ? <tr><td colSpan={6} className="text-center py-8 text-sm text-muted">No queue configurations</td></tr> :
              queueConfigs.map(q => (
                <tr key={q.id} className="border-b border-border">
                  <td className="px-4 py-3 text-sm text-heading font-medium">{q.name}</td>
                  <td className="px-4 py-3 text-xs text-muted capitalize">{q.assignment_strategy.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-3 text-xs text-muted">{q.eligible_user_ids?.length || 0} agents</td>
                  <td className="px-4 py-3 text-xs text-muted">{q.max_tickets_per_agent || 'Unlimited'}</td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full ${q.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-surface-hover text-text-secondary'}`}>{q.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td className="px-4 py-3 text-right">
                    {!isReadOnly && <>
                      <button onClick={() => openEdit(q, 'ticket-queue-configs')} className="text-xs text-primary hover:underline mr-2">Edit</button>
                      <button onClick={() => deleteItem('ticket-queue-configs', q.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'retention' && (
          <div>
            <table className="w-full">
              <thead><tr className="border-b border-border">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Target Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Days After Close</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Action</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted">Actions</th>
              </tr></thead>
              <tbody>
                {retentionPolicies.length === 0 ? <tr><td colSpan={6} className="text-center py-8 text-sm text-muted">No retention policies configured</td></tr> :
                retentionPolicies.map(p => (
                  <tr key={p.id} className="border-b border-border">
                    <td className="px-4 py-3 text-sm text-heading font-medium">{p.name}</td>
                    <td className="px-4 py-3 text-xs text-muted capitalize">{p.target_status}</td>
                    <td className="px-4 py-3 text-xs text-muted">{p.days_after_close} days</td>
                    <td className="px-4 py-3 text-xs text-muted capitalize">{p.action}</td>
                    <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-full ${p.is_active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-surface-hover text-text-secondary'}`}>{p.is_active ? 'Active' : 'Inactive'}</span></td>
                    <td className="px-4 py-3 text-right">
                      {!isReadOnly && <>
                        <button onClick={() => openEdit(p, 'ticket-retention-policies')} className="text-xs text-primary hover:underline mr-2">Edit</button>
                        <button onClick={() => deleteItem('ticket-retention-policies', p.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!isReadOnly && (
              <div className="p-4 border-t border-border">
                <button
                  onClick={async () => {
                    try {
                      const result = await api.post<{ policies_run: number; tickets_processed: number }>('/tickets/retention/execute', {});
                      alert(`Retention executed: ${result.policies_run} policies run, ${result.tickets_processed} tickets processed`);
                      fetchAll();
                    } catch { alert('Failed to execute retention policies'); }
                  }}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-orange-500 text-white hover:bg-orange-600"
                >
                  Execute Retention Policies Now
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'operations' && (
          <OperationsPanel isReadOnly={isReadOnly} />
        )}
      </div>

      {showModal && editItem && (
        <Modal open onClose={() => { setShowModal(false); setEditItem(null); }} ariaLabel={`${editItem._isNew ? 'Create' : 'Edit'} ${tab.replace(/s$/, '')}`} panelClassName="bg-surface border border-border rounded-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="font-semibold text-heading">{editItem._isNew ? 'Create' : 'Edit'} {tab.replace(/s$/, '')}</h3>
              <button onClick={() => { setShowModal(false); setEditItem(null); }} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Name *</label>
                <input type="text" value={(editItem.name as string) || ''} onChange={e => setEditItem(p => ({ ...p!, name: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>

              {(tab === 'categories' || tab === 'sla' || tab === 'macros' || tab === 'rules' || tab === 'queues' || tab === 'retention') && (
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Description</label>
                  <textarea value={(editItem.description as string) || ''} onChange={e => setEditItem(p => ({ ...p!, description: e.target.value }))} rows={2} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              )}

              {tab === 'sla' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Priority *</label>
                    <select value={(editItem.priority as string) || 'medium'} onChange={e => setEditItem(p => ({ ...p!, priority: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                      {['low', 'medium', 'high', 'urgent'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1">First Response (minutes)</label>
                      <input type="number" value={(editItem.first_response_minutes as number) || 480} onChange={e => setEditItem(p => ({ ...p!, first_response_minutes: parseInt(e.target.value) }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1">Resolution (minutes)</label>
                      <input type="number" value={(editItem.resolution_minutes as number) || 2880} onChange={e => setEditItem(p => ({ ...p!, resolution_minutes: parseInt(e.target.value) }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                  </div>
                </>
              )}

              {tab === 'templates' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Subject</label>
                    <input type="text" value={(editItem.subject as string) || ''} onChange={e => setEditItem(p => ({ ...p!, subject: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Body *</label>
                    <textarea
                      value={(editItem.body as string) || ''}
                      onChange={e => setEditItem(p => ({ ...p!, body: e.target.value }))}
                      rows={5}
                      placeholder={`Use ${TICKET_TEMPLATE_TOKENS.map(t => `{{${t}}}`).join(', ')} for dynamic content.`}
                      aria-invalid={hasUnknownTemplateTokens || undefined}
                      className={`w-full px-3 py-2 rounded-lg border bg-surface text-heading text-sm focus:outline-none focus:ring-2 ${
                        hasUnknownTemplateTokens
                          ? 'border-amber-500 focus:ring-amber-500/30'
                          : 'border-border focus:ring-primary/30'
                      }`}
                    />
                    {hasUnknownTemplateTokens && (
                      <p
                        role="alert"
                        data-testid="ticket-template-unknown-token-warning"
                        className="mt-1 text-[11px] text-amber-700 dark:text-amber-400"
                      >
                        Unknown merge token{unknownTemplateBodyTokens.length === 1 ? '' : 's'}{' '}
                        {unknownTemplateBodyTokens.map((t, i) => (
                          <span key={t}>
                            {i > 0 && ', '}
                            <code>{`{{${t}}}`}</code>
                          </span>
                        ))}
                        {' '}— customers will see the raw text. Saving is blocked until you fix or remove these.
                      </p>
                    )}
                    <p className="mt-1 text-[11px] text-muted">
                      Supported tokens:{' '}
                      {TICKET_TEMPLATE_TOKENS.map((t, i) => (
                        <span key={t}>
                          {i > 0 && ', '}
                          <code>{`{{${t}}}`}</code>
                        </span>
                      ))}
                      .
                    </p>
                  </div>
                </>
              )}

              {tab === 'fields' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Field Key *</label>
                    <input type="text" value={(editItem.field_key as string) || ''} onChange={e => setEditItem(p => ({ ...p!, field_key: e.target.value }))} placeholder="e.g., customer_type" className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Field Type *</label>
                    <select value={(editItem.field_type as string) || 'text'} onChange={e => setEditItem(p => ({ ...p!, field_type: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                      {['text', 'number', 'select', 'multi_select', 'date', 'boolean', 'url'].map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={!!editItem.is_required} onChange={e => setEditItem(p => ({ ...p!, is_required: e.target.checked }))} className="rounded border-border" />
                    <label className="text-xs text-muted">Required field</label>
                  </div>
                </>
              )}

              {tab === 'rules' && (
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Trigger Event *</label>
                  <select value={(editItem.trigger_event as string) || 'ticket_created'} onChange={e => setEditItem(p => ({ ...p!, trigger_event: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    {['ticket_created', 'status_change', 'priority_change', 'assigned', 'sla_breach', 'time_based'].map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
              )}

              {tab === 'queues' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Assignment Strategy *</label>
                    <select value={(editItem.assignment_strategy as string) || 'round_robin'} onChange={e => setEditItem(p => ({ ...p!, assignment_strategy: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                      <option value="manual">Manual</option>
                      <option value="round_robin">Round Robin</option>
                      <option value="least_loaded">Least Loaded</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Eligible Agent User IDs (comma-separated)</label>
                    <input type="text" value={((editItem.eligible_user_ids as string[]) || []).join(', ')} onChange={e => setEditItem(p => ({ ...p!, eligible_user_ids: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))} placeholder="user-id-1, user-id-2" className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1">Filter Department</label>
                      <input type="text" value={(editItem.filter_department as string) || ''} onChange={e => setEditItem(p => ({ ...p!, filter_department: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1">Max Tickets/Agent</label>
                      <input type="number" value={(editItem.max_tickets_per_agent as number) || 0} onChange={e => setEditItem(p => ({ ...p!, max_tickets_per_agent: parseInt(e.target.value) || 0 }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                  </div>
                </>
              )}

              {tab === 'retention' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1">Target Status</label>
                      <select value={(editItem.target_status as string) || 'closed'} onChange={e => setEditItem(p => ({ ...p!, target_status: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                        <option value="closed">Closed</option>
                        <option value="resolved">Resolved</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted mb-1">Days After Close</label>
                      <input type="number" value={(editItem.days_after_close as number) || 90} onChange={e => setEditItem(p => ({ ...p!, days_after_close: parseInt(e.target.value) || 90 }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Action *</label>
                    <select value={(editItem.action as string) || 'archive'} onChange={e => setEditItem(p => ({ ...p!, action: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                      <option value="archive">Archive</option>
                      <option value="delete">Delete</option>
                      <option value="anonymize">Anonymize</option>
                    </select>
                  </div>
                </>
              )}
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button onClick={() => { setShowModal(false); setEditItem(null); }} className="px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-heading bg-surface-secondary">Cancel</button>
              <button
                onClick={saveItem}
                disabled={tab === 'templates' && hasUnknownTemplateTokens}
                title={tab === 'templates' && hasUnknownTemplateTokens ? 'Fix the unknown merge tokens before saving.' : undefined}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
              >
                <Save className="h-4 w-4" /> Save
              </button>
            </div>
        </Modal>
      )}
    </div>
  );
}
