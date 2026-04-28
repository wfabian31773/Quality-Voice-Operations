import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Inbox, Mail, Building2, Phone, ExternalLink, Calendar, RefreshCw,
  CheckCircle, X as XIcon, Search, Filter, ChevronDown, ChevronRight,
  CalendarCheck, CalendarX, CalendarClock, MailCheck, UserCheck, FileText,
  Download, Bell, Settings, Plus, Trash2,
  History, Sparkles, MessageSquare, Send, AlertTriangle,
  Users, ArrowUp, ArrowDown,
} from 'lucide-react';
import { api, getToken } from '../lib/api';
import GlobalScopeBanner from '../components/GlobalScopeBanner';
import { ErrorState, Skeleton } from '../components/state';
import { PageHeader, StatCard } from '../components/ui';
import Modal from '../components/Modal';

type LeadSource = 'book_demo' | 'roi_calculator' | 'contact';
type LeadStatus = 'new' | 'contacted' | 'closed';
type BookingStatusFilter = 'all' | 'booked' | 'no_booking' | 'cancelled';
type SourceFilter = 'all' | LeadSource;
type StatusFilter = 'all' | LeadStatus;

interface BookingPayload {
  provider?: string;
  eventType?: 'created' | 'rescheduled' | 'cancelled';
  bookingId?: string | number | null;
  bookingUid?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  timezone?: string | null;
  attendeeEmail?: string | null;
  attendeeName?: string | null;
  meetingUrl?: string | null;
  rescheduleUrl?: string | null;
  cancelUrl?: string | null;
  title?: string | null;
  recordedAt?: string | null;
}

interface MarketingLead {
  id: number;
  source: LeadSource;
  name: string | null;
  email: string;
  company: string | null;
  phone: string | null;
  payload: Record<string, unknown> & {
    booking?: BookingPayload;
    bookingHistory?: BookingPayload[];
    teamSize?: string;
    preferredTime?: string;
    useCase?: string;
    message?: string;
  };
  notified: boolean;
  status: LeadStatus;
  status_notes: string | null;
  status_updated_at: string | null;
  status_updated_by: string | null;
  created_at: string;
  /** Distinct teammates (by author email/identifier) that have logged an
   *  event on this lead. Populated by the server's LATERAL aggregate; safe
   *  to default to an empty array on older responses. */
  event_authors?: string[];
  last_event_at?: string | null;
  last_event_author?: string | null;
}

type LeadSortField = 'created_at' | 'last_activity';
type LeadSortOrder = 'asc' | 'desc';

interface LeadEvent {
  id: number;
  lead_id: number;
  event_type: 'created' | 'status_change' | 'note';
  previous_status: LeadStatus | null;
  new_status: LeadStatus | null;
  notes: string | null;
  author: string | null;
  created_at: string;
}

interface LeadListResponse {
  leads: MarketingLead[];
  total: number;
  page: number;
  limit: number;
  offset: number;
  counts: {
    by_status: Record<LeadStatus, number>;
    by_source: Record<LeadSource, number>;
    by_booking: Record<'booked' | 'cancelled' | 'no_booking', number>;
    total: number;
  };
}

interface SalesAlertSettings {
  channels: { email: boolean; slack: boolean };
  emailRecipients: string[];
  slackWebhookUrl: string | null;
  notifyOnNewLead: boolean;
  notifyOnBookingCreated: boolean;
  notifyOnBookingRescheduled: boolean;
  notifyOnBookingCancelled: boolean;
}

interface SalesAlertSettingsResponse {
  settings: SalesAlertSettings;
  fallbacks: { envEmail: string | null; envSlackConfigured: boolean };
}

type AlertChannelStatus = 'sent' | 'skipped' | 'failed';

interface TestAlertResponse {
  email: AlertChannelStatus;
  slack: AlertChannelStatus;
  emailError?: string;
  slackError?: string;
  error?: string;
}

const SOURCE_LABELS: Record<LeadSource, string> = {
  book_demo: 'Book a Demo',
  roi_calculator: 'ROI Calculator',
  contact: 'Contact',
};

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  closed: 'Closed',
};

const STATUS_COLORS: Record<LeadStatus, string> = {
  new: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  contacted: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  closed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
};

function getBookingState(lead: MarketingLead): 'booked' | 'cancelled' | 'no_booking' {
  const booking = lead.payload?.booking;
  if (!booking) return 'no_booking';
  if (booking.eventType === 'cancelled') return 'cancelled';
  return 'booked';
}

function formatDateTime(value: string | null | undefined, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return '—';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, options ?? {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    const then = new Date(value).getTime();
    if (Number.isNaN(then)) return value;
    const diff = Date.now() - then;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.round(hr / 24);
    if (d < 14) return `${d}d ago`;
    return new Date(value).toLocaleDateString();
  } catch {
    return value;
  }
}

const SOURCE_VALUES: readonly SourceFilter[] = ['all', 'book_demo', 'roi_calculator', 'contact'];
const BOOKING_VALUES: readonly BookingStatusFilter[] = ['all', 'booked', 'no_booking', 'cancelled'];
const STATUS_VALUES: readonly StatusFilter[] = ['all', 'new', 'contacted', 'closed'];
const SORT_VALUES: readonly LeadSortField[] = ['created_at', 'last_activity'];
const ORDER_VALUES: readonly LeadSortOrder[] = ['asc', 'desc'];

