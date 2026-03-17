import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Ticket, Plus, X, AlertCircle, Clock, CheckCircle2, ChevronLeft, ChevronRight, User, Search } from 'lucide-react';

interface TicketItem {
  id: string;
  call_id: string | null;
  subject: string;
  description: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee_user_id: string | null;
  assignee_email: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
}

interface TeamMember {
  id: string;
  email: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  open: { label: 'Open', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300', icon: AlertCircle },
  in_progress: { label: 'In Progress', color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300', icon: Clock },
  resolved: { label: 'Resolved', color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300', icon: CheckCircle2 },
  closed: { label: 'Closed', color: 'bg-gray-100 text-gray-800 dark:bg-gray-700/30 dark:text-gray-300', icon: CheckCircle2 },
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-gray-500',
  medium: 'text-blue-500',
  high: 'text-orange-500',
  urgent: 'text-red-500',
};

export default function Tickets() {
  const { user } = useAuth();
  const isReadOnly = !['tenant_owner', 'operations_manager'].includes(user?.role ?? '');
  const [tickets, setTickets] = useState<TicketItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filterStatus, setFilterStatus] = useState('');
  const [selectedTicket, setSelectedTicket] = useState<TicketItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const [formData, setFormData] = useState({
    subject: '', description: '', status: 'open', priority: 'medium',
    assignee_user_id: '', notes: '',
  });

  const fetchTickets = useCallback(async () => {
    try {
      let url = `/tickets?page=${page}&limit=20`;
      if (filterStatus) url += `&status=${filterStatus}`;
      const data = await api.get<{ tickets: TicketItem[]; total: number }>(url);
      setTickets(data.tickets);
      setTotal(data.total);
    } catch {
      setError('Failed to load tickets');
    } finally {
      setLoading(false);
    }
  }, [page, filterStatus]);

  useEffect(() => { fetchTickets(); }, [fetchTickets]);

  useEffect(() => {
    api.get<{ users: TeamMember[] }>('/users?limit=100')
      .then(data => setTeamMembers(data.users))
      .catch(() => {});
  }, []);

  const openForm = (ticket?: TicketItem) => {
    if (ticket) {
      setFormData({
        subject: ticket.subject,
        description: ticket.description,
        status: ticket.status,
        priority: ticket.priority,
        assignee_user_id: ticket.assignee_user_id || '',
        notes: ticket.notes,
      });
      setSelectedTicket(ticket);
    } else {
      setFormData({ subject: '', description: '', status: 'open', priority: 'medium', assignee_user_id: '', notes: '' });
      setSelectedTicket(null);
    }
    setShowForm(true);
  };

  const saveTicket = async () => {
    if (!formData.subject) return;
    try {
      const payload = { ...formData, assignee_user_id: formData.assignee_user_id || null };
      if (selectedTicket) {
        await api.put(`/tickets/${selectedTicket.id}`, payload);
      } else {
        await api.post('/tickets', payload);
      }
      setShowForm(false);
      fetchTickets();
    } catch {
      setError('Failed to save ticket');
    }
  };

  const updateStatus = async (id: string, status: string) => {
    try {
      await api.put(`/tickets/${id}`, { status });
      fetchTickets();
    } catch {
      setError('Failed to update status');
    }
  };

  const totalPages = Math.ceil(total / 20);
  const filteredTickets = searchTerm
    ? tickets.filter(t => t.subject.toLowerCase().includes(searchTerm.toLowerCase()))
    : tickets;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Ticket className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-heading">Tickets</h1>
            <p className="text-sm text-muted mt-0.5">Track and manage support tickets</p>
          </div>
        </div>
        {!isReadOnly && (
          <button onClick={() => openForm()} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
            <Plus className="h-4 w-4" /> New Ticket
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
          <input
            type="text"
            placeholder="Search tickets..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <select
          value={filterStatus}
          onChange={e => { setFilterStatus(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(['open', 'in_progress', 'resolved', 'closed'] as const).map(s => {
          const count = tickets.filter(t => t.status === s).length;
          const cfg = STATUS_CONFIG[s];
          return (
            <div key={s} className="bg-surface border border-border rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-heading">{count}</div>
              <div className={`text-xs font-medium mt-1 ${cfg.color.split(' ')[1]}`}>{cfg.label}</div>
            </div>
          );
        })}
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Subject</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Priority</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Assignee</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted">Created</th>
                {!isReadOnly && <th className="text-right px-4 py-3 text-xs font-medium text-muted">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filteredTickets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">No tickets found</td>
                </tr>
              ) : (
                filteredTickets.map(ticket => {
                  const cfg = STATUS_CONFIG[ticket.status];
                  return (
                    <tr key={ticket.id} className="border-b border-border hover:bg-surface-secondary/50 cursor-pointer" onClick={() => !isReadOnly && openForm(ticket)}>
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-heading">{ticket.subject}</div>
                        {ticket.description && <div className="text-xs text-muted mt-0.5 truncate max-w-xs">{ticket.description}</div>}
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
                        <span className="text-xs text-muted">{new Date(ticket.created_at).toLocaleDateString()}</span>
                      </td>
                      {!isReadOnly && (
                        <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                          {ticket.status === 'open' && (
                            <button onClick={() => updateStatus(ticket.id, 'in_progress')} className="text-xs text-primary hover:underline">Start</button>
                          )}
                          {ticket.status === 'in_progress' && (
                            <button onClick={() => updateStatus(ticket.id, 'resolved')} className="text-xs text-green-600 hover:underline">Resolve</button>
                          )}
                        </td>
                      )}
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
              <h3 className="font-semibold text-heading">{selectedTicket ? 'Edit Ticket' : 'New Ticket'}</h3>
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
                  <label className="block text-xs font-medium text-muted mb-1">Status</label>
                  <select value={formData.status} onChange={e => setFormData(p => ({ ...p, status: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="open">Open</option>
                    <option value="in_progress">In Progress</option>
                    <option value="resolved">Resolved</option>
                    <option value="closed">Closed</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Priority</label>
                  <select value={formData.priority} onChange={e => setFormData(p => ({ ...p, priority: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Assignee</label>
                <select value={formData.assignee_user_id} onChange={e => setFormData(p => ({ ...p, assignee_user_id: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                  <option value="">Unassigned</option>
                  {teamMembers.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Notes</label>
                <textarea value={formData.notes} onChange={e => setFormData(p => ({ ...p, notes: e.target.value }))} rows={3} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-heading bg-surface-secondary">Cancel</button>
              <button onClick={saveTicket} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
