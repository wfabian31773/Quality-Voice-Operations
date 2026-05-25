import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  SMS_CANNED_RESPONSE_TOKENS,
  findUnknownSmsCannedResponseTokens,
} from '../../../shared/sms/cannedResponseTokens';
import { countSmsSegments } from '../../../shared/sms/segments';
import {
  MessageSquare, Send, Sparkles, Phone, ArrowLeft, Inbox, Search,
  Pin, Flag, Clock, User, Users, Tag, X, Check, AlertTriangle,
  Archive, ChevronDown, StickyNote, BarChart3, Settings, Zap,
  FileText, Plus, Trash2, Edit, Filter, RefreshCw, Calendar,
  CheckCircle, XCircle, ArrowUpRight, Hash, Mail, MapPin, Bell,
} from 'lucide-react';
import { EmptyState, PageSkeleton, SkeletonRows } from '../components/state';
import { PageHeader, StatusBadge as SharedStatusBadge, type BadgeTone } from '../components/ui';

interface PhoneLine {
  phoneNumberId: string;
  phoneNumber: string;
  friendlyName: string;
}

interface Conversation {
  id: string;
  tenantId: string;
  phoneNumberId: string;
  remoteNumber: string;
  status: string;
  assigneeUserId: string | null;
  assigneeTeam: string | null;
  priority: string;
  pinned: boolean;
  unreadCount: number;
  followUp: boolean;
  followUpAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactLocation: string | null;
  tags: string[];
  createdAt: string;
}

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  fromNumber: string;
  toNumber: string;
  body: string;
  status: string;
  twilioSid: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface InternalNote {
  id: string;
  userId: string;
  userName: string | null;
  body: string;
  createdAt: string;
}

interface CannedResponse {
  id: string;
  title: string;
  body: string;
  category: string | null;
  variables: string[];
  shortcut: string | null;
}