function parseEnumParam<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (!raw) return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function parsePositiveIntParam(raw: string | null): string {
  if (!raw) return '';
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

export default function AdminSalesInbox() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [source, setSource] = useState<SourceFilter>(() =>
    parseEnumParam<SourceFilter>(searchParams.get('source'), SOURCE_VALUES, 'all'),
  );
  const [booking, setBooking] = useState<BookingStatusFilter>(() =>
    parseEnumParam<BookingStatusFilter>(searchParams.get('booking'), BOOKING_VALUES, 'all'),
  );
  const [status, setStatus] = useState<StatusFilter>(() =>
    parseEnumParam<StatusFilter>(searchParams.get('status'), STATUS_VALUES, 'all'),
  );
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '');
  const [actedOnBy, setActedOnBy] = useState(() => searchParams.get('actedOnBy') ?? '');
  const [inactiveDays, setInactiveDays] = useState(() =>
    parsePositiveIntParam(searchParams.get('inactiveDays')),
  );
  const [sort, setSort] = useState<LeadSortField>(() =>
    parseEnumParam<LeadSortField>(searchParams.get('sort'), SORT_VALUES, 'created_at'),
  );
  const [order, setOrder] = useState<LeadSortOrder>(() =>
    parseEnumParam<LeadSortOrder>(searchParams.get('order'), ORDER_VALUES, 'desc'),
  );
  const [page, setPage] = useState(() => {
    const n = parseInt(searchParams.get('page') ?? '1', 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  });
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [notesDraft, setNotesDraft] = useState<Record<number, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Persist the active filter set in the URL so reloads, back/forward
  // navigation, and shared links all restore the same view. We use { replace:
  // true } to avoid pushing a new history entry every keystroke. Defaults
  // (created_at / desc) are omitted so the URL stays clean for the common
  // "newest first" view.
  useEffect(() => {
    const next = new URLSearchParams();
    if (source !== 'all') next.set('source', source);
    if (booking !== 'all') next.set('booking', booking);
    if (status !== 'all') next.set('status', status);
    const trimmedSearch = search.trim();
    if (trimmedSearch) next.set('q', trimmedSearch);
    const trimmedActedOnBy = actedOnBy.trim();
    if (trimmedActedOnBy) next.set('actedOnBy', trimmedActedOnBy);
    const trimmedInactive = inactiveDays.trim();
    if (trimmedInactive) next.set('inactiveDays', trimmedInactive);
    if (sort !== 'created_at') next.set('sort', sort);
    if (order !== 'desc') next.set('order', order);
    if (page > 1) next.set('page', String(page));
    setSearchParams(next, { replace: true });
  }, [source, booking, status, search, actedOnBy, inactiveDays, sort, order, page, setSearchParams]);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const limit = 25;

  // Auto-expand a lead when arriving via the deep link in alert emails / Slack
  // messages (e.g. /admin/sales-inbox#lead-42).
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith('#lead-')) return;
    const id = parseInt(hash.slice('#lead-'.length), 10);
    if (Number.isFinite(id) && id > 0) setExpandedId(id);
  }, []);

  // List of authors that have ever touched a lead — powers the "Acted on by"
  // dropdown so reps can quickly pick a teammate without remembering their
  // exact email. The endpoint is cheap (DISTINCT scan over a small table) so
  // we just refresh on a long interval.
  const { data: authorsData } = useQuery<{ authors: string[] }>({
    queryKey: ['marketing-lead-authors'],
    queryFn: () => api.get<{ authors: string[] }>('/platform/marketing-lead-authors'),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  const knownAuthors = authorsData?.authors ?? [];

  const queryKey = [
    'marketing-leads',
    { source, booking, status, search, actedOnBy, inactiveDays, sort, order, page },
  ];
  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<LeadListResponse>({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams();
      if (source !== 'all') params.set('source', source);
      if (booking !== 'all') params.set('booking', booking);
      if (status !== 'all') params.set('status', status);
      if (search.trim()) params.set('q', search.trim());
      if (actedOnBy.trim()) params.set('actedOnBy', actedOnBy.trim());
      if (inactiveDays.trim()) {
        const n = parseInt(inactiveDays.trim(), 10);
        if (Number.isFinite(n) && n > 0) params.set('inactiveDays', String(n));
      }
      // Only include sort/order when they differ from the server defaults
      // so the URL stays clean for the common case.
      if (sort !== 'created_at') params.set('sort', sort);
      if (order !== 'desc') params.set('order', order);
      params.set('page', String(page));
      params.set('limit', String(limit));
      return api.get<LeadListResponse>(`/platform/marketing-leads?${params.toString()}`);
    },
    refetchInterval: 30_000,
  });

  // Click-to-sort: clicking the same column toggles asc/desc; clicking a new
  // column resets to the column's natural default direction (most-recent first).
  const handleSortClick = (field: LeadSortField) => {
    if (sort === field) {
      setOrder((o) => (o === 'desc' ? 'asc' : 'desc'));
    } else {
      setSort(field);
      setOrder('desc');
    }
    setPage(1);
  };

  const updateMutation = useMutation({
    mutationFn: (vars: { id: number; status: LeadStatus; notes?: string }) =>
      api.patch<{ lead: MarketingLead }>(`/platform/marketing-leads/${vars.id}`, {
        status: vars.status,
        notes: vars.notes,
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['marketing-leads'] });
      queryClient.invalidateQueries({ queryKey: ['marketing-lead-events', vars.id] });
    },
  });

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.total / limit));
  }, [data]);

  const counts = data?.counts;

  const onFilterChange = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(1);
  };

  const handleExportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const params = new URLSearchParams();
      if (source !== 'all') params.set('source', source);
      if (booking !== 'all') params.set('booking', booking);
      if (status !== 'all') params.set('status', status);
      if (search.trim()) params.set('q', search.trim());
      if (actedOnBy.trim()) params.set('actedOnBy', actedOnBy.trim());
      if (inactiveDays.trim()) {
        const n = parseInt(inactiveDays.trim(), 10);
        if (Number.isFinite(n) && n > 0) params.set('inactiveDays', String(n));
      }

      const token = getToken();
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const qs = params.toString();
      const res = await fetch(`/api/platform/marketing-leads.csv${qs ? `?${qs}` : ''}`, {
        headers,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();

      const cd = res.headers.get('content-disposition') ?? '';
      const match = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
      const filename = match?.[1] ?? `sales-inbox-${new Date().toISOString().slice(0, 10)}.csv`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <GlobalScopeBanner
        label="Sales Inbox"
        description="Triage marketing leads from Book a Demo, ROI Calculator, and Contact submissions. Includes Cal.com booking metadata."
      />

      <PageHeader
        icon={<Inbox className="h-5 w-5" />}
        title="Sales Inbox"
        description={
          counts
            ? `${counts.total} total leads • ${counts.by_status.new} new, ${counts.by_status.contacted} contacted, ${counts.by_status.closed} closed`
            : 'Loading…'
        }
        actions={
          <>
            <button
              onClick={handleExportCsv}
              disabled={exporting}
              title="Download the current filtered view as a CSV file"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
            >
              <Download className={clsx('h-4 w-4', exporting && 'animate-pulse')} />
              {exporting ? 'Preparing CSV…' : 'Download CSV'}
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-medium hover:bg-surface-hover transition-colors"
              title="Configure where new-lead alerts are sent"
            >
              <Bell className="h-4 w-4" />
              Alert settings
            </button>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm font-medium hover:bg-surface-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw className={clsx('h-4 w-4', isFetching && 'animate-spin')} />
              Refresh
            </button>
          </>
        }
      />

      {exportError && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm">
          Export failed: {exportError}
        </div>
      )}

      {settingsOpen && (
        <SalesAlertSettingsModal onClose={() => setSettingsOpen(false)} />
      )}

      {counts && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Booked" value={counts.by_booking.booked} icon={CalendarCheck} tone="success" />
          <StatCard label="No booking" value={counts.by_booking.no_booking} icon={CalendarClock} tone="warning" />
          <StatCard label="Cancelled" value={counts.by_booking.cancelled} icon={CalendarX} tone="danger" />
          <StatCard label="Demo requests" value={counts.by_source.book_demo} icon={Calendar} tone="accent" />
          <StatCard label="ROI requests" value={counts.by_source.roi_calculator} icon={FileText} tone="info" />
          <StatCard label="Contact" value={counts.by_source.contact} icon={Mail} tone="neutral" />
        </div>
      )}

      <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <Filter className="h-4 w-4" />
          <span className="font-semibold">Filters</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
          <FilterGroup
            label="Source"
            value={source}
            onChange={onFilterChange<SourceFilter>(setSource)}
            options={[
              { value: 'all', label: 'All sources' },
              { value: 'book_demo', label: 'Book a Demo' },
              { value: 'roi_calculator', label: 'ROI Calculator' },
              { value: 'contact', label: 'Contact' },
            ]}
          />
          <FilterGroup
            label="Booking"
            value={booking}
            onChange={onFilterChange<BookingStatusFilter>(setBooking)}
            options={[
              { value: 'all', label: 'Any booking status' },
              { value: 'booked', label: 'Booked' },
              { value: 'no_booking', label: 'No booking' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
          />
          <FilterGroup
            label="Triage status"
            value={status}
            onChange={onFilterChange<StatusFilter>(setStatus)}
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'new', label: 'New' },
              { value: 'contacted', label: 'Contacted' },
              { value: 'closed', label: 'Closed' },
            ]}
          />
          <div>
            <label
              htmlFor="lead-acted-on-by"
              className="block text-xs font-medium text-slate-400 mb-1"
              title="Show leads with at least one triage action by this teammate"
            >
              Acted on by
            </label>
            <div className="relative">
              <UserCheck className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                id="lead-acted-on-by"
                type="search"
                list="lead-acted-on-by-options"
                value={actedOnBy}
                onChange={(e) => { setActedOnBy(e.target.value); setPage(1); }}
                placeholder="Anyone"
                className="w-full pl-8 pr-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <datalist id="lead-acted-on-by-options">
                {knownAuthors.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </div>
          </div>
          <div>
            <label
              htmlFor="lead-inactive-days"
              className="block text-xs font-medium text-slate-400 mb-1"
              title="Highlight leads with no events recorded in the last N days"
            >
              Inactive for (days)
            </label>
            <div className="relative">
              <CalendarClock className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                id="lead-inactive-days"
                type="number"
                min={1}
                step={1}
                value={inactiveDays}
                onChange={(e) => {
                  // Strip negatives / decimals so we always pass a positive
                  // integer to the API (or an empty string to disable).
                  const raw = e.target.value;
                  if (raw === '') {
                    setInactiveDays('');
                  } else {
                    const n = parseInt(raw, 10);
                    setInactiveDays(Number.isFinite(n) && n > 0 ? String(n) : '');
                  }
                  setPage(1);
                }}
                placeholder="e.g. 7"
                className="w-full pl-8 pr-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
          </div>
          <div>
            <label htmlFor="lead-search" className="block text-xs font-medium text-slate-400 mb-1">Search</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input
                id="lead-search"
                type="search"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Email, name, or company"
                className="w-full pl-8 pr-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
          </div>
        </div>
      </div>

      {isError && (
        <ErrorState
          variant="inline"
          title="Failed to load leads"
          error={error}
          onRetry={() => refetch()}
        />
      )}

      <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-800/60 text-slate-300 text-xs uppercase tracking-wider">
            <tr>
              <th className="px-3 py-3 text-left w-8" />
              <th className="px-3 py-3 text-left">Lead</th>
              <th className="px-3 py-3 text-left">Source</th>
              <th className="px-3 py-3 text-left">Booking</th>
              <th className="px-3 py-3 text-left">
                <SortableHeader
                  label="Submitted"
                  field="created_at"
                  activeField={sort}
                  activeOrder={order}
                  onClick={handleSortClick}
                />
              </th>
              <th className="px-3 py-3 text-left">
                <SortableHeader
                  label="Owners"
                  field="last_activity"
                  activeField={sort}
                  activeOrder={order}
                  onClick={handleSortClick}
                  hint="Distinct teammates that have touched this lead. Click to sort by most recent activity."
                />
              </th>
              <th className="px-3 py-3 text-left">Status</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {isLoading && (
              <tr><td colSpan={8} className="px-3 py-3"><Skeleton className="h-10 w-full" /></td></tr>
            )}
            {!isLoading && data && data.leads.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-12 text-center text-slate-400">
                No leads match the current filters.
              </td></tr>
            )}
            {!isLoading && data && data.leads.map((lead) => (
              <Fragment key={lead.id}>
                <LeadRow
                  lead={lead}
                  expanded={expandedId === lead.id}
                  onToggle={() => setExpandedId(expandedId === lead.id ? null : lead.id)}
                  onMark={(next) => updateMutation.mutate({ id: lead.id, status: next })}
                  pending={updateMutation.isPending && updateMutation.variables?.id === lead.id}
                />
                {expandedId === lead.id && (
                  <LeadDetail
                    lead={lead}
                    notesDraft={notesDraft[lead.id] ?? lead.status_notes ?? ''}
                    onNotesChange={(v) => setNotesDraft({ ...notesDraft, [lead.id]: v })}
                    onSaveNotes={() => updateMutation.mutate({
                      id: lead.id,
                      status: lead.status,
                      notes: notesDraft[lead.id] ?? lead.status_notes ?? '',
                    })}
                    saving={updateMutation.isPending && updateMutation.variables?.id === lead.id}
                    expanded={expandedId === lead.id}
                  />
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.total > limit && (
        <div className="flex items-center justify-between text-sm text-slate-400">
          <span>
            Showing {(data.offset ?? 0) + 1}–{Math.min((data.offset ?? 0) + data.leads.length, data.total)} of {data.total}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-slate-300">Page {page} / {totalPages}</span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface FilterGroupProps<T extends string> {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}

/**
 * Clickable column header that drives the table sort. Renders an arrow when
 * the column is the currently-active sort, and is purely a styling/UX wrapper
 * around the parent's `onClick` handler — sort state lives upstream.
 */
function SortableHeader({
  label,
  field,
  activeField,
  activeOrder,
  onClick,
  hint,
}: {
  label: string;
  field: LeadSortField;
  activeField: LeadSortField;
  activeOrder: LeadSortOrder;
  onClick: (field: LeadSortField) => void;
  hint?: string;
}) {
  const active = activeField === field;
  return (
    <button
      type="button"
      onClick={() => onClick(field)}
      title={hint ?? `Sort by ${label.toLowerCase()}`}
      aria-label={`Sort by ${label}`}
      aria-sort={active ? (activeOrder === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={clsx(
        'inline-flex items-center gap-1 uppercase tracking-wider text-xs font-semibold hover:text-white transition-colors',
        active ? 'text-white' : 'text-slate-300',
      )}
    >
      {label}
      {active ? (
        activeOrder === 'asc'
          ? <ArrowUp className="h-3 w-3" />
          : <ArrowDown className="h-3 w-3" />
      ) : (
        <ArrowDown className="h-3 w-3 opacity-30" />
      )}
    </button>
  );
}

/**
 * Renders the per-lead "Owners" column: an avatar stack of distinct event
 * authors plus a one-line "last touched by …" caption. When no teammate has
 * acted on the lead yet (only the synthetic `created` event exists) we show
 * a muted "Unworked" hint so reps can spot fresh leads at a glance.
 */
function OwnersCell({ lead }: { lead: MarketingLead }) {
  const authors = lead.event_authors ?? [];
  const lastAuthor = lead.last_event_author ?? null;
  const lastAt = lead.last_event_at ?? null;

  if (authors.length === 0 && !lastAuthor) {
    return (
      <div className="text-xs text-slate-500 inline-flex items-center gap-1.5">
        <Users className="h-3 w-3" />
        Unworked
      </div>
    );
  }

  // Show up to 3 avatars inline; collapse the rest into a "+N" pill so wide
  // teams don't blow out the column width.
  const MAX_AVATARS = 3;
  const visible = authors.slice(0, MAX_AVATARS);
  const overflow = Math.max(0, authors.length - MAX_AVATARS);

  return (
    <div className="space-y-1">
      <div className="flex items-center -space-x-1.5">
        {visible.map((author) => (
          <AuthorAvatar key={author} author={author} highlighted={author === lastAuthor} />
        ))}
        {overflow > 0 && (
          <span
            className="inline-flex items-center justify-center h-6 min-w-[1.5rem] px-1.5 rounded-full bg-slate-700 text-slate-200 text-[10px] font-medium border border-slate-900 ring-1 ring-slate-700"
            title={authors.slice(MAX_AVATARS).join(', ')}
          >
            +{overflow}
          </span>
        )}
      </div>
      {lastAuthor && (
        <div className="text-[11px] text-slate-400 truncate" title={`Last touched by ${lastAuthor}${lastAt ? ` at ${formatDateTime(lastAt)}` : ''}`}>
          <span className="text-slate-200">{lastAuthor}</span>
          {lastAt && (
            <span className="text-slate-500"> · {formatRelative(lastAt)}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Hashes the author string to a stable accent colour and renders their
 * initials in a small avatar pill. The author identifier is usually an
 * email — we extract the part before `@` for initials but keep the full
 * string in the tooltip.
 */
function AuthorAvatar({ author, highlighted }: { author: string; highlighted: boolean }) {
  const initials = getInitials(author);
  const colour = pickAvatarColour(author);
  return (
    <span
      title={author}
      className={clsx(
        'inline-flex items-center justify-center h-6 w-6 rounded-full text-[10px] font-semibold uppercase border border-slate-900 ring-1',
        colour,
        highlighted ? 'ring-purple-400' : 'ring-slate-700',
      )}
    >
      {initials}
    </span>
  );
}

function getInitials(author: string): string {
  const local = author.split('@')[0] ?? author;
  // Split on common separators (".", "_", "-", " ") and take the first
  // letter of up to two segments, e.g. "alice.jones" -> "AJ".
  const parts = local.split(/[._\-\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase() || '??';
}

const AVATAR_PALETTE = [
  'bg-purple-500/30 text-purple-100',
  'bg-blue-500/30 text-blue-100',
  'bg-emerald-500/30 text-emerald-100',
  'bg-amber-500/30 text-amber-100',
  'bg-rose-500/30 text-rose-100',
  'bg-sky-500/30 text-sky-100',
  'bg-fuchsia-500/30 text-fuchsia-100',
  'bg-teal-500/30 text-teal-100',
] as const;

function pickAvatarColour(author: string): string {
  let hash = 0;
  for (let i = 0; i < author.length; i += 1) {
    hash = (hash * 31 + author.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function FilterGroup<T extends string>({ label, value, onChange, options }: FilterGroupProps<T>) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

function LeadRow({
  lead,
  expanded,
  onToggle,
  onMark,
  pending,
}: {
  lead: MarketingLead;
  expanded: boolean;
  onToggle: () => void;
  onMark: (next: LeadStatus) => void;
  pending: boolean;
}) {
  const booking = lead.payload?.booking;
  const bookingState = getBookingState(lead);
  return (
    <tr id={`lead-${lead.id}`} className="hover:bg-slate-800/30 scroll-mt-24">
      <td className="px-3 py-3 align-top">
        <button
          onClick={onToggle}
          aria-label={expanded ? 'Collapse lead' : 'Expand lead'}
          className="text-slate-400 hover:text-white"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </td>
      <td className="px-3 py-3 align-top">
        <div className="font-medium text-white">{lead.name || '(no name)'}</div>
        <div className="text-xs text-slate-400 flex items-center gap-1.5 mt-0.5">
          <Mail className="h-3 w-3" />
          <a href={`mailto:${lead.email}`} className="hover:text-purple-300 truncate">{lead.email}</a>
        </div>
        {lead.company && (
          <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
            <Building2 className="h-3 w-3" />
            {lead.company}
          </div>
        )}
        {lead.phone && (
          <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
            <Phone className="h-3 w-3" />
            {lead.phone}
          </div>
        )}
      </td>
      <td className="px-3 py-3 align-top">
        <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-slate-700/60 text-slate-200">
          {SOURCE_LABELS[lead.source]}
        </span>
      </td>
      <td className="px-3 py-3 align-top">
        {bookingState === 'no_booking' && (
          <span className="text-xs text-slate-400 inline-flex items-center gap-1">
            <CalendarClock className="h-3 w-3" /> No booking yet
          </span>
        )}
        {bookingState === 'booked' && booking && (
          <div className="space-y-0.5">
            <div className="text-xs text-emerald-300 inline-flex items-center gap-1">
              <CalendarCheck className="h-3 w-3" />
              {booking.eventType === 'rescheduled' ? 'Rescheduled' : 'Booked'}
            </div>
            <div className="text-xs text-slate-200">
              {formatDateTime(booking.startTime)}
              {booking.timezone ? <span className="text-slate-500"> · {booking.timezone}</span> : null}
            </div>
            {booking.meetingUrl && (
              <a
                href={booking.meetingUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-purple-300 hover:underline inline-flex items-center gap-1"
              >
                Meeting link <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
        {bookingState === 'cancelled' && booking && (
          <div className="space-y-0.5">
            <div className="text-xs text-rose-300 inline-flex items-center gap-1">
              <CalendarX className="h-3 w-3" /> Cancelled
            </div>
            {booking.startTime && (
              <div className="text-xs text-slate-400 line-through">
                {formatDateTime(booking.startTime)}
              </div>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-3 align-top text-xs text-slate-400">
        <div className="text-slate-200">{formatRelative(lead.created_at)}</div>
        <div className="text-slate-500">{formatDateTime(lead.created_at)}</div>
      </td>
      <td className="px-3 py-3 align-top">
        <OwnersCell lead={lead} />
      </td>
      <td className="px-3 py-3 align-top">
        <span className={clsx('inline-block px-2 py-0.5 rounded border text-xs font-medium', STATUS_COLORS[lead.status])}>
          {STATUS_LABELS[lead.status]}
        </span>
        {lead.status_updated_by && lead.status !== 'new' && (
          <div className="text-[10px] text-slate-500 mt-1">
            by {lead.status_updated_by}
            {lead.status_updated_at ? ` · ${formatRelative(lead.status_updated_at)}` : ''}
          </div>
        )}
      </td>
      <td className="px-3 py-3 align-top text-right">
        <div className="inline-flex items-center gap-1">
          {lead.status !== 'contacted' && (
            <button
              onClick={() => onMark('contacted')}
              disabled={pending}
              title="Mark as contacted"
              className="p-1.5 rounded bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 disabled:opacity-50"
            >
              <UserCheck className="h-4 w-4" />
            </button>
          )}
          {lead.status !== 'closed' && (
            <button
              onClick={() => onMark('closed')}
              disabled={pending}
              title="Mark as closed"
              className="p-1.5 rounded bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              <CheckCircle className="h-4 w-4" />
            </button>
          )}
          {lead.status !== 'new' && (
            <button
              onClick={() => onMark('new')}
              disabled={pending}
              title="Reset to new"
              className="p-1.5 rounded bg-slate-700/60 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            >
              <XIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function LeadDetail({
  lead,
  notesDraft,
  onNotesChange,
  onSaveNotes,
  saving,
  expanded,
}: {
  lead: MarketingLead;
  notesDraft: string;
  onNotesChange: (v: string) => void;
  onSaveNotes: () => void;
  saving: boolean;
  expanded: boolean;
}) {
  const booking = lead.payload?.booking;
  const history = Array.isArray(lead.payload?.bookingHistory) ? lead.payload!.bookingHistory! : [];
  const teamSize = typeof lead.payload?.teamSize === 'string' ? lead.payload.teamSize : null;
  const preferredTime = typeof lead.payload?.preferredTime === 'string' ? lead.payload.preferredTime : null;
  const eventsQuery = useQuery<{ events: LeadEvent[] }>({
    queryKey: ['marketing-lead-events', lead.id],
    queryFn: () => api.get<{ events: LeadEvent[] }>(`/platform/marketing-leads/${lead.id}/events`),
    enabled: expanded,
  });
  const useCase = typeof lead.payload?.useCase === 'string' ? lead.payload.useCase : null;
  const message = typeof lead.payload?.message === 'string' ? lead.payload.message : null;

  return (
    <tr className="bg-slate-900/40">
      <td colSpan={8} className="px-6 py-4 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <section className="space-y-2">
            <h4 className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Submission</h4>
            <Detail label="Lead ID" value={`#${lead.id}`} />
            {teamSize && <Detail label="Team size" value={teamSize} />}
            {preferredTime && <Detail label="Preferred time" value={preferredTime} />}
            {useCase && <Detail label="Use case" value={useCase} />}
            {message && (
              <div>
                <div className="text-xs text-slate-400">Message</div>
                <div className="text-sm text-slate-200 whitespace-pre-wrap bg-slate-800/40 rounded p-2 mt-1 border border-slate-700/40">
                  {message}
                </div>
              </div>
            )}
            <Detail label="Notified ops" value={lead.notified ? 'Yes' : 'No'} icon={MailCheck} />
          </section>

          <section className="space-y-2">
            <h4 className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Latest booking</h4>
            {!booking && <p className="text-sm text-slate-500">No booking recorded.</p>}
            {booking && (
              <>
                <Detail label="Event type" value={booking.eventType ?? 'created'} />
                <Detail label="Provider" value={booking.provider ?? '—'} />
                <Detail label="When" value={`${formatDateTime(booking.startTime)}${booking.timezone ? ` · ${booking.timezone}` : ''}`} />
                {booking.endTime && <Detail label="Until" value={formatDateTime(booking.endTime)} />}
                {booking.attendeeName && <Detail label="Attendee" value={`${booking.attendeeName}${booking.attendeeEmail ? ` <${booking.attendeeEmail}>` : ''}`} />}
                {booking.title && <Detail label="Title" value={booking.title} />}
                <div className="flex flex-wrap gap-2 mt-2">
                  {booking.meetingUrl && (
                    <a className="text-xs px-2 py-1 rounded bg-purple-500/15 text-purple-200 hover:bg-purple-500/25 inline-flex items-center gap-1"
                       href={booking.meetingUrl} target="_blank" rel="noreferrer">
                      Join meeting <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {booking.rescheduleUrl && (
                    <a className="text-xs px-2 py-1 rounded bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 inline-flex items-center gap-1"
                       href={booking.rescheduleUrl} target="_blank" rel="noreferrer">
                      Reschedule <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {booking.cancelUrl && (
                    <a className="text-xs px-2 py-1 rounded bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 inline-flex items-center gap-1"
                       href={booking.cancelUrl} target="_blank" rel="noreferrer">
                      Cancel <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </>
            )}
            {history.length > 1 && (
              <div className="mt-3">
                <div className="text-xs text-slate-400 mb-1">Booking history ({history.length})</div>
                <ul className="space-y-1 max-h-40 overflow-y-auto text-xs text-slate-300">
                  {history.slice().reverse().map((entry, idx) => (
                    <li key={idx} className="flex items-center justify-between bg-slate-800/40 rounded px-2 py-1 border border-slate-700/40">
                      <span>
                        <span className="font-medium text-slate-200">{entry.eventType ?? 'created'}</span>
                        {entry.startTime ? ` · ${formatDateTime(entry.startTime)}` : ''}
                      </span>
                      <span className="text-slate-500">{formatRelative(entry.recordedAt ?? null)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h4 className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Triage notes</h4>
            <textarea
              value={notesDraft}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="Internal notes for sales follow-up"
              rows={5}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>
                {lead.status_updated_at
                  ? `Last updated ${formatRelative(lead.status_updated_at)}${lead.status_updated_by ? ` by ${lead.status_updated_by}` : ''}`
                  : 'Not yet triaged'}
              </span>
              <button
                onClick={onSaveNotes}
                disabled={saving}
                className="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium disabled:opacity-50"
              >
                Save notes
              </button>
            </div>
          </section>
        </div>

        <ActivityHistory
          events={eventsQuery.data?.events ?? []}
          loading={eventsQuery.isLoading}
          error={eventsQuery.isError ? (eventsQuery.error instanceof Error ? eventsQuery.error.message : 'Unknown error') : null}
          createdAt={lead.created_at}
        />
      </td>
    </tr>
  );
}

function ActivityHistory({
  events,
  loading,
  error,
  createdAt,
}: {
  events: LeadEvent[];
  loading: boolean;
  error: string | null;
  createdAt: string;
}) {
  // Show newest at the top so the most recent action is the first thing reps see.
  const ordered = [...events].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const hasCreated = ordered.some((e) => e.event_type === 'created');
  // Always anchor the timeline with at least a synthetic "submitted" event for
  // legacy leads (or webhook-created leads) that never got a 'created' row.
  const syntheticCreated: LeadEvent | null = hasCreated
    ? null
    : {
        id: -1,
        lead_id: -1,
        event_type: 'created',
        previous_status: null,
        new_status: 'new',
        notes: null,
        author: null,
        created_at: createdAt,
      };
  const totalEvents = ordered.length + (syntheticCreated ? 1 : 0);

  return (
    <section className="rounded-lg border border-slate-700/40 bg-slate-900/40 p-4">
      <h4 className="text-xs uppercase tracking-wider text-slate-400 font-semibold flex items-center gap-2 mb-3">
        <History className="h-3.5 w-3.5" />
        Activity history
        {totalEvents > 0 && (
          <span className="text-[10px] font-normal text-slate-500 normal-case tracking-normal">
            ({totalEvents} {totalEvents === 1 ? 'event' : 'events'})
          </span>
        )}
      </h4>

      {loading && (
        <div className="text-sm text-slate-500">Loading history…</div>
      )}
      {error && !loading && (
        <div className="text-sm text-rose-300">Failed to load history: {error}</div>
      )}

      {!loading && !error && (
        <ol className="space-y-2">
          {ordered.map((event) => (
            <LeadEventRow key={event.id} event={event} />
          ))}
          {syntheticCreated && (
            <LeadEventRow event={syntheticCreated} />
          )}
        </ol>
      )}
    </section>
  );
}

function LeadEventRow({ event }: { event: LeadEvent }) {
  const accent =
    event.event_type === 'created'
      ? 'text-purple-300 bg-purple-500/10 border-purple-500/30'
      : event.event_type === 'note'
        ? 'text-amber-300 bg-amber-500/10 border-amber-500/30'
        : 'text-blue-300 bg-blue-500/10 border-blue-500/30';
  const Icon =
    event.event_type === 'created' ? Sparkles
    : event.event_type === 'note' ? MessageSquare
    : UserCheck;
  const summary = describeEvent(event);
  const author = event.author ? event.author : 'System';

  return (
    <li className="rounded-md border border-slate-700/50 bg-slate-800/40 p-3 flex items-start gap-3">
      <span className={clsx('inline-flex items-center justify-center h-7 w-7 rounded-full border shrink-0', accent)}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm text-slate-100">
            <span className="font-medium">{author}</span>{' '}
            <span className="text-slate-300">{summary}</span>
          </span>
          <span className="text-xs text-slate-500" title={formatDateTime(event.created_at)}>
            {formatRelative(event.created_at)}
          </span>
        </div>
        {event.notes && (
          <div className="mt-1 text-sm text-slate-200 whitespace-pre-wrap bg-slate-900/60 rounded px-2 py-1.5 border border-slate-700/40">
            “{event.notes}”
          </div>
        )}
      </div>
    </li>
  );
}

function describeEvent(event: LeadEvent): string {
  if (event.event_type === 'created') {
    return 'submitted this lead';
  }
  if (event.event_type === 'note') {
    return 'added a note';
  }
  // status_change
  const to = event.new_status ? STATUS_LABELS[event.new_status] : 'a new status';
  const from = event.previous_status ? STATUS_LABELS[event.previous_status] : null;
  if (from && from !== to) {
    return `marked as ${to} (was ${from})`;
  }
  return `marked as ${to}`;
}

function Detail({ label, value, icon: Icon }: { label: string; value: string; icon?: typeof Inbox }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {Icon && <Icon className="h-4 w-4 text-slate-500 mt-0.5 shrink-0" />}
      <div className="min-w-0">
        <div className="text-xs text-slate-400">{label}</div>
        <div className="text-slate-200 break-words">{value}</div>
      </div>
    </div>
  );
}

function SalesAlertSettingsModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery<SalesAlertSettingsResponse>({
    queryKey: ['sales-alert-settings'],
    queryFn: () => api.get<SalesAlertSettingsResponse>('/platform/sales-alert-settings'),
  });

  const [draft, setDraft] = useState<SalesAlertSettings | null>(null);
  const [newRecipient, setNewRecipient] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestAlertResponse | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.settings && !draft) setDraft(data.settings);
  }, [data, draft]);

  const saveMutation = useMutation({
    mutationFn: (settings: SalesAlertSettings) =>
      api.put<{ settings: SalesAlertSettings }>('/platform/sales-alert-settings', settings),
    onSuccess: (resp) => {
      setDraft(resp.settings);
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: ['sales-alert-settings'] });
    },
    onError: (err) => {
      setSaveError(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

  // Probe the currently-saved settings (NOT the unsaved draft) so admins know
  // exactly what production traffic would do. The endpoint never writes to
  // marketing_leads.
  const testMutation = useMutation({
    mutationFn: () =>
      api.post<TestAlertResponse>('/platform/sales-alert-settings/test', {}),
    onMutate: () => {
      setTestResult(null);
      setTestError(null);
    },
    onSuccess: (resp) => {
      setTestResult(resp);
    },
    onError: (err) => {
      setTestError(err instanceof Error ? err.message : 'Failed to send test alert');
    },
  });

  const addRecipient = () => {
    const trimmed = newRecipient.trim();
    if (!trimmed || !draft) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setSaveError(`"${trimmed}" doesn't look like a valid email address`);
      return;
    }
    if (draft.emailRecipients.includes(trimmed)) {
      setNewRecipient('');
      return;
    }
    setDraft({ ...draft, emailRecipients: [...draft.emailRecipients, trimmed] });
    setNewRecipient('');
    setSaveError(null);
  };

  const removeRecipient = (addr: string) => {
    if (!draft) return;
    setDraft({ ...draft, emailRecipients: draft.emailRecipients.filter((r) => r !== addr) });
  };

  return (
    <Modal open onClose={onClose} ariaLabel="Sales-alert settings" panelClassName="bg-slate-900 border border-slate-700 rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-purple-400" />
            <h3 className="text-lg font-semibold text-white">Sales-alert settings</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800"
            aria-label="Close"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          )}
          {isError && (
            <ErrorState
              variant="inline"
              title="Failed to load settings"
              error={error}
            />
          )}
          {draft && data && (
            <>
              <p className="text-xs text-slate-400">
                Pushed every time a new lead lands or a confirmed Cal.com booking arrives.
                Each lead row is alerted at most once (tracked by <code className="text-slate-300">marketing_leads.notified</code>).
              </p>

              <section className="space-y-3">
                <h4 className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Channels</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Toggle
                    label="Email"
                    description="Send to the recipients below"
                    checked={draft.channels.email}
                    onChange={(v) => setDraft({ ...draft, channels: { ...draft.channels, email: v } })}
                  />
                  <Toggle
                    label="Slack"
                    description="Post to the configured webhook"
                    checked={draft.channels.slack}
                    onChange={(v) => setDraft({ ...draft, channels: { ...draft.channels, slack: v } })}
                  />
                </div>
              </section>

              <section className="space-y-3">
                <h4 className="text-xs uppercase tracking-wider text-slate-400 font-semibold">When to alert</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Toggle
                    label="New lead submitted"
                    description="Book a Demo, ROI Calculator, Contact"
                    checked={draft.notifyOnNewLead}
                    onChange={(v) => setDraft({ ...draft, notifyOnNewLead: v })}
                  />
                  <Toggle
                    label="Booking confirmed"
                    description="Cal.com BOOKING_CREATED"
                    checked={draft.notifyOnBookingCreated}
                    onChange={(v) => setDraft({ ...draft, notifyOnBookingCreated: v })}
                  />
                  <Toggle
                    label="Booking rescheduled"
                    description="Cal.com BOOKING_RESCHEDULED"
                    checked={draft.notifyOnBookingRescheduled}
                    onChange={(v) => setDraft({ ...draft, notifyOnBookingRescheduled: v })}
                  />
                  <Toggle
                    label="Booking cancelled"
                    description="Cal.com BOOKING_CANCELLED"
                    checked={draft.notifyOnBookingCancelled}
                    onChange={(v) => setDraft({ ...draft, notifyOnBookingCancelled: v })}
                  />
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Email recipients</h4>
                  {data.fallbacks.envEmail && draft.emailRecipients.length === 0 && (
                    <span className="text-[11px] text-slate-500">
                      Falls back to <code className="text-slate-400">{data.fallbacks.envEmail}</code> (env)
                    </span>
                  )}
                </div>
                <div className="space-y-1.5">
                  {draft.emailRecipients.length === 0 && (
                    <p className="text-xs text-slate-500">
                      No overrides — alerts go to the address from <code>SALES_NOTIFICATION_EMAIL</code>.
                    </p>
                  )}
                  {draft.emailRecipients.map((addr) => (
                    <div key={addr} className="flex items-center justify-between bg-slate-800/60 border border-slate-700 rounded px-3 py-1.5">
                      <span className="text-sm text-slate-200 truncate">{addr}</span>
                      <button
                        onClick={() => removeRecipient(addr)}
                        className="p-1 text-slate-400 hover:text-rose-300"
                        aria-label={`Remove ${addr}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={newRecipient}
                    onChange={(e) => setNewRecipient(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRecipient(); } }}
                    placeholder="sales@example.com"
                    className="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <button
                    onClick={addRecipient}
                    type="button"
                    className="flex items-center gap-1 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium"
                  >
                    <Plus className="h-4 w-4" /> Add
                  </button>
                </div>
              </section>

              <section className="space-y-2">
                <h4 className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Slack webhook (optional)</h4>
                <input
                  type="url"
                  value={draft.slackWebhookUrl ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, slackWebhookUrl: e.target.value.trim() ? e.target.value.trim() : null })
                  }
                  placeholder={
                    data.fallbacks.envSlackConfigured
                      ? 'Override the env-configured webhook (optional)'
                      : 'https://hooks.slack.com/services/…'
                  }
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <p className="text-[11px] text-slate-500">
                  When empty, falls back to <code>OPS_SLACK_WEBHOOK_URL</code> (env).
                  {' '}
                  {data.fallbacks.envSlackConfigured ? 'Env webhook is currently set.' : 'Env webhook is not set.'}
                </p>
              </section>

              {saveError && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200 text-sm">
                  {saveError}
                </div>
              )}

              {(testResult || testError) && (
                <TestAlertBanner result={testResult} error={testError} />
              )}
            </>
          )}
        </div>

        <div className="border-t border-slate-700 px-5 py-3 flex flex-wrap items-center justify-between gap-2">
          <button
            onClick={() => testMutation.mutate()}
            disabled={!data || testMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-sm text-white disabled:opacity-50"
            title="Send a test alert through the currently-saved channels (no lead is created)"
          >
            <Send className="h-4 w-4" />
            {testMutation.isPending ? 'Sending test…' : 'Send test alert'}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sm text-white"
            >
              Cancel
            </button>
            <button
              onClick={() => draft && saveMutation.mutate(draft)}
              disabled={!draft || saveMutation.isPending}
              className="px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-sm font-medium text-white disabled:opacity-50"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
    </Modal>
  );
}

function TestAlertBanner({ result, error }: { result: TestAlertResponse | null; error: string | null }) {
  if (error) {
    return (
      <ErrorState
        variant="inline"
        title="Test alert request failed"
        error={error}
      />
    );
  }
  if (!result) return null;

  const anyFailed = result.email === 'failed' || result.slack === 'failed';
  const anySent = result.email === 'sent' || result.slack === 'sent';

  // "All-skipped" usually means the admin disabled both channels or has no
  // recipients/webhook configured — flag it gently rather than as success.
  const allSkipped = result.email === 'skipped' && result.slack === 'skipped';

  const tone = anyFailed
    ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
    : anySent
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-200';

  const Icon = anyFailed ? AlertTriangle : anySent ? CheckCircle : AlertTriangle;
  const headline = anyFailed
    ? 'Test alert finished with errors'
    : anySent
      ? 'Test alert sent'
      : allSkipped
        ? 'Nothing was sent'
        : 'Test alert finished';

  return (
    <div className={clsx('rounded-lg border p-3 text-sm flex items-start gap-2', tone)}>
      <Icon className="h-4 w-4 mt-0.5 flex-shrink-0" />
      <div className="min-w-0 space-y-1">
        <div className="font-medium">{headline}</div>
        <ChannelStatusLine label="Email" status={result.email} detail={result.emailError} />
        <ChannelStatusLine label="Slack" status={result.slack} detail={result.slackError} />
        {allSkipped && (
          <div className="text-xs opacity-80">
            Both channels are disabled or have no recipients/webhook configured.
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelStatusLine({
  label,
  status,
  detail,
}: {
  label: string;
  status: AlertChannelStatus;
  detail?: string;
}) {
  const dot =
    status === 'sent'
      ? 'bg-emerald-400'
      : status === 'failed'
        ? 'bg-rose-400'
        : 'bg-slate-400';
  return (
    <div className="text-xs flex items-start gap-2">
      <span className={clsx('mt-1.5 h-1.5 w-1.5 rounded-full flex-shrink-0', dot)} />
      <span className="min-w-0 break-words">
        <span className="font-medium">{label}:</span>{' '}
        <span className="capitalize">{status}</span>
        {detail && <span className="opacity-80"> — {detail}</span>}
      </span>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 p-3 rounded-lg border border-slate-700 bg-slate-800/40 cursor-pointer hover:bg-slate-800/70">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-purple-500"
      />
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-100">{label}</div>
        {description && <div className="text-xs text-slate-400">{description}</div>}
      </div>
    </label>
  );
}
