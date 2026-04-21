import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Ticket, Plus, X, AlertCircle, Clock, CheckCircle2, ChevronLeft, ChevronRight,
  Search, Filter, AlertTriangle, Shield, Users, Eye, Inbox, RotateCcw,
  ArrowUpDown, ChevronDown, MoreHorizontal, User, ArrowUp,
} from 'lucide-react';

interface TicketItem {
  id: string;
  ticket_number: number;
  subject: string;
  description: string;
  status: string;
  priority: string;
  assignee_user_id: string | null;
  assignee_email: string | null;
  category_name: string | null;
  department: string;
  source: string;
  tags: string[];
  reopened_count: number;
  created_at: string;
  updated_at: string;
  sla_instance: {
    resolution_due_at: string | null;
    resolution_met: boolean | null;
    response_met: boolean | null;
  } | null;
}

interface TeamMember { id: string; email: string; }
interface Category { id: string; name: string; }
interface SavedView { id: string; name: string; filters: Record<string, string>; }

interface TicketStats {
  statusCounts: Record<string, number>;
  priorityCounts: Record<string, number>;
  unassignedCount: number;
  slaAtRisk: number;
  slaBreached: number;
  avgResolutionHours: number;
  avgFirstResponseHours: number;
  queueCounts?: Record<string, number>;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  open: { label: 'Open', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300', icon: AlertCircle },
  in_progress: { label: 'In Progress', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300', icon: Clock },
  pending: { label: 'Pending', color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300', icon: Clock },
  escalated: { label: 'Escalated', color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300', icon: AlertTriangle },
  resolved: { label: 'Resolved', color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300', icon: CheckCircle2 },
  closed: { label: 'Closed', color: 'bg-surface-hover text-text-primary', icon: CheckCircle2 },
  reopened: { label: 'Reopened', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300', icon: RotateCcw },
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-text-secondary',
  medium: 'text-blue-500',
  high: 'text-orange-500',
  urgent: 'text-red-500',
};

const QUEUE_TABS = [
  { key: '', label: 'All Tickets', icon: Inbox, isQueue: false },
  { key: 'open', label: 'New', icon: AlertCircle, isQueue: false },
  { key: 'in_progress', label: 'In Progress', icon: Clock, isQueue: false },
  { key: 'pending', label: 'Pending', icon: Clock, isQueue: false },
  { key: 'escalated', label: 'Escalated', icon: AlertTriangle, isQueue: false },
  { key: 'resolved', label: 'Resolved', icon: CheckCircle2, isQueue: false },
  { key: 'closed', label: 'Closed', icon: CheckCircle2, isQueue: false },
  { key: 'reopened', label: 'Reopened', icon: RotateCcw, isQueue: false },
  { key: 'my_tickets', label: 'My Tickets', icon: User, isQueue: true },
  { key: 'unassigned', label: 'Unassigned', icon: Users, isQueue: true },
  { key: 'overdue', label: 'Overdue', icon: AlertTriangle, isQueue: true },
  { key: 'high_priority', label: 'High Priority', icon: ArrowUp, isQueue: true },
  { key: 'aging', label: 'Aging', icon: Clock, isQueue: true },
];

export default function Tickets() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isReadOnly = !['tenant_owner', 'operations_manager'].includes(user?.role ?? '');
  const [tickets, setTickets] = useState<TicketItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterQueue, setFilterQueue] = useState('');
  const [filterDepartment, setFilterDepartment] = useState('');
  const [filterSlaRisk, setFilterSlaRisk] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTickets, setSelectedTickets] = useState<Set<string>>(new Set());
  const [showBulkMenu, setShowBulkMenu] = useState(false);
  const [sortBy, setSortBy] = useState('created_at');
  const [sortOrder, setSortOrder] = useState('desc');
  const [showFilters, setShowFilters] = useState(false);

  const [formData, setFormData] = useState({
    subject: '', description: '', status: 'open', priority: 'medium',
    assignee_user_id: '', notes: '', category_id: '', department: '',
    contact_name: '', contact_email: '', contact_phone: '', source: 'manual',
  });

  const fetchTickets = useCallback(async () => {
    try {
      let url = `/tickets?page=${page}&limit=20&sort_by=${sortBy}&sort_order=${sortOrder}`;
      if (filterStatus) url += `&status=${filterStatus}`;
      if (filterQueue) url += `&queue=${filterQueue}`;
      if (filterPriority) url += `&priority=${filterPriority}`;
      if (filterAssignee) url += `&assignee=${filterAssignee}`;
      if (filterCategory) url += `&category_id=${filterCategory}`;
      if (filterDepartment) url += `&department=${encodeURIComponent(filterDepartment)}`;
      if (filterSlaRisk) url += `&sla_risk=${filterSlaRisk}`;
      if (searchTerm) url += `&search=${encodeURIComponent(searchTerm)}`;
      const data = await api.get<{ tickets: TicketItem[]; total: number }>(url);
      setTickets(data.tickets);
      setTotal(data.total);
    } catch {
      setError('Failed to load tickets');
    } finally {
      setLoading(false);
    }
  }, [page, filterStatus, filterPriority, filterAssignee, filterCategory, searchTerm, filterQueue, filterDepartment, filterSlaRisk, sortBy, sortOrder]);

  const fetchStats = useCallback(async () => {
    try {
      const data = await api.get<TicketStats>('/tickets/stats');
      setStats(data);
    } catch {}
  }, []);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);
  useEffect(() => { fetchStats(); }, [fetchStats]);

  useEffect(() => {
    Promise.all([
      api.get<{ users: TeamMember[] }>('/users?limit=100').then(d => setTeamMembers(d.users)),
      api.get<{ categories: Category[] }>('/ticket-categories').then(d => setCategories(d.categories)),
      api.get<{ views: SavedView[] }>('/ticket-saved-views').then(d => setSavedViews(d.views)),
    ]).catch(() => {});
  }, []);

  const saveTicket = async () => {
    if (!formData.subject) return;
    try {
      const payload = {
        ...formData,
        assignee_user_id: formData.assignee_user_id || null,
        category_id: formData.category_id || null,
      };
      await api.post('/tickets', payload);
      setShowForm(false);
      setFormData({ subject: '', description: '', status: 'open', priority: 'medium', assignee_user_id: '', notes: '', category_id: '', department: '', contact_name: '', contact_email: '', contact_phone: '', source: 'manual' });
      fetchTickets();
      fetchStats();
    } catch {
      setError('Failed to save ticket');
    }
  };

  const bulkAction = async (action: { status?: string; priority?: string; assignee_user_id?: string }) => {
    try {
      await api.post('/tickets/bulk', { ticket_ids: Array.from(selectedTickets), ...action });
      setSelectedTickets(new Set());
      setShowBulkMenu(false);
      fetchTickets();
      fetchStats();
    } catch {
      setError('Failed to perform bulk action');
    }
  };

  const toggleSort = (col: string) => {
    if (sortBy === col) {
      setSortOrder(o => o === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortOrder('desc');
    }
  };

  const toggleSelectAll = () => {
    if (selectedTickets.size === tickets.length) {
      setSelectedTickets(new Set());
    } else {
      setSelectedTickets(new Set(tickets.map(t => t.id)));
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedTickets);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedTickets(next);
  };

  const totalPages = Math.ceil(total / 20);

  const applySavedView = (view: SavedView) => {
    const f = view.filters;
    setFilterStatus(f.status || '');
    setFilterPriority(f.priority || '');
    setFilterAssignee(f.assignee || '');
    setFilterCategory(f.category_id || '');
    setFilterQueue(f.queue || '');
    setFilterDepartment(f.department || '');
    setFilterSlaRisk(f.sla_risk || '');
    setPage(1);
  };

  const getSlaIndicator = (ticket: TicketItem) => {
    if (!ticket.sla_instance) return null;
    const sla = ticket.sla_instance;
    if (sla.resolution_met === false || (sla.resolution_due_at && new Date(sla.resolution_due_at) < new Date() && sla.resolution_met === null)) {
      return <span title="SLA Breached" className="inline-flex"><AlertTriangle className="h-3.5 w-3.5 text-red-500" /></span>;
    }
    if (sla.resolution_due_at && new Date(sla.resolution_due_at).getTime() - Date.now() < 7200000 && sla.resolution_met === null) {
      return <span title="SLA At Risk" className="inline-flex"><Shield className="h-3.5 w-3.5 text-yellow-500" /></span>;
    }
    return null;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Ticket className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-heading">Tickets</h1>
            <p className="text-sm text-muted mt-0.5">Track and manage support tickets</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isReadOnly && (
            <button onClick={() => setShowForm(true)} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
              <Plus className="h-4 w-4" /> New Ticket
            </button>
          )}
          <button onClick={() => navigate('/tickets/reporting')} className="px-3 py-2 border border-border rounded-lg text-sm text-heading hover:bg-surface-secondary">
            Reports
          </button>
          {!isReadOnly && (
            <button onClick={() => navigate('/tickets/admin')} className="px-3 py-2 border border-border rounded-lg text-sm text-heading hover:bg-surface-secondary">
              Admin
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {[
            { label: 'Open', value: stats.statusCounts.open || 0, color: 'text-blue-600' },
            { label: 'In Progress', value: stats.statusCounts.in_progress || 0, color: 'text-yellow-600' },
            { label: 'Pending', value: stats.statusCounts.pending || 0, color: 'text-purple-600' },
            { label: 'Unassigned', value: stats.unassignedCount, color: 'text-text-secondary' },
            { label: 'SLA At Risk', value: stats.slaAtRisk, color: 'text-yellow-600' },
            { label: 'SLA Breached', value: stats.slaBreached, color: 'text-red-600' },
            { label: 'Avg Resolution', value: `${stats.avgResolutionHours}h`, color: 'text-green-600' },
          ].map(s => (
            <div key={s.label} className="bg-surface border border-border rounded-xl p-3 text-center">
              <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-[10px] text-muted mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-thin">
        {QUEUE_TABS.map(q => {
          const isActive = (q.key === '' && !filterQueue && !filterStatus) ||
            (!q.isQueue && q.key !== '' && filterStatus === q.key && !filterQueue) ||
            (q.isQueue && filterQueue === q.key);
          const count = !q.isQueue ? (stats?.statusCounts[q.key] ?? (q.key === '' ? total : undefined)) : (stats?.queueCounts?.[q.key] ?? undefined);
          return (
            <button
              key={q.key}
              onClick={() => {
                if (q.isQueue) { setFilterQueue(q.key); setFilterStatus(''); }
                else { setFilterStatus(q.key); setFilterQueue(''); }
                setPage(1);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                isActive ? 'bg-primary text-white' : 'bg-surface border border-border text-muted hover:text-heading hover:bg-surface-secondary'
              }`}
            >
              <q.icon className="h-3.5 w-3.5" />
              {q.label}
              {count !== undefined && <span className={`ml-0.5 ${isActive ? 'text-white/80' : 'text-muted'}`}>({count})</span>}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
          <input
            type="text"
            placeholder="Search tickets..."
            value={searchTerm}
            onChange={e => { setSearchTerm(e.target.value); setPage(1); }}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <button onClick={() => setShowFilters(!showFilters)} className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-1.5 ${showFilters ? 'border-primary text-primary bg-primary/5' : 'border-border text-muted hover:text-heading'}`}>
          <Filter className="h-4 w-4" /> Filters
        </button>

        <div className="flex items-center gap-1">
          <select
            onChange={e => {
              if (e.target.value === '__save__') {
                const name = prompt('Enter a name for this saved view:');
                if (name) {
                  const filters: Record<string, string> = {};
                  if (filterStatus) filters.status = filterStatus;
                  if (filterPriority) filters.priority = filterPriority;
                  if (filterAssignee) filters.assignee = filterAssignee;
                  if (filterCategory) filters.category_id = filterCategory;
                  if (filterQueue) filters.queue = filterQueue;
                  if (filterDepartment) filters.department = filterDepartment;
                  if (filterSlaRisk) filters.sla_risk = filterSlaRisk;
                  api.post<{ view: SavedView }>('/ticket-saved-views', { name, filters })
                    .then(d => setSavedViews(prev => [...prev, d.view]))
                    .catch(() => {});
                }
                e.target.value = '';
                return;
              }
              if (e.target.value.startsWith('__delete__:')) {
                const viewId = e.target.value.replace('__delete__:', '');
                const viewName = savedViews.find(v => v.id === viewId)?.name;
                if (confirm(`Delete saved view "${viewName}"?`)) {
                  api.delete(`/ticket-saved-views/${viewId}`)
                    .then(() => setSavedViews(prev => prev.filter(v => v.id !== viewId)))
                    .catch(() => {});
                }
                e.target.value = '';
                return;
              }
              const v = savedViews.find(sv => sv.id === e.target.value);
              if (v) applySavedView(v);
              e.target.value = '';
            }}
            className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm"
            defaultValue=""
          >
            <option value="">Saved Views</option>
            {savedViews.map(v => (
              <optgroup key={v.id} label={v.name}>
                <option value={v.id}>Apply: {v.name}</option>
                {!isReadOnly && <option value={`__delete__:${v.id}`}>Delete: {v.name}</option>}
              </optgroup>
            ))}
            {!isReadOnly && <option value="__save__">+ Save Current View</option>}
          </select>
        </div>
      </div>

      {showFilters && (
        <div className="flex flex-wrap gap-2 p-3 bg-surface-secondary rounded-lg">
          <select value={filterPriority} onChange={e => { setFilterPriority(e.target.value); setPage(1); }} className="px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-xs">
            <option value="">All Priorities</option>
            {['low', 'medium', 'high', 'urgent'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
          </select>
          <select value={filterAssignee} onChange={e => { setFilterAssignee(e.target.value); setPage(1); }} className="px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-xs">
            <option value="">All Assignees</option>
            {teamMembers.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}
          </select>
          <select value={filterCategory} onChange={e => { setFilterCategory(e.target.value); setPage(1); }} className="px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-xs">
            <option value="">All Categories</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input value={filterDepartment} onChange={e => { setFilterDepartment(e.target.value); setPage(1); }} placeholder="Department" className="px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-xs w-28" />
          <select value={filterSlaRisk} onChange={e => { setFilterSlaRisk(e.target.value); setPage(1); }} className="px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-xs">
            <option value="">SLA Status</option>
            <option value="at_risk">At Risk</option>
          </select>
          <button onClick={() => { setFilterPriority(''); setFilterAssignee(''); setFilterCategory(''); setFilterStatus(''); setFilterQueue(''); setFilterDepartment(''); setFilterSlaRisk(''); setSearchTerm(''); setPage(1); }} className="px-2 py-1.5 text-xs text-muted hover:text-heading">
            Clear All
          </button>
        </div>
      )}

      {selectedTickets.size > 0 && !isReadOnly && (
        <div className="flex items-center gap-3 p-2 bg-primary/5 border border-primary/20 rounded-lg">
          <span className="text-sm text-heading font-medium">{selectedTickets.size} selected</span>
          <div className="relative">
            <button onClick={() => setShowBulkMenu(!showBulkMenu)} className="px-3 py-1 text-xs bg-primary text-white rounded-lg flex items-center gap-1">
              Bulk Actions <ChevronDown className="h-3 w-3" />
            </button>
            {showBulkMenu && (
              <div className="absolute left-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-lg z-20 w-56 max-h-80 overflow-y-auto">
                <div className="px-3 py-1 text-[10px] font-semibold text-muted uppercase border-b border-border">Status</div>
                <button onClick={() => bulkAction({ status: 'open' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary">Set Open</button>
                <button onClick={() => bulkAction({ status: 'in_progress' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary">Set In Progress</button>
                <button onClick={() => bulkAction({ status: 'pending' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary">Set Pending</button>
                <button onClick={() => bulkAction({ status: 'escalated' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary">Escalate</button>
                <button onClick={() => bulkAction({ status: 'resolved' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary">Resolve</button>
                <button onClick={() => bulkAction({ status: 'closed' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary">Close</button>
                <div className="px-3 py-1 text-[10px] font-semibold text-muted uppercase border-b border-t border-border">Priority</div>
                <button onClick={() => bulkAction({ priority: 'low' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary">Set Low</button>
                <button onClick={() => bulkAction({ priority: 'medium' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary">Set Medium</button>
                <button onClick={() => bulkAction({ priority: 'high' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary">Set High Priority</button>
                <button onClick={() => bulkAction({ priority: 'urgent' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary">Set Urgent</button>
                <div className="px-3 py-1 text-[10px] font-semibold text-muted uppercase border-b border-t border-border">Assignment</div>
                {teamMembers.map(m => (
                  <button key={m.id} onClick={() => bulkAction({ assignee_user_id: m.id })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary truncate">
                    Assign: {m.email}
                  </button>
                ))}
                <button onClick={() => bulkAction({ assignee_user_id: '' })} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-secondary text-muted">Unassign</button>
              </div>
            )}
          </div>
          <button onClick={() => setSelectedTickets(new Set())} className="text-xs text-muted hover:text-heading">Clear</button>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {!isReadOnly && (
                  <th className="w-10 px-3 py-3">
                    <input type="checkbox" checked={selectedTickets.size === tickets.length && tickets.length > 0} onChange={toggleSelectAll} className="rounded border-border" />
                  </th>
                )}
                <th className="text-left px-4 py-3 text-xs font-medium text-muted cursor-pointer" onClick={() => toggleSort('subject')}>
                  <span className="flex items-center gap-1">Subject {sortBy === 'subject' && <ArrowUpDown className="h-3 w-3" />}</span>
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted cursor-pointer" onClick={() => toggleSort('priority')}>
                  <span className="flex items-center gap-1">Priority {sortBy === 'priority' && <ArrowUpDown className="h-3 w-3" />}</span>
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Assignee</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Category</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">SLA</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted cursor-pointer" onClick={() => toggleSort('created_at')}>
                  <span className="flex items-center gap-1">Created {sortBy === 'created_at' && <ArrowUpDown className="h-3 w-3" />}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tickets.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted">No tickets found</td>
                </tr>
              ) : (
                tickets.map(ticket => {
                  const cfg = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;
                  const slaInd = getSlaIndicator(ticket);
                  return (
                    <tr
                      key={ticket.id}
                      className={`border-b border-border hover:bg-surface-secondary/50 cursor-pointer ${selectedTickets.has(ticket.id) ? 'bg-primary/5' : ''}`}
                      onClick={() => navigate(`/tickets/${ticket.id}`)}
                    >
                      {!isReadOnly && (
                        <td className="w-10 px-3 py-3" onClick={e => { e.stopPropagation(); toggleSelect(ticket.id); }}>
                          <input type="checkbox" checked={selectedTickets.has(ticket.id)} onChange={() => {}} className="rounded border-border" />
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted">#{ticket.ticket_number}</span>
                          <div className="text-sm font-medium text-heading truncate max-w-xs">{ticket.subject}</div>
                        </div>
                        {ticket.description && <div className="text-[11px] text-muted mt-0.5 truncate max-w-xs">{ticket.description}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${cfg.color}`}>
                          {cfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium capitalize ${PRIORITY_COLORS[ticket.priority]}`}>
                          {ticket.priority}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-muted">{ticket.assignee_email || 'Unassigned'}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-muted">{ticket.category_name || '-'}</span>
                      </td>
                      <td className="px-4 py-3">
                        {slaInd || <span className="text-xs text-muted">-</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-muted">{new Date(ticket.created_at).toLocaleDateString()}</span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-muted">{total} tickets</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="p-1 rounded hover:bg-surface-secondary disabled:opacity-30">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-xs text-muted">Page {page} of {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="p-1 rounded hover:bg-surface-secondary disabled:opacity-30">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface border border-border rounded-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="font-semibold text-heading">New Ticket</h3>
              <button onClick={() => setShowForm(false)} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Subject *</label>
                <input type="text" value={formData.subject} onChange={e => setFormData(p => ({ ...p, subject: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Description</label>
                <textarea value={formData.description} onChange={e => setFormData(p => ({ ...p, description: e.target.value }))} rows={3} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Priority</label>
                  <select value={formData.priority} onChange={e => setFormData(p => ({ ...p, priority: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Category</label>
                  <select value={formData.category_id} onChange={e => setFormData(p => ({ ...p, category_id: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="">None</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Assignee</label>
                  <select value={formData.assignee_user_id} onChange={e => setFormData(p => ({ ...p, assignee_user_id: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="">Unassigned</option>
                    {teamMembers.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Department</label>
                  <input type="text" value={formData.department} onChange={e => setFormData(p => ({ ...p, department: e.target.value }))} placeholder="e.g., Engineering" className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Contact Name</label>
                  <input type="text" value={formData.contact_name} onChange={e => setFormData(p => ({ ...p, contact_name: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Contact Email</label>
                  <input type="email" value={formData.contact_email} onChange={e => setFormData(p => ({ ...p, contact_email: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Contact Phone</label>
                  <input type="tel" value={formData.contact_phone} onChange={e => setFormData(p => ({ ...p, contact_phone: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Source</label>
                <select value={formData.source} onChange={e => setFormData(p => ({ ...p, source: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                  <option value="manual">Manual</option>
                  <option value="api">API</option>
                  <option value="ai_agent">AI Agent</option>
                  <option value="email">Email</option>
                  <option value="phone">Phone</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Notes</label>
                <textarea value={formData.notes} onChange={e => setFormData(p => ({ ...p, notes: e.target.value }))} rows={2} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-heading bg-surface-secondary">Cancel</button>
              <button onClick={saveTicket} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90">Create Ticket</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