interface ActivityEntry {
  id: string;
  action: string;
  actorName: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

interface InboxCounts {
  open: number;
  pending: number;
  closed: number;
  escalated: number;
  archived: number;
  unread: number;
  deferred: number;
}

interface DeferredEntry {
  conversationId: string;
  messageId: string;
  deferredUntil: string | null;
  recipientTimezone: string | null;
  scheduledAt: string | null;
}

interface Analytics {
  conversationVolume: { total: number; open: number; pending: number; closed: number; escalated: number };
  messageStats: { totalSent: number; totalReceived: number; delivered: number; failed: number };
  avgResponseTimeMinutes: number | null;
  avgResolutionTimeMinutes: number | null;
  optOutRate: number | null;
  agentProductivity: Array<{ userId: string; sent: number; conversations: number }>;
}

type TabView = 'inbox' | 'templates' | 'automations' | 'analytics' | 'admin';
type InboxFilter = 'all' | 'open' | 'pending' | 'closed' | 'escalated' | 'archived' | 'unread' | 'pinned' | 'followUp' | 'deferred';

const STATUS_TOOLTIPS: Record<string, string> = {
  open: 'Open conversation — currently being handled by your team',
  pending: 'Pending — waiting on a customer reply or an internal action',
  closed: 'Closed — no further action needed unless the customer writes back',
  escalated: 'Escalated — flagged for urgent attention or supervisor review',
  archived: 'Archived — hidden from the main inbox view',
};

const STATUS_META: Record<string, { tone: BadgeTone; icon: typeof Inbox }> = {
  open: { tone: 'info', icon: Inbox },
  pending: { tone: 'warning', icon: Clock },
  closed: { tone: 'neutral', icon: CheckCircle },
  escalated: { tone: 'danger', icon: AlertTriangle },
  archived: { tone: 'neutral', icon: Archive },
};

function ConversationStatusBadge({ status, sizeClass = 'text-[10px]' }: { status: string; sizeClass?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.open;
  const tooltip = STATUS_TOOLTIPS[status] || `Conversation status: ${status}`;
  const Icon = meta.icon;
  return (
    <SharedStatusBadge
      tone={meta.tone}
      icon={<Icon className="h-3 w-3" aria-hidden="true" />}
      tooltip={tooltip}
      className={sizeClass}
    >
      {status}
    </SharedStatusBadge>
  );
}

const PRIORITY_ICONS: Record<string, { icon: typeof Flag; color: string }> = {
  urgent: { icon: AlertTriangle, color: 'text-red-500 dark:text-red-400' },
  high: { icon: Flag, color: 'text-orange-500 dark:text-orange-400' },
  normal: { icon: Flag, color: 'text-text-muted' },
};

export default function SmsInbox() {
  const { user } = useAuth();
  const isManager = ['tenant_owner', 'operations_manager'].includes(user?.role ?? '');

  const [activeTab, setActiveTab] = useState<TabView>('inbox');
  const [phoneLines, setPhoneLines] = useState<PhoneLine[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<InternalNote[]>([]);
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>([]);
  const [inboxCounts, setInboxCounts] = useState<InboxCounts>({ open: 0, pending: 0, closed: 0, escalated: 0, archived: 0, unread: 0, deferred: 0 });
  const [deferredEntries, setDeferredEntries] = useState<DeferredEntry[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  const [replyText, setReplyText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<InboxFilter>('all');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContactPanel, setShowContactPanel] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<string>('');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (activeFilter === 'unread') params.set('unread', 'true');
      else if (activeFilter === 'pinned') params.set('pinned', 'true');
      else if (activeFilter === 'followUp') params.set('followUp', 'true');
      else if (activeFilter === 'deferred') params.set('deferred', 'true');
      else if (activeFilter !== 'all') params.set('status', activeFilter);
      if (searchQuery) params.set('search', searchQuery);

      const data = await api.get<{ conversations: Conversation[]; total: number }>(`/sms-inbox/threads?${params}`);
      setConversations(data.conversations);
    } catch {
      setError('Failed to load conversations');
    }
  }, [activeFilter, searchQuery]);

  // Refresh the deferred queue alongside the inbox counts so the
  // sidebar badge counter and the per-row "deferred until …" pill
  // never drift from each other when the dispatcher parks (or
  // releases) messages between polls.
  const refreshDeferred = useCallback(async () => {
    try {
      const [counts, deferred] = await Promise.all([
        api.get<{ counts: InboxCounts }>('/sms-inbox/counts'),
        api.get<{ deferred: DeferredEntry[] }>('/sms-inbox/deferred'),
      ]);
      setInboxCounts(counts.counts);
      setDeferredEntries(deferred.deferred);
    } catch {
      // Non-fatal: leave previous values in place so the UI degrades
      // to "no badges" instead of throwing the whole inbox away.
    }
  }, []);

  useEffect(() => {
    Promise.all([
      api.get<{ conversations: PhoneLine[] }>('/sms-inbox/conversations'),
      api.get<{ counts: InboxCounts }>('/sms-inbox/counts'),
      api.get<{ deferred: DeferredEntry[] }>('/sms-inbox/deferred'),
    ]).then(([lines, counts, deferred]) => {
      setPhoneLines(lines.conversations);
      setInboxCounts(counts.counts);
      setDeferredEntries(deferred.deferred);
    }).catch(() => setError('Failed to load inbox'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!loading) loadConversations();
  }, [loadConversations, loading]);

  // The deferred filter narrows the conversation list to those
  // currently parked, so refresh the source-of-truth list whenever
  // the operator switches into that view to avoid showing stale rows.
  useEffect(() => {
    if (loading) return;
    if (activeFilter === 'deferred') {
      void refreshDeferred();
    }
  }, [activeFilter, loading, refreshDeferred]);

  const deferredByConv = useMemo(() => {
    // If the same recipient has multiple parked messages, keep the
    // earliest deferred-until time so the badge surfaces the next
    // window the operator should watch — anything later is implied.
    const map = new Map<string, DeferredEntry>();
    for (const entry of deferredEntries) {
      const existing = map.get(entry.conversationId);
      const existingT = existing?.deferredUntil ? Date.parse(existing.deferredUntil) : Number.POSITIVE_INFINITY;
      const candidateT = entry.deferredUntil ? Date.parse(entry.deferredUntil) : Number.POSITIVE_INFINITY;
      if (!existing || candidateT < existingT) {
        map.set(entry.conversationId, entry);
      }
    }
    return map;
  }, [deferredEntries]);

  const deferredCountByConv = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of deferredEntries) {
      counts.set(entry.conversationId, (counts.get(entry.conversationId) ?? 0) + 1);
    }
    return counts;
  }, [deferredEntries]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const selectConversation = async (conv: Conversation) => {
    setSelectedConv(conv);
    setShowNotes(false);
    setShowContactPanel(false);
    setShowTemplates(false);
    try {
      const [msgData, noteData] = await Promise.all([
        api.get<{ messages: Message[] }>(`/sms-inbox/threads/${conv.id}/messages`),
        api.get<{ notes: InternalNote[] }>(`/sms-inbox/threads/${conv.id}/notes`),
      ]);
      setMessages(msgData.messages);
      setNotes(noteData.notes);
      if (conv.unreadCount > 0) {
        setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, unreadCount: 0 } : c));
        setInboxCounts(prev => ({ ...prev, unread: Math.max(0, prev.unread - 1) }));
      }
    } catch {
      setError('Failed to load messages');
    }
  };

  const loadActivity = async () => {
    if (!selectedConv) return;
    try {
      const data = await api.get<{ log: ActivityEntry[] }>(`/sms-inbox/threads/${selectedConv.id}/activity`);
      setActivityLog(data.log);
    } catch {}
  };

  const sendReply = async () => {
    if (!replyText.trim() || !selectedConv) return;
    setSending(true);
    try {
      const payload: Record<string, unknown> = { body: replyText };
      if (showSchedule && scheduleDate) payload.scheduledAt = scheduleDate;

      const data = await api.post<{ message: Message }>(`/sms-inbox/threads/${selectedConv.id}/messages`, payload);
      setMessages(prev => [...prev, data.message]);
      setReplyText('');
      setShowSchedule(false);
      setScheduleDate('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const generateDraft = async () => {
    if (!selectedConv) return;
    setDrafting(true);
    try {
      const context = messages.slice(-5).map(m => `${m.direction === 'inbound' ? 'Customer' : 'Us'}: ${m.body}`).join('\n');
      const data = await api.post<{ draft: string }>('/sms-inbox/ai-draft', { context });
      setReplyText(data.draft);
    } catch {
      setError('Failed to generate draft');
    } finally {
      setDrafting(false);
    }
  };

  const updateConversation = async (updates: Record<string, unknown>) => {
    if (!selectedConv) return;
    try {
      const data = await api.patch<{ conversation: Conversation }>(`/sms-inbox/threads/${selectedConv.id}`, updates);
      setSelectedConv(data.conversation);
      setConversations(prev => prev.map(c => c.id === selectedConv.id ? data.conversation : c));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    }
  };

  const addNote = async () => {
    if (!noteText.trim() || !selectedConv) return;
    try {
      const data = await api.post<{ note: InternalNote }>(`/sms-inbox/threads/${selectedConv.id}/notes`, { body: noteText });
      setNotes(prev => [...prev, data.note]);
      setNoteText('');
    } catch {
      setError('Failed to add note');
    }
  };

  const handleBulkAction = async () => {
    if (selectedConvIds.size === 0 || !bulkAction) return;
    const ids = Array.from(selectedConvIds);
    const updates: Record<string, unknown> = { conversationIds: ids };
    if (bulkAction === 'close') updates.status = 'closed';
    else if (bulkAction === 'archive') updates.status = 'archived';
    else if (bulkAction === 'escalate') updates.status = 'escalated';

    try {
      await api.post('/sms-inbox/bulk-update', updates);
      setSelectedConvIds(new Set());
      setBulkAction('');
      loadConversations();
    } catch {
      setError('Bulk action failed');
    }
  };

  const loadTemplates = async () => {
    try {
      const data = await api.get<{ responses: CannedResponse[] }>('/sms-inbox/templates');
      setCannedResponses(data.responses);
    } catch {}
  };

  const loadAnalytics = async () => {
    try {
      const data = await api.get<{ analytics: Analytics }>('/sms-inbox/analytics');
      setAnalytics(data.analytics);
    } catch {}
  };

  const useTemplate = (template: CannedResponse) => {
    let text = template.body;
    if (selectedConv) {
      // The substitution map is keyed off SMS_CANNED_RESPONSE_TOKENS so
      // this loop and the editor's "supported tokens" list can never
      // drift. Adding a token requires touching
      // `shared/sms/cannedResponseTokens.ts`, which automatically
      // updates the editor warnings, the help text, and the
      // server-side reject — see task #806.
      const tokenValues: Record<typeof SMS_CANNED_RESPONSE_TOKENS[number], string> = {
        name: selectedConv.contactName || selectedConv.remoteNumber,
        phone: selectedConv.remoteNumber,
        contact_name: selectedConv.contactName || '',
        contact_email: selectedConv.contactEmail || '',
        contact_location: selectedConv.contactLocation || '',
        agent_name: user?.email || '',
      };
      for (const token of SMS_CANNED_RESPONSE_TOKENS) {
        text = text.replace(new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, 'gi'), tokenValues[token]);
      }
    }
    setReplyText(text);
    setShowTemplates(false);
  };

  const toggleConvSelection = (id: string) => {
    setSelectedConvIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (loading) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-4" data-testid="sms-inbox-loaded">
      <PageHeader
        icon={<MessageSquare className="h-5 w-5" />}
        title="SMS Console"
        description="Enterprise messaging workspace"
        actions={
          <>
            {(['inbox', 'templates', 'automations', 'analytics', 'admin'] as TabView[]).map(tab => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab);
                if (tab === 'templates') loadTemplates();
                if (tab === 'analytics') loadAnalytics();
              }}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                activeTab === tab ? 'bg-primary text-white' : 'text-muted hover:bg-surface-secondary'
              }`}
            >
              {tab === 'inbox' && <Inbox className="h-4 w-4 inline mr-1" />}
              {tab === 'templates' && <FileText className="h-4 w-4 inline mr-1" />}
              {tab === 'automations' && <Zap className="h-4 w-4 inline mr-1" />}
              {tab === 'analytics' && <BarChart3 className="h-4 w-4 inline mr-1" />}
              {tab === 'admin' && <Settings className="h-4 w-4 inline mr-1" />}
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
          </>
        }
      />

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {activeTab === 'inbox' && (
        <InboxView
          conversations={conversations}
          selectedConv={selectedConv}
          messages={messages}
          notes={notes}
          activityLog={activityLog}
          inboxCounts={inboxCounts}
          deferredByConv={deferredByConv}
          deferredCountByConv={deferredCountByConv}
          cannedResponses={cannedResponses}
          replyText={replyText}
          noteText={noteText}
          searchQuery={searchQuery}
          activeFilter={activeFilter}
          sending={sending}
          drafting={drafting}
          showContactPanel={showContactPanel}
          showNotes={showNotes}
          showTemplates={showTemplates}
          showSchedule={showSchedule}
          scheduleDate={scheduleDate}
          selectedConvIds={selectedConvIds}
          setSelectedConvIds={setSelectedConvIds}
          bulkAction={bulkAction}
          isManager={isManager}
          messagesEndRef={messagesEndRef}
          setReplyText={setReplyText}
          setNoteText={setNoteText}
          setSearchQuery={setSearchQuery}
          setActiveFilter={setActiveFilter}
          setShowContactPanel={setShowContactPanel}
          setShowNotes={setShowNotes}
          setShowTemplates={setShowTemplates}
          setShowSchedule={setShowSchedule}
          setScheduleDate={setScheduleDate}
          setBulkAction={setBulkAction}
          selectConversation={selectConversation}
          setSelectedConv={setSelectedConv}
          sendReply={sendReply}
          generateDraft={generateDraft}
          updateConversation={updateConversation}
          addNote={addNote}
          handleBulkAction={handleBulkAction}
          toggleConvSelection={toggleConvSelection}
          useTemplate={useTemplate}
          loadTemplates={loadTemplates}
          loadActivity={loadActivity}
        />
      )}

      {activeTab === 'templates' && <TemplatesView cannedResponses={cannedResponses} loadTemplates={loadTemplates} isManager={isManager} />}
      {activeTab === 'automations' && <AutomationsView isManager={isManager} />}
      {activeTab === 'analytics' && <AnalyticsView analytics={analytics} loadAnalytics={loadAnalytics} />}
      {activeTab === 'admin' && <AdminView isManager={isManager} />}
    </div>
  );
}

function InboxView({
  conversations, selectedConv, messages, notes, activityLog, inboxCounts,
  deferredByConv, deferredCountByConv, cannedResponses,
  replyText, noteText, searchQuery, activeFilter, sending, drafting,
  showContactPanel, showNotes, showTemplates, showSchedule, scheduleDate,
  selectedConvIds, setSelectedConvIds, bulkAction, isManager, messagesEndRef,
  setReplyText, setNoteText, setSearchQuery, setActiveFilter,
  setShowContactPanel, setShowNotes, setShowTemplates, setShowSchedule, setScheduleDate,
  setBulkAction, selectConversation, setSelectedConv, sendReply, generateDraft,
  updateConversation, addNote, handleBulkAction, toggleConvSelection, useTemplate, loadTemplates, loadActivity,
}: {
  conversations: Conversation[];
  selectedConv: Conversation | null;
  messages: Message[];
  notes: InternalNote[];
  activityLog: ActivityEntry[];
  inboxCounts: InboxCounts;
  deferredByConv: Map<string, DeferredEntry>;
  deferredCountByConv: Map<string, number>;
  cannedResponses: CannedResponse[];
  replyText: string;
  noteText: string;
  searchQuery: string;
  activeFilter: InboxFilter;
  sending: boolean;
  drafting: boolean;
  showContactPanel: boolean;
  showNotes: boolean;
  showTemplates: boolean;
  showSchedule: boolean;
  scheduleDate: string;
  selectedConvIds: Set<string>;
  setSelectedConvIds: (v: Set<string>) => void;
  bulkAction: string;
  isManager: boolean;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  setReplyText: (v: string) => void;
  setNoteText: (v: string) => void;
  setSearchQuery: (v: string) => void;
  setActiveFilter: (v: InboxFilter) => void;
  setShowContactPanel: (v: boolean) => void;
  setShowNotes: (v: boolean) => void;
  setShowTemplates: (v: boolean) => void;
  setShowSchedule: (v: boolean) => void;
  setScheduleDate: (v: string) => void;
  setBulkAction: (v: string) => void;
  selectConversation: (c: Conversation) => void;
  setSelectedConv: (c: Conversation | null) => void;
  sendReply: () => void;
  generateDraft: () => void;
  updateConversation: (u: Record<string, unknown>) => void;
  addNote: () => void;
  handleBulkAction: () => void;
  toggleConvSelection: (id: string) => void;
  useTemplate: (t: CannedResponse) => void;
  loadTemplates: () => void;
  loadActivity: () => void;
}) {
  const { user } = useAuth();

  // Carriers split anything over 160 GSM-7 chars (or 70 UCS-2 chars
  // if a non-GSM character sneaks in) into multiple billed segments.
  // Surface that under the composer so an agent who pastes a long
  // reply or sneaks in an em-dash sees the segment count jump
  // immediately, instead of finding out from the next Twilio bill.
  // Mirrors the dispatch template editor preview from task #824.
  const replySegmentInfo = useMemo(
    () => countSmsSegments(replyText),
    [replyText],
  );
  const showReplySegmentWarning =
    replySegmentInfo.segments > 1 || replySegmentInfo.encoding === 'UCS-2';

  const filters: { key: InboxFilter; label: string; count?: number }[] = [
    { key: 'all', label: 'All' },
    { key: 'open', label: 'Open', count: inboxCounts.open },
    { key: 'pending', label: 'Pending', count: inboxCounts.pending },
    { key: 'escalated', label: 'Escalated', count: inboxCounts.escalated },
    { key: 'closed', label: 'Closed', count: inboxCounts.closed },
    { key: 'unread', label: 'Unread', count: inboxCounts.unread },
    { key: 'deferred', label: 'Deferred', count: inboxCounts.deferred },
    { key: 'pinned', label: 'Pinned' },
    { key: 'followUp', label: 'Follow-up' },
  ];

  return (
    <div className="flex gap-4 h-[calc(100vh-180px)] min-h-[500px]">
      {/* Left sidebar - conversation list */}
      <div className={`${selectedConv ? 'hidden lg:flex' : 'flex'} flex-col w-full lg:w-80 shrink-0 bg-surface border border-border rounded-xl overflow-hidden`}>
        <div className="p-3 border-b border-border space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search conversations..."
              aria-label="Search SMS conversations"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {filters.map(f => (
              <button
                key={f.key}
                onClick={() => setActiveFilter(f.key)}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  activeFilter === f.key ? 'bg-primary text-white' : 'text-muted hover:bg-surface-secondary'
                }`}
              >
                {f.label}
                {f.count !== undefined && f.count > 0 && (
                  <span aria-hidden="true" className="ml-1 bg-white/20 rounded-full px-1.5">{f.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {selectedConvIds.size > 0 && (
          <div className="p-2 border-b border-border bg-surface-secondary flex items-center gap-2">
            <span className="text-xs text-muted">{selectedConvIds.size} selected</span>
            <select
              value={bulkAction}
              onChange={e => setBulkAction(e.target.value)}
              className="text-xs border border-border rounded px-2 py-1 bg-surface text-heading"
            >
              <option value="">Action...</option>
              <option value="close">Close</option>
              <option value="archive">Archive</option>
              <option value="escalate">Escalate</option>
            </select>
            <button onClick={handleBulkAction} disabled={!bulkAction} className="text-xs px-2 py-1 bg-primary text-white rounded disabled:opacity-50">
              Apply
            </button>
            <button onClick={() => { setSelectedConvIds(new Set()); setBulkAction(''); }} className="text-xs text-muted hover:text-heading" title="Clear selection">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={activeFilter === 'all' ? 'No conversations yet' : 'No conversations match this view'}
              description={activeFilter === 'all'
                ? 'Inbound and outbound SMS threads will appear here once messaging is configured.'
                : 'Try a different filter or clear your search to see more conversations.'}
              secondaryAction={activeFilter !== 'all' ? { label: 'Show all', onClick: () => setActiveFilter('all') } : undefined}
              variant="compact"
            />
          ) : (
            conversations.map(conv => (
              <div
                key={conv.id}
                className={`relative border-b border-border hover:bg-surface-secondary transition-colors cursor-pointer ${
                  selectedConv?.id === conv.id ? 'bg-primary/10' : ''
                }`}
              >
                <div className="flex items-start gap-2 px-3 py-3">
                  <input
                    type="checkbox"
                    checked={selectedConvIds.has(conv.id)}
                    onChange={() => toggleConvSelection(conv.id)}
                    className="mt-1 shrink-0"
                    onClick={e => e.stopPropagation()}
                  />
                  <div className="flex-1 min-w-0" onClick={() => selectConversation(conv)}>
                    <div className="flex items-center gap-2">
                      {conv.pinned && <Pin className="h-3 w-3 text-primary shrink-0" />}
                      <span className={`font-medium text-sm ${conv.unreadCount > 0 ? 'text-heading font-semibold' : 'text-heading'}`}>
                        {conv.contactName || conv.remoteNumber}
                      </span>
                      {conv.unreadCount > 0 && (
                        <span
                          className="bg-primary text-white text-[10px] rounded-full px-1.5 py-0.5 font-bold"
                          aria-label={`${conv.unreadCount} unread message${conv.unreadCount === 1 ? '' : 's'}`}
                          title={`${conv.unreadCount} unread message${conv.unreadCount === 1 ? '' : 's'} in this conversation`}
                        >{conv.unreadCount}</span>
                      )}
                      {conv.followUp && <Bell className="h-3 w-3 text-yellow-500 dark:text-yellow-400 shrink-0" />}
                    </div>
                    {conv.contactName && (
                      <div className="text-[11px] text-muted">{conv.remoteNumber}</div>
                    )}
                    <p className="text-xs text-muted mt-0.5 truncate">{conv.lastMessagePreview || 'No messages yet'}</p>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <ConversationStatusBadge status={conv.status} />
                      {(() => {
                        const deferredEntry = deferredByConv.get(conv.id);
                        if (!deferredEntry) return null;
                        const queued = deferredCountByConv.get(conv.id) ?? 1;
                        const tz = deferredEntry.recipientTimezone ?? 'recipient timezone';
                        const display = formatDeferredUntil(deferredEntry.deferredUntil);
                        const tooltip = queued > 1
                          ? `${queued} outbound texts held back by TCPA quiet hours — next attempt ${display} (${tz})`
                          : `Held back by TCPA quiet hours — next attempt ${display} (${tz})`;
                        return (
                          <span
                            data-testid="sms-inbox-deferred-badge"
                            data-conversation-id={conv.id}
                            data-deferred-count={queued}
                            title={tooltip}
                            className="inline-flex items-center gap-1 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200"
                          >
                            <Clock className="h-3 w-3" aria-hidden="true" />
                            <span>deferred until {display}</span>
                            {queued > 1 && (
                              <span className="rounded-full bg-amber-200/70 dark:bg-amber-800/70 px-1 text-[10px]">
                                {queued}
                              </span>
                            )}
                          </span>
                        );
                      })()}
                      {conv.priority !== 'normal' && (() => {
                        const pi = PRIORITY_ICONS[conv.priority] ?? PRIORITY_ICONS.normal;
                        const PIcon = pi.icon;
                        return <PIcon className={`h-3 w-3 ${pi.color}`} />;
                      })()}
                      {conv.assigneeUserId && <User className="h-3 w-3 text-muted" />}
                      {conv.lastMessageAt && (
                        <span className="text-[10px] text-muted ml-auto">
                          {formatRelativeTime(conv.lastMessageAt)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Center - message thread */}
      {/*
        Outer container intentionally does NOT use `overflow-hidden` even though
        it has `rounded-xl`. The toolbar in the header hosts 3 CSS-hover
        dropdowns (priority / status / assign) that use `absolute top-full` to
        drop BELOW the toolbar. With `overflow-hidden` on this container the
        dropdowns were getting clipped — users could not change priority,
        status, or assign from the toolbar at all. The inner messages region
        (`flex flex-1 overflow-hidden` further down) clips message overflow on
        its own, so the rounded-xl look is preserved.
        P0 user-visible bug from console redesign audit (2026-05-24).
      */}
      {selectedConv ? (
        <div className="flex flex-col flex-1 bg-surface border border-border rounded-xl">
          <div className="flex items-center gap-3 p-3 border-b border-border">
            <button onClick={() => setSelectedConv(null)} className="lg:hidden text-muted hover:text-heading">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-heading text-sm truncate">
                  {selectedConv.contactName || selectedConv.remoteNumber}
                </h3>
                <ConversationStatusBadge status={selectedConv.status} />
              </div>
              <p className="text-xs text-muted">
                {selectedConv.contactName ? selectedConv.remoteNumber + ' · ' : ''}{messages.length} messages
                {selectedConv.assigneeUserId && ` · Assigned`}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => updateConversation({ pinned: !selectedConv.pinned })}
                className={`p-1.5 rounded-lg hover:bg-surface-secondary ${selectedConv.pinned ? 'text-primary' : 'text-muted'}`}
                title="Pin"
              >
                <Pin className="h-4 w-4" />
              </button>
              <button
                onClick={() => updateConversation({ followUp: !selectedConv.followUp })}
                className={`p-1.5 rounded-lg hover:bg-surface-secondary ${selectedConv.followUp ? 'text-yellow-500 dark:text-yellow-400' : 'text-muted'}`}
                title="Follow-up"
              >
                <Bell className="h-4 w-4" />
              </button>
              <div className="relative group">
                <button className="p-1.5 rounded-lg hover:bg-surface-secondary text-muted" title="Priority">
                  <Flag className="h-4 w-4" />
                </button>
                <div className="hidden group-hover:block absolute right-0 top-full z-dropdown bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[100px]">
                  {['normal', 'high', 'urgent'].map(p => (
                    <button
                      key={p}
                      onClick={() => updateConversation({ priority: p })}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-secondary ${selectedConv.priority === p ? 'font-bold' : ''}`}
                    >
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="relative group">
                <button className="p-1.5 rounded-lg hover:bg-surface-secondary text-muted" title="Status">
                  <ChevronDown className="h-4 w-4" />
                </button>
                <div className="hidden group-hover:block absolute right-0 top-full z-dropdown bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[120px]">
                  {['open', 'pending', 'closed', 'escalated', 'archived'].map(s => (
                    <button
                      key={s}
                      onClick={() => updateConversation({ status: s })}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-secondary ${selectedConv.status === s ? 'font-bold' : ''}`}
                    >
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="relative group">
                <button className={`p-1.5 rounded-lg hover:bg-surface-secondary ${selectedConv.assigneeUserId || selectedConv.assigneeTeam ? 'text-primary' : 'text-muted'}`} title="Assign">
                  <Users className="h-4 w-4" />
                </button>
                <div className="hidden group-hover:block absolute right-0 top-full z-dropdown bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[140px]">
                  <div className="px-3 py-1 text-[10px] text-muted font-semibold uppercase">Assign to Team</div>
                  {['sales', 'support', 'billing', 'general'].map(team => (
                    <button
                      key={team}
                      onClick={() => updateConversation({ assigneeTeam: team, assigneeUserId: null })}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-secondary ${selectedConv.assigneeTeam === team ? 'font-bold' : ''}`}
                    >
                      {team.charAt(0).toUpperCase() + team.slice(1)}
                    </button>
                  ))}
                  <div className="border-t border-border my-1"></div>
                  <button
                    onClick={() => updateConversation({ assigneeUserId: user?.userId || null })}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-secondary"
                  >
                    Assign to Me
                  </button>
                  {(selectedConv.assigneeUserId || selectedConv.assigneeTeam) && (
                    <button
                      onClick={() => updateConversation({ assigneeUserId: null, assigneeTeam: null })}
                      className="w-full text-left px-3 py-1.5 text-xs text-red-500 dark:text-red-400 hover:bg-surface-secondary"
                    >
                      Unassign
                    </button>
                  )}
                </div>
              </div>
              <button
                onClick={() => { setShowNotes(!showNotes); setShowContactPanel(false); }}
                className={`p-1.5 rounded-lg hover:bg-surface-secondary ${showNotes ? 'text-primary' : 'text-muted'}`}
                title="Notes"
              >
                <StickyNote className="h-4 w-4" />
              </button>
              <button
                onClick={() => { setShowContactPanel(!showContactPanel); setShowNotes(false); }}
                className={`p-1.5 rounded-lg hover:bg-surface-secondary ${showContactPanel ? 'text-primary' : 'text-muted'}`}
                title="Contact info"
              >
                <User className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="flex flex-1 overflow-hidden">
            <div className="flex flex-col flex-1 overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map(msg => (
                  <div key={msg.id} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-xl px-4 py-2.5 text-sm ${
                      msg.direction === 'outbound'
                        ? 'bg-primary text-white'
                        : 'bg-surface-secondary text-heading'
                    }`}>
                      <p className="whitespace-pre-wrap">{msg.body}</p>
                      <div className={`text-[10px] mt-1 flex items-center gap-1 ${msg.direction === 'outbound' ? 'text-white/70' : 'text-muted'}`}>
                        {msg.createdAt && new Date(msg.createdAt).toLocaleTimeString()}
                        {msg.status === 'delivered' && <CheckCircle className="h-3 w-3" />}
                        {msg.status === 'failed' && <XCircle className="h-3 w-3 text-red-400" />}
                        {msg.status === 'scheduled' && <Clock className="h-3 w-3" />}
                        {msg.status !== 'delivered' && msg.status !== 'failed' && msg.status !== 'scheduled' && (
                          <span>&middot; {msg.status}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              <div className="p-3 border-t border-border space-y-2">
                  {showTemplates && cannedResponses.length > 0 && (
                    <div className="bg-surface-secondary rounded-lg p-2 max-h-32 overflow-y-auto">
                      {cannedResponses.map(t => (
                        <button
                          key={t.id}
                          onClick={() => useTemplate(t)}
                          className="w-full text-left px-2 py-1.5 text-xs hover:bg-surface rounded transition-colors"
                        >
                          <span className="font-medium text-heading">{t.title}</span>
                          {t.category && <span className="text-muted ml-1">({t.category})</span>}
                          <p className="text-muted truncate">{t.body}</p>
                        </button>
                      ))}
                    </div>
                  )}
                  {showSchedule && (
                    <div className="flex items-center gap-2 bg-surface-secondary rounded-lg p-2">
                      <Calendar className="h-4 w-4 text-muted" />
                      <input
                        type="datetime-local"
                        value={scheduleDate}
                        onChange={e => setScheduleDate(e.target.value)}
                        className="flex-1 text-xs bg-transparent border-none outline-none text-heading"
                      />
                      <button onClick={() => { setShowSchedule(false); setScheduleDate(''); }} className="text-muted hover:text-heading">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <div className="flex gap-1">
                      <button
                        onClick={generateDraft}
                        disabled={drafting}
                        className="p-2 rounded-lg text-sm bg-surface-secondary text-heading hover:bg-primary/10 transition-colors disabled:opacity-50"
                        title="AI Draft"
                      >
                        <Sparkles className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => { setShowTemplates(!showTemplates); if (!showTemplates) loadTemplates(); }}
                        className={`p-2 rounded-lg text-sm transition-colors ${showTemplates ? 'bg-primary/10 text-primary' : 'bg-surface-secondary text-heading hover:bg-primary/10'}`}
                        title="Templates"
                      >
                        <FileText className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setShowSchedule(!showSchedule)}
                        className={`p-2 rounded-lg text-sm transition-colors ${showSchedule ? 'bg-primary/10 text-primary' : 'bg-surface-secondary text-heading hover:bg-primary/10'}`}
                        title="Schedule"
                      >
                        <Clock className="h-4 w-4" />
                      </button>
                    </div>
                    <input
                      type="text"
                      value={replyText}
                      onChange={e => setReplyText(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendReply()}
                      placeholder="Type your reply..."
                      className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <button
                      onClick={sendReply}
                      disabled={sending || !replyText.trim()}
                      className="px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      <Send className="h-4 w-4" />
                      {showSchedule && scheduleDate ? 'Schedule' : 'Send'}
                    </button>
                  </div>
                  {replyText.length > 0 && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                      <span
                        data-testid="sms-inbox-composer-segments"
                        data-encoding={replySegmentInfo.encoding}
                        data-segments={replySegmentInfo.segments}
                        className={
                          showReplySegmentWarning
                            ? 'text-amber-700 dark:text-amber-400 font-medium'
                            : 'text-muted'
                        }
                      >
                        {replySegmentInfo.characters}{' '}
                        character{replySegmentInfo.characters === 1 ? '' : 's'}
                        {' · '}
                        {replySegmentInfo.segments}{' '}
                        segment{replySegmentInfo.segments === 1 ? '' : 's'}
                        {replySegmentInfo.encoding === 'UCS-2' && ' (Unicode)'}
                      </span>
                      {showReplySegmentWarning && (
                        <span
                          role="alert"
                          data-testid="sms-inbox-composer-segments-warning"
                          className="text-[11px] text-amber-700 dark:text-amber-400"
                        >
                          {replySegmentInfo.encoding === 'UCS-2'
                            ? `— a non-GSM character forced Unicode mode, dropping the per-segment limit to 70 (billed as ${replySegmentInfo.segments} SMS).`
                            : `— billed as ${replySegmentInfo.segments} SMS. Trim to 160 characters to send as one.`}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

            {/* Side panels */}
            {showNotes && (
              <div className="w-64 border-l border-border overflow-y-auto p-3 space-y-3 hidden md:block">
                <h4 className="font-semibold text-heading text-sm flex items-center gap-1.5">
                  <StickyNote className="h-4 w-4" /> Internal Notes
                </h4>
                <div className="space-y-2">
                  {notes.map(note => (
                    <div key={note.id} className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-2 text-xs">
                      <p className="text-heading">{note.body}</p>
                      <p className="text-muted mt-1">{note.userName} &middot; {new Date(note.createdAt).toLocaleDateString()}</p>
                    </div>
                  ))}
                </div>
                <div className="flex gap-1">
                  <input
                    type="text"
                    value={noteText}
                    onChange={e => setNoteText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addNote()}
                    placeholder="Add a note..."
                    className="flex-1 px-2 py-1.5 text-xs rounded border border-border bg-surface text-heading focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                  <button onClick={addNote} disabled={!noteText.trim()} className="p-1.5 rounded bg-primary text-white disabled:opacity-50">
                    <Plus className="h-3 w-3" />
                  </button>
                </div>
                <div className="pt-2 border-t border-border">
                  <button onClick={loadActivity} className="text-xs text-primary hover:underline flex items-center gap-1">
                    <RefreshCw className="h-3 w-3" /> Load activity log
                  </button>
                  {activityLog.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {activityLog.slice(0, 10).map(entry => (
                        <div key={entry.id} className="text-[11px] text-muted">
                          <span className="font-medium">{entry.actorName || 'System'}</span>{' '}
                          {entry.action.replace(/_/g, ' ')}{' '}
                          <span className="text-[10px]">{formatRelativeTime(entry.createdAt)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {showContactPanel && (
              <div className="w-64 border-l border-border overflow-y-auto p-3 space-y-3 hidden md:block">
                <h4 className="font-semibold text-heading text-sm flex items-center gap-1.5">
                  <User className="h-4 w-4" /> Contact Profile
                </h4>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 text-muted" />
                    <span className="text-heading">{selectedConv.remoteNumber}</span>
                  </div>
                  {selectedConv.contactName && (
                    <div className="flex items-center gap-2">
                      <User className="h-3.5 w-3.5 text-muted" />
                      <span className="text-heading">{selectedConv.contactName}</span>
                    </div>
                  )}
                  {selectedConv.contactEmail && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-3.5 w-3.5 text-muted" />
                      <span className="text-heading">{selectedConv.contactEmail}</span>
                    </div>
                  )}
                  {selectedConv.contactLocation && (
                    <div className="flex items-center gap-2">
                      <MapPin className="h-3.5 w-3.5 text-muted" />
                      <span className="text-heading">{selectedConv.contactLocation}</span>
                    </div>
                  )}
                </div>

                <div className="pt-2 border-t border-border">
                  <h5 className="text-xs font-medium text-heading mb-1">Tags</h5>
                  <div className="flex flex-wrap gap-1">
                    {(selectedConv.tags ?? []).map((tag, i) => (
                      <span key={i} className="bg-surface-secondary text-muted text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1">
                        <Hash className="h-2.5 w-2.5" />{tag}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="pt-2 border-t border-border space-y-2">
                  <h5 className="text-xs font-medium text-heading">Edit Contact</h5>
                  <input
                    type="text"
                    placeholder="Name"
                    defaultValue={selectedConv.contactName ?? ''}
                    onBlur={e => { if (e.target.value !== (selectedConv.contactName ?? '')) updateConversation({ contactName: e.target.value || null }); }}
                    className="w-full px-2 py-1.5 text-xs rounded border border-border bg-surface text-heading focus:outline-none"
                  />
                  <input
                    type="email"
                    placeholder="Email"
                    defaultValue={selectedConv.contactEmail ?? ''}
                    onBlur={e => { if (e.target.value !== (selectedConv.contactEmail ?? '')) updateConversation({ contactEmail: e.target.value || null }); }}
                    className="w-full px-2 py-1.5 text-xs rounded border border-border bg-surface text-heading focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Location"
                    defaultValue={selectedConv.contactLocation ?? ''}
                    onBlur={e => { if (e.target.value !== (selectedConv.contactLocation ?? '')) updateConversation({ contactLocation: e.target.value || null }); }}
                    className="w-full px-2 py-1.5 text-xs rounded border border-border bg-surface text-heading focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="hidden lg:flex flex-col flex-1 bg-surface border border-border rounded-xl overflow-hidden items-center justify-center text-muted text-sm">
          <Inbox className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p>Select a conversation to view messages</p>
        </div>
      )}
    </div>
  );
}

function TemplatesView({ cannedResponses, loadTemplates, isManager }: { cannedResponses: CannedResponse[]; loadTemplates: () => void; isManager: boolean }) {
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ title: '', body: '', category: '', shortcut: '', variables: '' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { loadTemplates(); }, []);

  // Surface typos like {{custmer_name}} before they ship in a
  // customer-facing reply — see task #806 and
  // shared/sms/cannedResponseTokens.ts. The renderer (useTemplate)
  // only substitutes tokens in the same allowlist, so anything else
  // would leak through as raw braces.
  const unknownBodyTokens = useMemo(
    () => findUnknownSmsCannedResponseTokens(form.body),
    [form.body],
  );
  const hasUnknownTokens = unknownBodyTokens.length > 0;

  const save = async () => {
    if (!form.title || !form.body) { setError('Title and body are required'); return; }
    if (hasUnknownTokens) {
      setError(`Unknown merge token${unknownBodyTokens.length === 1 ? '' : 's'}: ${unknownBodyTokens.map(t => `{{${t}}}`).join(', ')}. Fix or remove them before saving.`);
      return;
    }
    try {
      const data = {
        title: form.title,
        body: form.body,
        category: form.category || undefined,
        shortcut: form.shortcut || undefined,
        variables: form.variables ? form.variables.split(',').map(v => v.trim()) : undefined,
      };
      if (editId) {
        await api.patch(`/sms-inbox/templates/${editId}`, data);
      } else {
        await api.post('/sms-inbox/templates', data);
      }
      setShowForm(false);
      setEditId(null);
      setForm({ title: '', body: '', category: '', shortcut: '', variables: '' });
      loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template');
    }
  };

  const deleteTemplate = async (id: string) => {
    try {
      await api.delete(`/sms-inbox/templates/${id}`);
      loadTemplates();
    } catch {}
  };

  const startEdit = (t: CannedResponse) => {
    setEditId(t.id);
    setForm({ title: t.title, body: t.body, category: t.category ?? '', shortcut: t.shortcut ?? '', variables: t.variables.join(', ') });
    setShowForm(true);
  };

  return (
    <div className="bg-surface border border-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-heading">Canned Response Templates</h2>
        {isManager && (
          <button onClick={() => { setShowForm(true); setEditId(null); setForm({ title: '', body: '', category: '', shortcut: '', variables: '' }); }} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-sm rounded-lg hover:bg-primary/90">
            <Plus className="h-4 w-4" /> New Template
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300 mb-4">
          {error} <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      {showForm && (
        <div className="bg-surface-secondary rounded-lg p-4 mb-4 space-y-3">
          <h3 className="text-sm font-medium text-heading">{editId ? 'Edit' : 'New'} Template</h3>
          <input type="text" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="Title" className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none" />
          <div>
            <textarea
              value={form.body}
              onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
              placeholder={`Template body — use ${SMS_CANNED_RESPONSE_TOKENS.map(t => `{{${t}}}`).join(', ')}.`}
              rows={3}
              aria-invalid={hasUnknownTokens || undefined}
              className={`w-full px-3 py-2 rounded-lg border bg-surface text-heading text-sm focus:outline-none resize-none ${
                hasUnknownTokens ? 'border-amber-500' : 'border-border'
              }`}
            />
            {hasUnknownTokens && (
              <p
                role="alert"
                data-testid="sms-template-unknown-token-warning"
                className="mt-1 text-[11px] text-amber-700 dark:text-amber-400"
              >
                Unknown merge token{unknownBodyTokens.length === 1 ? '' : 's'}{' '}
                {unknownBodyTokens.map((t, i) => (
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
              {SMS_CANNED_RESPONSE_TOKENS.map((t, i) => (
                <span key={t}>
                  {i > 0 && ', '}
                  <code>{`{{${t}}}`}</code>
                </span>
              ))}
              .
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <input type="text" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="Category" className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none" />
            <input type="text" value={form.shortcut} onChange={e => setForm(f => ({ ...f, shortcut: e.target.value }))} placeholder="Shortcut (e.g. /greet)" className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none" />
            <input type="text" value={form.variables} onChange={e => setForm(f => ({ ...f, variables: e.target.value }))} placeholder="Variables (comma-separated)" className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none" />
          </div>
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={hasUnknownTokens}
              title={hasUnknownTokens ? 'Fix the unknown merge tokens before saving.' : undefined}
              className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
            >
              Save
            </button>
            <button onClick={() => { setShowForm(false); setEditId(null); }} className="px-4 py-2 text-muted text-sm hover:text-heading">Cancel</button>
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {cannedResponses.map(t => (
          <div key={t.id} className="bg-surface-secondary rounded-lg p-4">
            <div className="flex items-start justify-between">
              <div>
                <h4 className="font-medium text-heading text-sm">{t.title}</h4>
                {t.category && <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">{t.category}</span>}
              </div>
              {isManager && (
                <div className="flex gap-1">
                  <button onClick={() => startEdit(t)} className="p-1 text-muted hover:text-heading"><Edit className="h-3.5 w-3.5" /></button>
                  <button onClick={() => deleteTemplate(t.id)} className="p-1 text-muted hover:text-red-500 dark:hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </div>
            <p className="text-xs text-muted mt-2 line-clamp-3">{t.body}</p>
            {t.shortcut && <p className="text-[10px] text-primary mt-1 font-mono">{t.shortcut}</p>}
            {t.variables.length > 0 && (
              <div className="flex gap-1 mt-2 flex-wrap">
                {t.variables.map((v, i) => (
                  <span key={i} className="text-[10px] bg-surface text-muted px-1.5 py-0.5 rounded">{`{{${v}}}`}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        {cannedResponses.length === 0 && (
          <div className="col-span-full">
            <EmptyState
              icon={FileText}
              title="No templates yet"
              description="Save common replies as templates so your team can respond faster with one click."
              variant="compact"
            />
          </div>
        )}
      </div>
    </div>
  );
}

function AutomationsView({ isManager }: { isManager: boolean }) {
  const [autoRules, setAutoRules] = useState<Array<{ id: string; name: string; ruleType: string; keyword: string | null; replyBody: string; enabled: boolean }>>([]);
  const [assignRules, setAssignRules] = useState<Array<{ id: string; name: string; matchField: string; matchValue: string; assignToUserId: string | null; assignToTeam: string | null; enabled: boolean }>>([]);
  const [showAutoForm, setShowAutoForm] = useState(false);
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [autoForm, setAutoForm] = useState({ name: '', ruleType: 'keyword', keyword: '', matchType: 'exact', replyBody: '', isBusinessHours: '', businessHoursStart: '09:00', businessHoursEnd: '17:00' });
  const [assignForm, setAssignForm] = useState({ name: '', ruleType: 'auto', matchField: 'keyword', matchValue: '', assignToTeam: '' });
  const [autoFormError, setAutoFormError] = useState<string | null>(null);

  const unknownReplyTokens = useMemo(
    () => findUnknownSmsCannedResponseTokens(autoForm.replyBody),
    [autoForm.replyBody],
  );
  const hasUnknownReplyTokens = unknownReplyTokens.length > 0;

  useEffect(() => {
    Promise.all([
      api.get<{ rules: typeof autoRules }>('/sms-inbox/auto-reply-rules').catch(() => ({ rules: [] })),
      api.get<{ rules: typeof assignRules }>('/sms-inbox/assignment-rules').catch(() => ({ rules: [] })),
    ]).then(([auto, assign]) => {
      setAutoRules(auto.rules);
      setAssignRules(assign.rules);
    });
  }, []);

  const createAutoRule = async () => {
    if (hasUnknownReplyTokens) {
      setAutoFormError(`Unknown merge token${unknownReplyTokens.length === 1 ? '' : 's'}: ${unknownReplyTokens.map(t => `{{${t}}}`).join(', ')}. Fix or remove them before saving.`);
      return;
    }
    try {
      await api.post('/sms-inbox/auto-reply-rules', {
        name: autoForm.name,
        ruleType: autoForm.ruleType,
        keyword: autoForm.keyword || undefined,
        matchType: autoForm.matchType,
        replyBody: autoForm.replyBody,
        isBusinessHours: autoForm.isBusinessHours === '' ? undefined : autoForm.isBusinessHours === 'true',
        businessHoursStart: autoForm.businessHoursStart,
        businessHoursEnd: autoForm.businessHoursEnd,
      });
      setShowAutoForm(false);
      setAutoFormError(null);
      const data = await api.get<{ rules: typeof autoRules }>('/sms-inbox/auto-reply-rules');
      setAutoRules(data.rules);
    } catch (err) {
      setAutoFormError(err instanceof Error ? err.message : 'Failed to save auto-reply rule');
    }
  };

  const createAssignRule = async () => {
    try {
      await api.post('/sms-inbox/assignment-rules', {
        name: assignForm.name,
        ruleType: assignForm.ruleType,
        matchField: assignForm.matchField,
        matchValue: assignForm.matchValue,
        assignToTeam: assignForm.assignToTeam || undefined,
      });
      setShowAssignForm(false);
      const data = await api.get<{ rules: typeof assignRules }>('/sms-inbox/assignment-rules');
      setAssignRules(data.rules);
    } catch {}
  };

  const deleteAutoRule = async (id: string) => {
    await api.delete(`/sms-inbox/auto-reply-rules/${id}`);
    setAutoRules(prev => prev.filter(r => r.id !== id));
  };

  const deleteAssignRule = async (id: string) => {
    await api.delete(`/sms-inbox/assignment-rules/${id}`);
    setAssignRules(prev => prev.filter(r => r.id !== id));
  };

  return (
    <div className="space-y-6">
      <div className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-heading flex items-center gap-2"><Zap className="h-5 w-5 text-primary" /> Auto-Reply Rules</h2>
          {isManager && (
            <button onClick={() => setShowAutoForm(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-sm rounded-lg hover:bg-primary/90">
              <Plus className="h-4 w-4" /> New Rule
            </button>
          )}
        </div>

        {showAutoForm && (
          <div className="bg-surface-secondary rounded-lg p-4 mb-4 space-y-3">
            {autoFormError && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
                {autoFormError} <button onClick={() => setAutoFormError(null)} className="ml-2 underline">Dismiss</button>
              </div>
            )}
            <input type="text" value={autoForm.name} onChange={e => setAutoForm(f => ({ ...f, name: e.target.value }))} placeholder="Rule name" className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm" />
            <div className="grid grid-cols-3 gap-3">
              <select value={autoForm.ruleType} onChange={e => setAutoForm(f => ({ ...f, ruleType: e.target.value }))} className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm">
                <option value="keyword">Keyword Trigger</option>
                <option value="business_hours">Business Hours</option>
              </select>
              {autoForm.ruleType === 'keyword' && (
                <>
                  <input type="text" value={autoForm.keyword} onChange={e => setAutoForm(f => ({ ...f, keyword: e.target.value }))} placeholder="Keyword" className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm" />
                  <select value={autoForm.matchType} onChange={e => setAutoForm(f => ({ ...f, matchType: e.target.value }))} className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm">
                    <option value="exact">Exact Match</option>
                    <option value="contains">Contains</option>
                    <option value="starts_with">Starts With</option>
                  </select>
                </>
              )}
              {autoForm.ruleType === 'business_hours' && (
                <>
                  <select value={autoForm.isBusinessHours} onChange={e => setAutoForm(f => ({ ...f, isBusinessHours: e.target.value }))} className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm">
                    <option value="">Any time</option>
                    <option value="true">During business hours</option>
                    <option value="false">After hours</option>
                  </select>
                  <div className="flex gap-1">
                    <input type="time" value={autoForm.businessHoursStart} onChange={e => setAutoForm(f => ({ ...f, businessHoursStart: e.target.value }))} className="px-2 py-2 rounded-lg border border-border bg-surface text-heading text-xs" />
                    <input type="time" value={autoForm.businessHoursEnd} onChange={e => setAutoForm(f => ({ ...f, businessHoursEnd: e.target.value }))} className="px-2 py-2 rounded-lg border border-border bg-surface text-heading text-xs" />
                  </div>
                </>
              )}
            </div>
            <div>
              <textarea
                value={autoForm.replyBody}
                onChange={e => setAutoForm(f => ({ ...f, replyBody: e.target.value }))}
                placeholder={`Auto-reply message — supported tokens: ${SMS_CANNED_RESPONSE_TOKENS.map(t => `{{${t}}}`).join(', ')}.`}
                rows={2}
                aria-invalid={hasUnknownReplyTokens || undefined}
                className={`w-full px-3 py-2 rounded-lg border bg-surface text-heading text-sm resize-none ${
                  hasUnknownReplyTokens ? 'border-amber-500' : 'border-border'
                }`}
              />
              {hasUnknownReplyTokens && (
                <p
                  role="alert"
                  data-testid="sms-auto-reply-unknown-token-warning"
                  className="mt-1 text-[11px] text-amber-700 dark:text-amber-400"
                >
                  Unknown merge token{unknownReplyTokens.length === 1 ? '' : 's'}{' '}
                  {unknownReplyTokens.map((t, i) => (
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
                {SMS_CANNED_RESPONSE_TOKENS.map((t, i) => (
                  <span key={t}>
                    {i > 0 && ', '}
                    <code>{`{{${t}}}`}</code>
                  </span>
                ))}
                .
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={createAutoRule}
                disabled={hasUnknownReplyTokens}
                title={hasUnknownReplyTokens ? 'Fix the unknown merge tokens before saving.' : undefined}
                className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
              >
                Save
              </button>
              <button onClick={() => { setShowAutoForm(false); setAutoFormError(null); }} className="px-4 py-2 text-muted text-sm hover:text-heading">Cancel</button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {autoRules.map(rule => (
            <div key={rule.id} className="flex items-center justify-between bg-surface-secondary rounded-lg p-3">
              <div>
                <span className="text-sm font-medium text-heading">{rule.name}</span>
                <span className="ml-2 inline-flex">
                  <SharedStatusBadge
                    tone={rule.enabled ? 'success' : 'neutral'}
                    icon={rule.enabled
                      ? <CheckCircle className="h-3 w-3" aria-hidden="true" />
                      : <XCircle className="h-3 w-3" aria-hidden="true" />
                    }
                    tooltip={rule.enabled
                      ? 'Automation rule is active and replying to matching messages'
                      : 'Automation rule is disabled — turn it on to start replying'
                    }
                    className="text-[10px]"
                  >
                    {rule.enabled ? 'Active' : 'Disabled'}
                  </SharedStatusBadge>
                </span>
                <p className="text-xs text-muted mt-0.5">
                  {rule.ruleType === 'keyword' ? `Keyword: "${rule.keyword}"` : 'Business hours rule'}
                  {' — '}{rule.replyBody.slice(0, 60)}{rule.replyBody.length > 60 ? '...' : ''}
                </p>
              </div>
              {isManager && (
                <button onClick={() => deleteAutoRule(rule.id)} className="p-1.5 text-muted hover:text-red-500 dark:hover:text-red-400">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {autoRules.length === 0 && (
            <EmptyState
              icon={Zap}
              title="No auto-reply rules configured"
              description="Set up rules to automatically respond to common inbound messages like keywords or after-hours pings."
              primaryAction={isManager ? { label: 'New Rule', icon: Plus, onClick: () => setShowAutoForm(true) } : undefined}
              variant="compact"
            />
          )}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-heading flex items-center gap-2"><Users className="h-5 w-5 text-primary" /> Assignment Rules</h2>
          {isManager && (
            <button onClick={() => setShowAssignForm(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-white text-sm rounded-lg hover:bg-primary/90">
              <Plus className="h-4 w-4" /> New Rule
            </button>
          )}
        </div>

        {showAssignForm && (
          <div className="bg-surface-secondary rounded-lg p-4 mb-4 space-y-3">
            <input type="text" value={assignForm.name} onChange={e => setAssignForm(f => ({ ...f, name: e.target.value }))} placeholder="Rule name" className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm" />
            <div className="grid grid-cols-3 gap-3">
              <select value={assignForm.matchField} onChange={e => setAssignForm(f => ({ ...f, matchField: e.target.value }))} className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm">
                <option value="keyword">Keyword</option>
                <option value="remote_number">Phone Number</option>
                <option value="phone_number_id">Phone Line</option>
                <option value="location">Location</option>
              </select>
              <input type="text" value={assignForm.matchValue} onChange={e => setAssignForm(f => ({ ...f, matchValue: e.target.value }))} placeholder="Match value" className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm" />
              <input type="text" value={assignForm.assignToTeam} onChange={e => setAssignForm(f => ({ ...f, assignToTeam: e.target.value }))} placeholder="Assign to team" className="px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm" />
            </div>
            <div className="flex gap-2">
              <button onClick={createAssignRule} className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary/90">Save</button>
              <button onClick={() => setShowAssignForm(false)} className="px-4 py-2 text-muted text-sm hover:text-heading">Cancel</button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {assignRules.map(rule => (
            <div key={rule.id} className="flex items-center justify-between bg-surface-secondary rounded-lg p-3">
              <div>
                <span className="text-sm font-medium text-heading">{rule.name}</span>
                <p className="text-xs text-muted mt-0.5">
                  When {rule.matchField} matches "{rule.matchValue}" &rarr; Assign to {rule.assignToTeam || rule.assignToUserId || 'unassigned'}
                </p>
              </div>
              {isManager && (
                <button onClick={() => deleteAssignRule(rule.id)} className="p-1.5 text-muted hover:text-red-500 dark:hover:text-red-400">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {assignRules.length === 0 && (
            <EmptyState
              icon={Users}
              title="No assignment rules configured"
              description="Route incoming conversations to the right team or agent based on keywords, phone line, or location."
              primaryAction={isManager ? { label: 'New Rule', icon: Plus, onClick: () => setShowAssignForm(true) } : undefined}
              variant="compact"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function AnalyticsView({ analytics, loadAnalytics }: { analytics: Analytics | null; loadAnalytics: () => void }) {
  useEffect(() => { loadAnalytics(); }, []);

  if (!analytics) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6">
        <SkeletonRows count={5} rowClassName="h-16" />
      </div>
    );
  }

  const statCards = [
    { label: 'Total Conversations', value: analytics.conversationVolume.total, icon: MessageSquare, color: 'text-blue-500 dark:text-blue-400' },
    { label: 'Open', value: analytics.conversationVolume.open, icon: Inbox, color: 'text-green-500 dark:text-green-400' },
    { label: 'Escalated', value: analytics.conversationVolume.escalated, icon: AlertTriangle, color: 'text-red-500 dark:text-red-400' },
    { label: 'Messages Sent', value: analytics.messageStats.totalSent, icon: Send, color: 'text-primary' },
    { label: 'Messages Received', value: analytics.messageStats.totalReceived, icon: ArrowUpRight, color: 'text-purple-500 dark:text-purple-400' },
    { label: 'Delivered', value: analytics.messageStats.delivered, icon: CheckCircle, color: 'text-green-500 dark:text-green-400' },
    { label: 'Failed', value: analytics.messageStats.failed, icon: XCircle, color: 'text-red-500 dark:text-red-400' },
    { label: 'Avg Response (min)', value: analytics.avgResponseTimeMinutes ?? 'N/A', icon: Clock, color: 'text-yellow-500 dark:text-yellow-400' },
    { label: 'Avg Resolution (min)', value: analytics.avgResolutionTimeMinutes ?? 'N/A', icon: CheckCircle, color: 'text-teal-500 dark:text-teal-400' },
    { label: 'Opt-out Rate', value: analytics.optOutRate !== null ? `${analytics.optOutRate}%` : 'N/A', icon: XCircle, color: 'text-orange-500 dark:text-orange-400' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-heading flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" /> SMS Analytics
        </h2>
        <button onClick={loadAnalytics} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted hover:text-heading">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {statCards.map((card, i) => {
          const Icon = card.icon;
          return (
            <div key={i} className="bg-surface border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`h-4 w-4 ${card.color}`} />
                <span className="text-xs text-muted">{card.label}</span>
              </div>
              <p className="text-xl font-bold text-heading">{card.value}</p>
            </div>
          );
        })}
      </div>

      {analytics.agentProductivity.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="text-sm font-semibold text-heading mb-3">Agent Productivity</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 text-muted font-medium">Agent</th>
                  <th className="text-right py-2 text-muted font-medium">Messages Sent</th>
                  <th className="text-right py-2 text-muted font-medium">Conversations</th>
                </tr>
              </thead>
              <tbody>
                {analytics.agentProductivity.map(agent => (
                  <tr key={agent.userId} className="border-b border-border">
                    <td className="py-2 text-heading">{agent.userId}</td>
                    <td className="py-2 text-right text-heading">{agent.sent}</td>
                    <td className="py-2 text-right text-heading">{agent.conversations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function AdminView({ isManager }: { isManager: boolean }) {
  const [consentPhone, setConsentPhone] = useState('');
  const [consentHistory, setConsentHistory] = useState<Array<{ action: string; keyword: string | null; source: string; createdAt: string }>>([]);
  const [loadingConsent, setLoadingConsent] = useState(false);

  const searchConsent = async () => {
    if (!consentPhone.trim()) return;
    setLoadingConsent(true);
    try {
      const data = await api.get<{ history: typeof consentHistory }>(`/sms-inbox/consent/${encodeURIComponent(consentPhone)}`);
      setConsentHistory(data.history);
    } catch {} finally { setLoadingConsent(false); }
  };

  if (!isManager) {
    return (
      <div className="bg-surface border border-border rounded-xl p-8 text-center">
        <Settings className="h-10 w-10 mx-auto mb-3 text-muted opacity-40" />
        <p className="text-muted">Admin access required</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-surface border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold text-heading mb-4 flex items-center gap-2">
          <Settings className="h-5 w-5 text-primary" /> Compliance & Consent
        </h2>

        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium text-heading mb-2">STOP/HELP Processing</h3>
            <p className="text-xs text-muted mb-2">
              The system automatically processes STOP, UNSUBSCRIBE, CANCEL, QUIT, END keywords from inbound messages.
              Numbers that send these keywords are added to the Do Not Contact list and a consent record is created.
              HELP keyword responses are handled via auto-reply rules.
            </p>
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-medium text-heading mb-2">Consent History Lookup</h3>
            <div className="flex gap-2">
              <input
                type="text"
                value={consentPhone}
                onChange={e => setConsentPhone(e.target.value)}
                placeholder="Phone number (e.g. +15551234567)"
                className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none"
              />
              <button onClick={searchConsent} disabled={loadingConsent} className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary/90 disabled:opacity-50">
                Search
              </button>
            </div>
            {consentHistory.length > 0 && (
              <div className="mt-3 space-y-1">
                {consentHistory.map((entry, i) => (
                  <div key={i} className="flex items-center gap-3 bg-surface-secondary rounded p-2 text-xs">
                    <span className={`font-medium ${entry.action === 'opt_out' ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                      {entry.action === 'opt_out' ? 'Opted Out' : 'Opted In'}
                    </span>
                    {entry.keyword && <span className="text-muted">Keyword: {entry.keyword}</span>}
                    <span className="text-muted">Source: {entry.source}</span>
                    <span className="text-muted ml-auto">{new Date(entry.createdAt).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
            {consentHistory.length === 0 && consentPhone && !loadingConsent && (
              <div className="mt-2">
                <EmptyState
                  icon={Search}
                  title="No consent records found"
                  description="We don't have any opt-in or opt-out history for this number."
                  variant="compact"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Format a deferred-until ISO timestamp for the inbox badge. We keep
// it short (e.g. "Mon 8:00 AM") because the badge sits in a dense row
// alongside status, priority, and a relative timestamp. If parsing
// fails for any reason, fall back to the raw ISO so the operator
// still has *something* to act on.
function formatDeferredUntil(iso: string | null): string {
  if (!iso) return 'next quiet-hours window';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  const day = date.toLocaleDateString(undefined, { weekday: 'short' });
  return `${day} ${time}`;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString();
}
