import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { TICKET_TEMPLATE_TOKENS } from '../../../shared/tickets/templateTokens';
import {
  ArrowLeft, Clock, AlertCircle, CheckCircle2, User, Send, Eye, EyeOff,
  Link2, Paperclip, Tag, Calendar, ChevronDown, Zap, MessageSquare,
  AlertTriangle, Shield, MoreHorizontal, Users, History,
} from 'lucide-react';

interface TicketData {
  id: string;
  ticket_number: number;
  subject: string;
  description: string;
  status: string;
  priority: string;
  assignee_user_id: string | null;
  assignee_email: string | null;
  category_id: string | null;
  category_name: string | null;
  department: string;
  tags: string[];
  source: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  notes: string;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  reopened_count: number;
  created_by_user_id: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

interface Activity {
  id: string;
  activity_type: string;
  content: string;
  old_value: string;
  new_value: string;
  field_name: string;
  is_internal: boolean;
  user_email: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface Watcher {
  id: string;
  user_id: string;
  email: string;
}

interface SlaInstance {
  id: string;
  policy_name: string;
  response_due_at: string | null;
  resolution_due_at: string | null;
  response_met: boolean | null;
  resolution_met: boolean | null;
  paused_at: string | null;
}

interface LinkedTicket {
  id: string;
  source_ticket_id: string;
  target_ticket_id: string;
  link_type: string;
  source_subject: string;
  target_subject: string;
}

interface TeamMember {
  id: string;
  email: string;
}

interface Category {
  id: string;
  name: string;
}

interface Macro {
  id: string;
  name: string;
  description: string;
}

interface Template {
  id: string;
  name: string;
  body: string;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bgColor: string }> = {
  open: { label: 'Open', color: 'text-info dark:text-info', bgColor: 'bg-info-light dark:bg-info' },
  in_progress: { label: 'In Progress', color: 'text-warning dark:text-warning', bgColor: 'bg-warning-light dark:bg-warning' },
  pending: { label: 'Pending', color: 'text-purple-700 dark:text-purple-300', bgColor: 'bg-purple-100 dark:bg-purple-900/30' },
  escalated: { label: 'Escalated', color: 'text-danger dark:text-danger', bgColor: 'bg-danger-light dark:bg-danger' },
  resolved: { label: 'Resolved', color: 'text-success dark:text-success', bgColor: 'bg-success-light dark:bg-success' },
  closed: { label: 'Closed', color: 'text-text-primary', bgColor: 'bg-surface-hover/30' },
  reopened: { label: 'Reopened', color: 'text-warning dark:text-warning', bgColor: 'bg-warning-light dark:bg-warning' },
};

const PRIORITY_COLORS: Record<string, string> = {
  low: 'text-text-secondary',
  medium: 'text-info dark:text-info',
  high: 'text-warning dark:text-warning',
  urgent: 'text-danger dark:text-danger',
};

function timeAgo(date: string) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

function SlaTimer({ sla }: { sla: SlaInstance }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  const responseDue = sla.response_due_at ? new Date(sla.response_due_at).getTime() : null;
  const resolutionDue = sla.resolution_due_at ? new Date(sla.resolution_due_at).getTime() : null;

  const isPaused = !!sla.paused_at;
  const responseRemaining = responseDue ? Math.floor((responseDue - now) / 60000) : null;
  const resolutionRemaining = resolutionDue ? Math.floor((resolutionDue - now) / 60000) : null;

  const responseBreached = !isPaused && (sla.response_met === false || (responseRemaining !== null && responseRemaining < 0 && sla.response_met === null));
  const resolutionBreached = !isPaused && (sla.resolution_met === false || (resolutionRemaining !== null && resolutionRemaining < 0 && sla.resolution_met === null));
  const responseAtRisk = !isPaused && !responseBreached && responseRemaining !== null && responseRemaining < 120 && sla.response_met === null;
  const resolutionAtRisk = !isPaused && !resolutionBreached && resolutionRemaining !== null && resolutionRemaining < 120 && sla.resolution_met === null;

  return (
    <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Shield className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium text-heading">SLA: {sla.policy_name || 'Default'}</span>
        {sla.paused_at && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">Paused</span>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className={`p-2 rounded-lg ${isPaused ? 'bg-purple-50 dark:bg-purple-900/20' : responseBreached ? 'bg-danger-light dark:bg-danger' : responseAtRisk ? 'bg-warning-light dark:bg-warning' : 'bg-success-light dark:bg-success'}`}>
          <div className="text-[10px] text-text-muted mb-0.5">First Response</div>
          {sla.response_met === true ? (
            <div className="flex items-center gap-1 text-success dark:text-success text-xs font-medium"><CheckCircle2 className="h-3 w-3" /> Met</div>
          ) : isPaused ? (
            <div className="flex items-center gap-1 text-purple-600 dark:text-purple-400 text-xs font-medium">Paused</div>
          ) : responseBreached ? (
            <div className="flex items-center gap-1 text-danger dark:text-danger text-xs font-medium"><AlertTriangle className="h-3 w-3" /> Breached</div>
          ) : responseRemaining !== null ? (
            <div className={`text-xs font-medium ${responseAtRisk ? 'text-warning dark:text-warning' : 'text-success dark:text-success'}`}>{formatDuration(Math.abs(responseRemaining))} left</div>
          ) : (
            <div className="text-xs text-text-muted">N/A</div>
          )}
        </div>

        <div className={`p-2 rounded-lg ${isPaused ? 'bg-purple-50 dark:bg-purple-900/20' : resolutionBreached ? 'bg-danger-light dark:bg-danger' : resolutionAtRisk ? 'bg-warning-light dark:bg-warning' : 'bg-success-light dark:bg-success'}`}>
          <div className="text-[10px] text-text-muted mb-0.5">Resolution</div>
          {sla.resolution_met === true ? (
            <div className="flex items-center gap-1 text-success dark:text-success text-xs font-medium"><CheckCircle2 className="h-3 w-3" /> Met</div>
          ) : isPaused ? (
            <div className="flex items-center gap-1 text-purple-600 dark:text-purple-400 text-xs font-medium">Paused</div>
          ) : resolutionBreached ? (
            <div className="flex items-center gap-1 text-danger dark:text-danger text-xs font-medium"><AlertTriangle className="h-3 w-3" /> Breached</div>
          ) : resolutionRemaining !== null ? (
            <div className={`text-xs font-medium ${resolutionAtRisk ? 'text-warning dark:text-warning' : 'text-success dark:text-success'}`}>{formatDuration(Math.abs(resolutionRemaining))} left</div>
          ) : (
            <div className="text-xs text-text-muted">N/A</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityItem({ activity }: { activity: Activity }) {
  const iconMap: Record<string, typeof Clock> = {
    created: CheckCircle2,
    status_change: AlertCircle,
    priority_change: AlertTriangle,
    assigned: User,
    unassigned: User,
    note: MessageSquare,
    internal_note: EyeOff,
    field_change: Tag,
    escalated: AlertTriangle,
    reopened: AlertCircle,
    sla_breach: Shield,
    sla_warning: Shield,
    watcher_added: Eye,
    watcher_removed: EyeOff,
    linked: Link2,
    unlinked: Link2,
    category_change: Tag,
    department_change: Tag,
    macro_applied: Zap,
    auto_closed: Clock,
    template_response: MessageSquare,
  };

  const Icon = iconMap[activity.activity_type] || History;
  const isNote = activity.activity_type === 'note' || activity.activity_type === 'internal_note';

  return (
    <div className={`flex gap-3 py-3 ${activity.is_internal ? 'bg-warning-light dark:bg-warning -mx-2 px-2 rounded-lg' : ''}`}>
      <div className="flex-shrink-0 mt-0.5">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center ${isNote ? 'bg-info-light dark:bg-info' : 'bg-surface-hover'}`}>
          <Icon className={`h-3.5 w-3.5 ${isNote ? 'text-info dark:text-info' : 'text-text-muted'}`} />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium text-heading">{activity.user_email || 'System'}</span>
          {activity.is_internal && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning-light dark:bg-warning text-warning dark:text-warning">Internal</span>
          )}
          <span className="text-[10px] text-text-muted">{timeAgo(activity.created_at)}</span>
        </div>

        {isNote ? (
          <div className="text-sm text-body whitespace-pre-wrap">{activity.content}</div>
        ) : activity.activity_type === 'status_change' ? (
          <div className="text-xs text-text-muted">
            Changed status from <span className="font-medium">{activity.old_value}</span> to <span className="font-medium">{activity.new_value}</span>
          </div>
        ) : activity.activity_type === 'priority_change' ? (
          <div className="text-xs text-text-muted">
            Changed priority from <span className="font-medium">{activity.old_value}</span> to <span className="font-medium">{activity.new_value}</span>
          </div>
        ) : activity.activity_type === 'assigned' ? (
          <div className="text-xs text-text-muted">Assigned ticket</div>
        ) : activity.activity_type === 'macro_applied' ? (
          <div className="text-xs text-text-muted">{activity.content}</div>
        ) : (
          <div className="text-xs text-text-muted">{activity.content || `${activity.activity_type.replace(/_/g, ' ')}`}</div>
        )}
      </div>
    </div>
  );
}

export default function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isReadOnly = !['tenant_owner', 'operations_manager'].includes(user?.role ?? '');

  const [ticket, setTicket] = useState<TicketData | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [sla, setSla] = useState<SlaInstance | null>(null);
  const [linkedTickets, setLinkedTickets] = useState<LinkedTicket[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'activity' | 'details' | 'linked' | 'attachments' | 'audit'>('activity');
  const [attachments, setAttachments] = useState<Array<{ id: string; file_name: string; file_url: string; file_size: number; file_type: string; created_at: string; uploaded_by_email?: string }>>([]);
  const [noteContent, setNoteContent] = useState('');
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [showMacroMenu, setShowMacroMenu] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<TicketData>>({});
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const fetchTicket = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<{ ticket: TicketData; watchers: Watcher[]; sla: SlaInstance | null; linkedTickets: LinkedTicket[]; attachments: Array<{ id: string; file_name: string; file_url: string; file_size: number; file_type: string; created_at: string }> }>(`/tickets/${id}`);
      setTicket(data.ticket);
      setWatchers(data.watchers);
      setSla(data.sla);
      setLinkedTickets(data.linkedTickets);
      setAttachments(data.attachments || []);
    } catch {
      setError('Failed to load ticket');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchActivities = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<{ activities: Activity[] }>(`/tickets/${id}/activity`);
      setActivities(data.activities);
    } catch {}
  }, [id]);

  useEffect(() => { fetchTicket(); fetchActivities(); }, [fetchTicket, fetchActivities]);

  useEffect(() => {
    Promise.all([
      api.get<{ users: TeamMember[] }>('/users?limit=100').then(d => setTeamMembers(d.users)),
      api.get<{ categories: Category[] }>('/ticket-categories').then(d => setCategories(d.categories)),
      api.get<{ macros: Macro[] }>('/ticket-macros').then(d => setMacros(d.macros)),
      api.get<{ templates: Template[] }>('/ticket-templates').then(d => setTemplates(d.templates)),
    ]).catch(() => {});
  }, []);

  const addNote = async () => {
    if (!noteContent.trim() || !id) return;
    try {
      await api.post(`/tickets/${id}/notes`, { content: noteContent, is_internal: isInternalNote });
      setNoteContent('');
      fetchActivities();
      fetchTicket();
    } catch {
      setError('Failed to add note');
    }
  };

  const updateField = async (field: string, value: unknown) => {
    if (!id) return;
    try {
      await api.put(`/tickets/${id}`, { [field]: value });
      fetchTicket();
      fetchActivities();
    } catch {
      setError('Failed to update ticket');
    }
  };

  const applyMacro = async (macroId: string) => {
    if (!id) return;
    try {
      await api.post(`/tickets/${id}/macro`, { macro_id: macroId });
      fetchTicket();
      fetchActivities();
      setShowMacroMenu(false);
    } catch {
      setError('Failed to apply macro');
    }
  };

  const insertTemplate = (template: Template) => {
    let body = template.body;
    if (ticket) {
      // The substitution map is keyed off TICKET_TEMPLATE_TOKENS so
      // this loop and the editor's "supported tokens" list can never
      // drift. Adding a token requires touching
      // `shared/tickets/templateTokens.ts`, which automatically
      // updates the editor warnings, the help text, and the
      // server-side reject — see task #806.
      const tokenValues: Record<typeof TICKET_TEMPLATE_TOKENS[number], string> = {
        ticket_number: `#${ticket.ticket_number}`,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        contact_name: ticket.contact_name || '',
        contact_email: ticket.contact_email || '',
        contact_phone: ticket.contact_phone || '',
        department: ticket.department || '',
        assignee: ticket.assignee_email || 'Unassigned',
        created_at: new Date(ticket.created_at).toLocaleDateString(),
      };
      for (const token of TICKET_TEMPLATE_TOKENS) {
        body = body.replace(new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, 'g'), tokenValues[token]);
      }
    }
    setNoteContent(body);
    setShowTemplateMenu(false);
    noteRef.current?.focus();
  };

  const addWatcher = async (userId: string) => {
    if (!id) return;
    try {
      await api.post(`/tickets/${id}/watchers`, { user_id: userId });
      fetchTicket();
      fetchActivities();
    } catch {
      setError('Failed to add watcher');
    }
  };

  const removeWatcher = async (userId: string) => {
    if (!id) return;
    try {
      await api.delete(`/tickets/${id}/watchers/${userId}`);
      fetchTicket();
      fetchActivities();
    } catch {
      setError('Failed to remove watcher');
    }
  };

  const saveEdit = async () => {
    if (!id) return;
    try {
      await api.put(`/tickets/${id}`, editForm);
      setEditing(false);
      fetchTicket();
      fetchActivities();
    } catch {
      setError('Failed to update ticket');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="text-center py-12">
        <p className="text-text-muted">Ticket not found</p>
        <button onClick={() => navigate('/tickets')} className="mt-2 text-primary text-sm hover:underline">Back to Tickets</button>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;

  return (
    <div className="space-y-4" data-testid="ticket-detail-loaded">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/tickets')} className="p-1.5 rounded-lg hover:bg-surface-secondary">
          <ArrowLeft className="h-5 w-5 text-text-muted" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">#{ticket.ticket_number}</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${statusCfg.bgColor} ${statusCfg.color}`}>
              {statusCfg.label}
            </span>
            <span className={`text-xs font-medium capitalize ${PRIORITY_COLORS[ticket.priority]}`}>{ticket.priority}</span>
            {ticket.source !== 'manual' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-text-muted">{ticket.source}</span>
            )}
          </div>
          {editing ? (
            <input
              type="text"
              value={editForm.subject ?? ticket.subject}
              onChange={e => setEditForm(p => ({ ...p, subject: e.target.value }))}
              className="text-lg font-bold text-heading w-full border-b border-primary bg-transparent focus:outline-none mt-1"
            />
          ) : (
            <h1 className="text-lg font-bold text-heading truncate mt-1 cursor-pointer" onClick={() => { if (!isReadOnly) { setEditing(true); setEditForm({ subject: ticket.subject, description: ticket.description }); } }}>
              {ticket.subject}
            </h1>
          )}
        </div>

        {!isReadOnly && (
          <div className="flex items-center gap-2">
            {editing ? (
              <>
                <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-sm text-text-muted hover:text-heading">Cancel</button>
                <button onClick={saveEdit} className="px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary/90">Save</button>
              </>
            ) : (
              <>
                <div className="relative">
                  <button onClick={() => setShowMacroMenu(!showMacroMenu)} className="p-2 rounded-lg hover:bg-surface-secondary text-text-muted" title="Quick Actions">
                    <Zap className="h-4 w-4" />
                  </button>
                  {showMacroMenu && macros.length > 0 && (
                    <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-lg z-popover w-56">
                      {macros.map(m => (
                        <button key={m.id} onClick={() => applyMacro(m.id)} className="w-full text-left px-3 py-2 text-sm text-heading hover:bg-surface-secondary first:rounded-t-lg last:rounded-b-lg">
                          <div className="font-medium">{m.name}</div>
                          {m.description && <div className="text-xs text-text-muted">{m.description}</div>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button onClick={() => { setEditing(true); setEditForm({ subject: ticket.subject, description: ticket.description }); }} className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-surface-secondary text-heading">
                  Edit
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="bg-danger-light dark:bg-danger border border-danger dark:border-danger rounded-lg p-3 text-sm text-danger dark:text-danger">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-surface border border-border rounded-xl p-4">
            {editing ? (
              <textarea
                value={editForm.description ?? ticket.description}
                onChange={e => setEditForm(p => ({ ...p, description: e.target.value }))}
                rows={4}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            ) : (
              <div className="text-sm text-body whitespace-pre-wrap">{ticket.description || 'No description provided.'}</div>
            )}
          </div>

          <div className="bg-surface border border-border rounded-xl">
            <div className="flex border-b border-border">
              {(['activity', 'details', 'linked', 'attachments', 'audit'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2.5 text-sm font-medium capitalize ${activeTab === tab ? 'text-primary border-b-2 border-primary' : 'text-text-muted hover:text-heading'}`}
                >
                  {tab === 'linked' ? `Linked (${linkedTickets.length})` : tab === 'attachments' ? `Files (${attachments.length})` : tab === 'audit' ? 'Audit History' : tab}
                </button>
              ))}
            </div>

            <div className="p-4">
              {activeTab === 'activity' && (
                <div className="space-y-1">
                  {activities.length === 0 ? (
                    <p className="text-sm text-text-muted py-4 text-center">No activity yet</p>
                  ) : (
                    activities.map(a => <ActivityItem key={a.id} activity={a} />)
                  )}
                </div>
              )}

              {activeTab === 'details' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div><span className="text-text-muted text-xs">Created</span><div className="text-heading">{new Date(ticket.created_at).toLocaleString()}</div></div>
                    <div><span className="text-text-muted text-xs">Updated</span><div className="text-heading">{new Date(ticket.updated_at).toLocaleString()}</div></div>
                    <div><span className="text-text-muted text-xs">First Response</span><div className="text-heading">{ticket.first_response_at ? new Date(ticket.first_response_at).toLocaleString() : 'Pending'}</div></div>
                    <div><span className="text-text-muted text-xs">Resolved</span><div className="text-heading">{ticket.resolved_at ? new Date(ticket.resolved_at).toLocaleString() : 'Not yet'}</div></div>
                    <div><span className="text-text-muted text-xs">Reopened</span><div className="text-heading">{ticket.reopened_count} times</div></div>
                    <div><span className="text-text-muted text-xs">Source</span><div className="text-heading capitalize">{ticket.source}</div></div>
                    {ticket.contact_name && <div><span className="text-text-muted text-xs">Contact Name</span><div className="text-heading">{ticket.contact_name}</div></div>}
                    {ticket.contact_email && <div><span className="text-text-muted text-xs">Contact Email</span><div className="text-heading">{ticket.contact_email}</div></div>}
                    {ticket.contact_phone && <div><span className="text-text-muted text-xs">Contact Phone</span><div className="text-heading">{ticket.contact_phone}</div></div>}
                    {ticket.created_by_email && <div><span className="text-text-muted text-xs">Created By</span><div className="text-heading">{ticket.created_by_email}</div></div>}
                  </div>
                  {ticket.notes && (
                    <div>
                      <span className="text-text-muted text-xs">Notes</span>
                      <div className="text-sm text-body mt-1 whitespace-pre-wrap">{ticket.notes}</div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'linked' && (
                <div className="space-y-2">
                  {linkedTickets.length === 0 && (
                    <p className="text-sm text-text-muted py-4 text-center">No linked tickets</p>
                  )}
                  {linkedTickets.map(lt => {
                    const isSource = lt.source_ticket_id === id;
                    const linkedSubject = isSource ? lt.target_subject : lt.source_subject;
                    const linkedId = isSource ? lt.target_ticket_id : lt.source_ticket_id;
                    return (
                      <div key={lt.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-secondary group">
                        <Link2 className="h-4 w-4 text-text-muted" />
                        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => navigate(`/tickets/${linkedId}`)}>
                          <div className="text-sm text-heading truncate">{linkedSubject}</div>
                          <div className="text-xs text-text-muted capitalize">{lt.link_type.replace(/_/g, ' ')}</div>
                        </div>
                        {!isReadOnly && (
                          <button
                            onClick={async () => {
                              try {
                                await api.delete(`/tickets/${id}/links/${lt.id}`);
                                setLinkedTickets(prev => prev.filter(l => l.id !== lt.id));
                              } catch {}
                            }}
                            className="text-xs text-danger dark:text-danger opacity-0 group-hover:opacity-100"
                          >Unlink</button>
                        )}
                      </div>
                    );
                  })}
                  {!isReadOnly && (
                    <form onSubmit={async (e) => {
                      e.preventDefault();
                      const form = e.target as HTMLFormElement;
                      const targetId = (form.elements.namedItem('targetTicketId') as HTMLInputElement).value;
                      const linkType = (form.elements.namedItem('linkType') as HTMLSelectElement).value;
                      if (!targetId) return;
                      try {
                        await api.post(`/tickets/${id}/links`, { target_ticket_id: targetId, link_type: linkType });
                        form.reset();
                        fetchTicket();
                      } catch {}
                    }} className="pt-2 border-t border-border space-y-2">
                      <div className="text-xs text-text-muted">Link another ticket:</div>
                      <div className="flex gap-2">
                        <input name="targetTicketId" placeholder="Ticket ID" className="flex-1 text-xs px-2 py-1.5 rounded border border-border bg-surface" />
                        <select name="linkType" className="text-xs px-2 py-1.5 rounded border border-border bg-surface">
                          <option value="related">Related</option>
                          <option value="blocks">Blocks</option>
                          <option value="blocked_by">Blocked By</option>
                          <option value="duplicate">Duplicate</option>
                          <option value="parent">Parent</option>
                          <option value="child">Child</option>
                        </select>
                        <button type="submit" className="text-xs px-3 py-1.5 rounded bg-primary text-white hover:bg-primary/90">Link</button>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {activeTab === 'attachments' && (
                <div className="space-y-3">
                  {attachments.length === 0 ? (
                    <p className="text-sm text-text-muted py-4 text-center">No attachments</p>
                  ) : (
                    attachments.map(att => (
                      <div key={att.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-secondary group">
                        <Paperclip className="h-4 w-4 text-text-muted" />
                        <div className="flex-1 min-w-0">
                          <a href={att.file_url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline truncate block">{att.file_name}</a>
                          <div className="text-xs text-text-muted">{att.file_type} &middot; {(att.file_size / 1024).toFixed(1)} KB &middot; {new Date(att.created_at).toLocaleDateString()}</div>
                        </div>
                        {!isReadOnly && (
                          <button
                            onClick={async () => {
                              try {
                                await api.delete(`/tickets/${id}/attachments/${att.id}`);
                                setAttachments(prev => prev.filter(a => a.id !== att.id));
                              } catch {}
                            }}
                            className="text-xs text-danger dark:text-danger opacity-0 group-hover:opacity-100"
                          >Remove</button>
                        )}
                      </div>
                    ))
                  )}
                  {!isReadOnly && (
                    <div className="pt-2 border-t border-border">
                      <div className="text-xs text-text-muted mb-2">Add attachment via URL:</div>
                      <form onSubmit={async (e) => {
                        e.preventDefault();
                        const form = e.target as HTMLFormElement;
                        const fileName = (form.elements.namedItem('fileName') as HTMLInputElement).value;
                        const fileUrl = (form.elements.namedItem('fileUrl') as HTMLInputElement).value;
                        if (!fileName || !fileUrl) return;
                        try {
                          const data = await api.post<{ attachment: typeof attachments[0] }>(`/tickets/${id}/attachments`, { file_name: fileName, file_url: fileUrl });
                          setAttachments(prev => [data.attachment, ...prev]);
                          form.reset();
                        } catch {}
                      }} className="flex gap-2">
                        <input name="fileName" placeholder="File name" className="flex-1 text-xs px-2 py-1.5 rounded border border-border bg-surface" />
                        <input name="fileUrl" placeholder="File URL" className="flex-1 text-xs px-2 py-1.5 rounded border border-border bg-surface" />
                        <button type="submit" className="text-xs px-3 py-1.5 rounded bg-primary text-white hover:bg-primary/90">Add</button>
                      </form>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'audit' && (
                <div className="space-y-1">
                  {activities.length === 0 ? (
                    <p className="text-sm text-text-muted py-4 text-center">No audit history</p>
                  ) : (
                    activities
                      .filter(a => ['status_change', 'priority_change', 'assigned', 'unassigned', 'field_change', 'created',
                        'escalated', 'reopened', 'sla_breached', 'sla_breach', 'watcher_added', 'watcher_removed',
                        'linked', 'unlinked', 'category_change', 'department_change', 'macro_applied',
                        'auto_closed', 'attachment_added', 'attachment_removed'].includes(a.activity_type))
                      .map(a => (
                        <div key={a.id} className="flex gap-3 py-2 border-b border-border/50 last:border-0">
                          <div className="flex-shrink-0 w-28 text-[10px] text-text-muted">{new Date(a.created_at).toLocaleString()}</div>
                          <div className="flex-1">
                            <span className="text-xs font-medium text-heading capitalize">{a.activity_type.replace(/_/g, ' ')}</span>
                            {a.field_name && <span className="text-xs text-text-muted ml-1">({a.field_name})</span>}
                            {a.old_value && <span className="text-xs text-danger dark:text-danger ml-1 line-through">{a.old_value}</span>}
                            {a.new_value && <span className="text-xs text-success dark:text-success ml-1">{a.new_value}</span>}
                            {a.content && !a.old_value && !a.new_value && <span className="text-xs text-text-muted ml-1">{a.content}</span>}
                          </div>
                          <div className="text-[10px] text-text-muted">{a.user_email || 'System'}</div>
                        </div>
                      ))
                  )}
                </div>
              )}
            </div>
          </div>

          {!isReadOnly && (
            <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-text-muted" />
                  <span className="text-sm font-medium text-heading">Add Note</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsInternalNote(!isInternalNote)}
                    className={`text-xs px-2 py-1 rounded ${isInternalNote ? 'bg-warning-light dark:bg-warning text-warning dark:text-warning' : 'bg-surface-hover text-text-muted'}`}
                  >
                    {isInternalNote ? 'Internal' : 'Public'}
                  </button>
                  <div className="relative">
                    <button onClick={() => setShowTemplateMenu(!showTemplateMenu)} className="text-xs px-2 py-1 rounded bg-surface-hover text-text-muted hover:text-heading">
                      Templates
                    </button>
                    {showTemplateMenu && templates.length > 0 && (
                      <div className="absolute right-0 bottom-full mb-1 bg-surface border border-border rounded-lg shadow-lg z-popover w-48">
                        {templates.map(t => (
                          <button key={t.id} onClick={() => insertTemplate(t)} className="w-full text-left px-3 py-2 text-sm text-heading hover:bg-surface-secondary first:rounded-t-lg last:rounded-b-lg">
                            {t.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <textarea
                ref={noteRef}
                value={noteContent}
                onChange={e => setNoteContent(e.target.value)}
                rows={3}
                placeholder="Type a note... Use @mention to notify team members"
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <div className="flex justify-end">
                <button onClick={addNote} disabled={!noteContent.trim()} className="px-4 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5">
                  <Send className="h-3.5 w-3.5" /> Send
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {sla && <SlaTimer sla={sla} />}

          <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
            <h3 className="text-sm font-medium text-heading">Properties</h3>

            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wider">Status</label>
                <select
                  value={ticket.status}
                  onChange={e => updateField('status', e.target.value)}
                  disabled={isReadOnly}
                  className="w-full mt-0.5 px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
                >
                  {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wider">Priority</label>
                <select
                  value={ticket.priority}
                  onChange={e => updateField('priority', e.target.value)}
                  disabled={isReadOnly}
                  className="w-full mt-0.5 px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
                >
                  {['low', 'medium', 'high', 'urgent'].map(p => (
                    <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wider">Assignee</label>
                <select
                  value={ticket.assignee_user_id || ''}
                  onChange={e => updateField('assignee_user_id', e.target.value || null)}
                  disabled={isReadOnly}
                  className="w-full mt-0.5 px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
                >
                  <option value="">Unassigned</option>
                  {teamMembers.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wider">Category</label>
                <select
                  value={ticket.category_id || ''}
                  onChange={e => updateField('category_id', e.target.value || null)}
                  disabled={isReadOnly}
                  className="w-full mt-0.5 px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
                >
                  <option value="">None</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wider">Department</label>
                <input
                  type="text"
                  value={ticket.department}
                  onChange={e => updateField('department', e.target.value)}
                  disabled={isReadOnly}
                  placeholder="e.g., Engineering"
                  className="w-full mt-0.5 px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-heading flex items-center gap-1.5"><Users className="h-4 w-4" /> Watchers ({watchers.length})</h3>
            </div>
            <div className="space-y-1.5">
              {watchers.map(w => (
                <div key={w.id} className="flex items-center justify-between text-xs">
                  <span className="text-heading">{w.email}</span>
                  {!isReadOnly && (
                    <button onClick={() => removeWatcher(w.user_id)} className="text-text-muted hover:text-danger dark:hover:text-danger">&times;</button>
                  )}
                </div>
              ))}
            </div>
            {!isReadOnly && (
              <select
                onChange={e => { if (e.target.value) { addWatcher(e.target.value); e.target.value = ''; } }}
                className="w-full px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-1 focus:ring-primary/30"
                defaultValue=""
              >
                <option value="">Add watcher...</option>
                {teamMembers
                  .filter(m => !watchers.some(w => w.user_id === m.id))
                  .map(m => <option key={m.id} value={m.id}>{m.email}</option>)}
              </select>
            )}
          </div>

          {ticket.tags && ticket.tags.length > 0 && (
            <div className="bg-surface border border-border rounded-xl p-4">
              <h3 className="text-sm font-medium text-heading mb-2 flex items-center gap-1.5"><Tag className="h-4 w-4" /> Tags</h3>
              <div className="flex flex-wrap gap-1.5">
                {ticket.tags.map((tag, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary">{tag}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
