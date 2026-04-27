import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Truck, Plus, X, User, Clock, AlertTriangle, Filter, Search, RefreshCw,
  ChevronDown, ChevronRight, MapPin, Wrench, BarChart3, Settings, Users,
  CheckCircle2, XCircle, ArrowRight, FileText, MessageSquare, Calendar,
  Activity, TrendingUp, Clipboard, Bell, Shield, Layers, ArrowLeftRight,
} from 'lucide-react';
import { EmptyState, PageSkeleton, SkeletonRows } from '../components/state';
import Modal from '../components/Modal';

interface DispatchJob {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee_user_id: string | null;
  assignee_email: string | null;
  contact_id: string | null;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  address: string;
  scheduled_at: string | null;
  completed_at: string | null;
  notes: string;
  territory_id: string | null;
  territory_name: string | null;
  resource_id: string | null;
  resource_name: string | null;
  job_type: string;
  estimated_duration_minutes: number | null;
  actual_duration_minutes: number | null;
  eta_start: string | null;
  eta_end: string | null;
  parent_job_id: string | null;
  is_follow_up: boolean;
  required_skills: string[];
  created_at: string;
}

interface Resource {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  territory_id: string | null;
  territory_name: string | null;
  shift_start: string;
  shift_end: string;
  shift_days: number[];
  max_concurrent_jobs: number;
  current_status: string;
  status: string;
  active_jobs: number;
  skills: string[] | null;
}

interface Territory {
  id: string;
  name: string;
  description: string;
  region: string;
  status: string;
  resource_count: number;
  active_jobs: number;
}

interface SkillType {
  id: string;
  name: string;
  description: string;
  category: string;
  status: string;
  resource_count: number;
}

interface TeamMember { id: string; email: string; }

interface NotificationTemplate {
  id: string;
  name: string;
  trigger_event: string;
  channel: string;
  subject: string;
  body_template: string;
  is_active: boolean;
}

interface AssignmentRule {
  id: string;
  name: string;
  description: string;
  rule_type: string;
  priority: number;
  conditions: Record<string, unknown>;
  is_active: boolean;
}

interface ReportingData {
  metrics: Record<string, unknown>;
  exceptionBreakdown: { exception_type: string; count: number }[];
  territoryPerformance: { territory_name: string; total_jobs: number; completed: number }[];
  resourcePerformance: { resource_name: string; total_jobs: number; completed: number; avg_duration: number }[];
  dailyTrend: { date: string; created: number; completed: number }[];
}

interface JobEvent {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  performed_by: string | null;
  notes: string;
  created_at: string;
  metadata?: Record<string, unknown> | null;
}

interface JobException {
  id: string;
  exception_type: string;
  reason: string;
  resolution: string;
  resolved_at: string | null;
  created_at: string;
}

interface JobAttachment {
  id: string;
  attachment_type: string;
  title: string;
  content: string;
  file_url: string | null;
  object_path: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  created_at: string;
}

const STATUS_FLOW = [
  { key: 'pending', label: 'Pending', color: 'border-t-yellow-400', bg: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300' },
  { key: 'assigned', label: 'Assigned', color: 'border-t-blue-400', bg: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  { key: 'scheduled', label: 'Scheduled', color: 'border-t-indigo-400', bg: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300' },
  { key: 'en_route', label: 'En Route', color: 'border-t-cyan-400', bg: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300' },
  { key: 'on_site', label: 'On Site', color: 'border-t-teal-400', bg: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300' },
  { key: 'in_progress', label: 'In Progress', color: 'border-t-orange-400', bg: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300' },
  { key: 'completed', label: 'Completed', color: 'border-t-green-400', bg: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  { key: 'incomplete', label: 'Incomplete', color: 'border-t-red-400', bg: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
  { key: 'done', label: 'Done', color: 'border-t-emerald-400', bg: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' },
  { key: 'cancelled', label: 'Cancelled', color: 'border-t-gray-400', bg: 'bg-surface-hover text-text-primary' },
];

const BOARD_COLUMNS = ['pending', 'assigned', 'scheduled', 'en_route', 'on_site', 'in_progress'];

const PRIORITY_BADGES: Record<string, string> = {
  low: 'bg-surface-hover text-text-primary',
  medium: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  urgent: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
};

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['scheduled', 'en_route', 'in_progress', 'cancelled', 'pending'],
  scheduled: ['en_route', 'in_progress', 'cancelled', 'assigned'],
  en_route: ['on_site', 'cancelled'],
  on_site: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'incomplete', 'cancelled', 'done'],
  completed: ['done'],
  incomplete: ['pending', 'assigned', 'cancelled'],
  done: [],
  cancelled: ['pending'],
};

const EXCEPTION_TYPES = ['delay', 'no_access', 'cancelled', 'reschedule', 'return_visit', 'reassignment', 'other'];
const TRIGGER_EVENTS = ['job_assigned', 'job_scheduled', 'en_route', 'arrival', 'delay', 'completed', 'exception', 'cancelled'];

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_FLOW.find(x => x.key === status);
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${s?.bg || 'bg-surface-hover text-text-secondary'}`}>{s?.label || status}</span>;
}

function StatCard({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{className?:string}>; label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10"><Icon className="h-4 w-4 text-primary" /></div>
        <div>
          <p className="text-xs text-muted">{label}</p>
          <p className="text-lg font-bold text-heading">{value}</p>
          {sub && <p className="text-[10px] text-muted">{sub}</p>}
        </div>
      </div>
    </div>
  );
}

// ============ MAIN COMPONENT ============

export default function Dispatch() {
  const { user } = useAuth();
  const isReadOnly = !['tenant_owner', 'operations_manager'].includes(user?.role ?? '');
  const [activeTab, setActiveTab] = useState<'board' | 'queue' | 'resources' | 'reporting' | 'admin'>('board');
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [resources, setResources] = useState<Resource[]>([]);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [skillTypes, setSkillTypes] = useState<SkillType[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [notifTemplates, setNotifTemplates] = useState<NotificationTemplate[]>([]);
  const [assignmentRules, setAssignmentRules] = useState<AssignmentRule[]>([]);
  const [reportingData, setReportingData] = useState<ReportingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showJobForm, setShowJobForm] = useState(false);
  const [editingJob, setEditingJob] = useState<DispatchJob | null>(null);
  const [jobDetail, setJobDetail] = useState<{ job: DispatchJob; events: JobEvent[]; exceptions: JobException[]; attachments: JobAttachment[] } | null>(null);
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState({ status: '', priority: '', territory_id: '', resource_id: '', search: '' });
  const [showFilters, setShowFilters] = useState(false);

  const fetchJobs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (filters.status) params.set('status', filters.status);
      if (filters.priority) params.set('priority', filters.priority);
      if (filters.territory_id) params.set('territory_id', filters.territory_id);
      if (filters.resource_id) params.set('resource_id', filters.resource_id);
      if (filters.search) params.set('search', filters.search);
      const data = await api.get<{ jobs: DispatchJob[] }>(`/dispatch/jobs?${params}`);
      setJobs(data.jobs);
    } catch { setError('Failed to load dispatch jobs'); }
  }, [filters]);

  const fetchCounts = useCallback(async () => {
    try {
      const data = await api.get<{ counts: Record<string, number> }>('/dispatch/jobs/counts');
      setStatusCounts(data.counts);
    } catch {}
  }, []);

  const fetchResources = useCallback(async () => {
    try {
      const data = await api.get<{ resources: Resource[] }>('/dispatch/resources?limit=200');
      setResources(data.resources);
    } catch {}
  }, []);

  const fetchTerritories = useCallback(async () => {
    try {
      const data = await api.get<{ territories: Territory[] }>('/dispatch/territories');
      setTerritories(data.territories);
    } catch {}
  }, []);

  const fetchSkillTypes = useCallback(async () => {
    try {
      const data = await api.get<{ skillTypes: SkillType[] }>('/dispatch/skill-types');
      setSkillTypes(data.skillTypes);
    } catch {}
  }, []);

  const fetchNotifTemplates = useCallback(async () => {
    try {
      const data = await api.get<{ templates: NotificationTemplate[] }>('/dispatch/notification-templates');
      setNotifTemplates(data.templates);
    } catch {}
  }, []);

  const fetchAssignmentRules = useCallback(async () => {
    try {
      const data = await api.get<{ rules: AssignmentRule[] }>('/dispatch/assignment-rules');
      setAssignmentRules(data.rules);
    } catch {}
  }, []);

  const fetchReporting = useCallback(async () => {
    try {
      const data = await api.get<ReportingData>('/dispatch/reporting');
      setReportingData(data);
    } catch {}
  }, []);

  useEffect(() => {
    Promise.all([fetchJobs(), fetchCounts()]).finally(() => setLoading(false));
    api.get<{ users: TeamMember[] }>('/users?limit=100').then(d => setTeamMembers(d.users)).catch(() => {});
    fetchTerritories();
    fetchResources();
  }, [fetchJobs, fetchCounts, fetchTerritories, fetchResources]);

  useEffect(() => {
    if (activeTab === 'resources') { fetchResources(); fetchSkillTypes(); }
    if (activeTab === 'reporting') fetchReporting();
    if (activeTab === 'admin') { fetchSkillTypes(); fetchTerritories(); fetchNotifTemplates(); fetchAssignmentRules(); }
  }, [activeTab, fetchResources, fetchSkillTypes, fetchReporting, fetchTerritories, fetchNotifTemplates, fetchAssignmentRules]);

  const refreshAll = () => { fetchJobs(); fetchCounts(); setError(null); };

  const getJobsByStatus = (s: string) => jobs.filter(j => j.status === s);

  const transitionJob = async (jobId: string, newStatus: string, notes?: string) => {
    if (isReadOnly) return;
    try {
      await api.post(`/dispatch/jobs/${jobId}/transition`, { status: newStatus, notes });
      refreshAll();
      if (jobDetail && jobDetail.job.id === jobId) openJobDetail(jobId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to update status');
    }
  };

  const batchUpdate = async (updates: Record<string, unknown>) => {
    if (selectedJobs.size === 0) return;
    try {
      await api.post('/dispatch/jobs/batch', { job_ids: Array.from(selectedJobs), ...updates });
      setSelectedJobs(new Set());
      refreshAll();
    } catch { setError('Failed to batch update'); }
  };

  const openJobDetail = async (jobId: string) => {
    try {
      const data = await api.get<{ job: DispatchJob; events: JobEvent[]; exceptions: JobException[]; attachments: JobAttachment[] }>(`/dispatch/jobs/${jobId}`);
      setJobDetail(data);
    } catch { setError('Failed to load job details'); }
  };

  const totalActive = Object.entries(statusCounts)
    .filter(([k]) => !['done', 'completed', 'cancelled'].includes(k))
    .reduce((s, [, v]) => s + v, 0);

  const tabs = [
    { key: 'board' as const, label: 'Board', icon: Layers },
    { key: 'queue' as const, label: 'Queue', icon: Clipboard },
    { key: 'resources' as const, label: 'Resources', icon: Users },
    { key: 'reporting' as const, label: 'Reporting', icon: BarChart3 },
    { key: 'admin' as const, label: 'Admin', icon: Settings },
  ];

  if (loading) {
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Truck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-heading">Dispatch Center</h1>
            <p className="text-sm text-muted mt-0.5">{totalActive} active jobs across {resources.length} resources</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refreshAll} className="p-2 rounded-lg text-muted hover:text-heading hover:bg-surface-secondary transition-colors">
            <RefreshCw className="h-4 w-4" />
          </button>
          {!isReadOnly && (
            <button onClick={() => { setEditingJob(null); setShowJobForm(true); }} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
              <Plus className="h-4 w-4" /> New Job
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 underline text-xs">Dismiss</button>
        </div>
      )}

      <div className="flex gap-1 border-b border-border">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-heading'}`}>
            <t.icon className="h-4 w-4" />{t.label}
          </button>
        ))}
      </div>

      {activeTab === 'board' && (
        <BoardView jobs={jobs} statusCounts={statusCounts} filters={filters} setFilters={setFilters}
          showFilters={showFilters} setShowFilters={setShowFilters} territories={territories}
          resources={resources} isReadOnly={isReadOnly} transitionJob={transitionJob}
          openJobDetail={openJobDetail} setEditingJob={setEditingJob} setShowJobForm={setShowJobForm}
          selectedJobs={selectedJobs} setSelectedJobs={setSelectedJobs} batchUpdate={batchUpdate}
          getJobsByStatus={getJobsByStatus} />
      )}

      {activeTab === 'queue' && (
        <QueueView jobs={jobs} statusCounts={statusCounts} filters={filters} setFilters={setFilters}
          territories={territories} resources={resources} isReadOnly={isReadOnly}
          transitionJob={transitionJob} openJobDetail={openJobDetail}
          setEditingJob={setEditingJob} setShowJobForm={setShowJobForm}
          selectedJobs={selectedJobs} setSelectedJobs={setSelectedJobs} batchUpdate={batchUpdate} />
      )}

      {activeTab === 'resources' && (
        <ResourcesView resources={resources} territories={territories} skillTypes={skillTypes}
          isReadOnly={isReadOnly} fetchResources={fetchResources} fetchSkillTypes={fetchSkillTypes} />
      )}

      {activeTab === 'reporting' && (
        <ReportingView data={reportingData} fetchReporting={fetchReporting} />
      )}

      {activeTab === 'admin' && (
        <AdminView territories={territories} skillTypes={skillTypes} notifTemplates={notifTemplates}
          assignmentRules={assignmentRules} isReadOnly={isReadOnly}
          fetchTerritories={fetchTerritories} fetchSkillTypes={fetchSkillTypes}
          fetchNotifTemplates={fetchNotifTemplates} fetchAssignmentRules={fetchAssignmentRules} />
      )}

      {showJobForm && (
        <JobFormModal job={editingJob} territories={territories} resources={resources}
          teamMembers={teamMembers} skillTypes={skillTypes}
          onClose={() => { setShowJobForm(false); setEditingJob(null); }}
          onSaved={() => { setShowJobForm(false); setEditingJob(null); refreshAll(); }} />
      )}

      {jobDetail && (
        <JobDetailModal detail={jobDetail} isReadOnly={isReadOnly}
          transitionJob={transitionJob} onClose={() => setJobDetail(null)}
          onRefresh={() => openJobDetail(jobDetail.job.id)} refreshAll={refreshAll} />
      )}
    </div>
  );
}

// ============ BOARD VIEW ============

function BoardView({ jobs, statusCounts, filters, setFilters, showFilters, setShowFilters,
  territories, resources, isReadOnly, transitionJob, openJobDetail, setEditingJob, setShowJobForm,
  selectedJobs, setSelectedJobs, batchUpdate, getJobsByStatus }: {
  jobs: DispatchJob[]; statusCounts: Record<string, number>;
  filters: Record<string, string>; setFilters: React.Dispatch<React.SetStateAction<{ status: string; priority: string; territory_id: string; resource_id: string; search: string }>>;
  showFilters: boolean; setShowFilters: (b: boolean) => void;
  territories: Territory[]; resources: Resource[]; isReadOnly: boolean;
  transitionJob: (id: string, s: string) => void;
  openJobDetail: (id: string) => void;
  setEditingJob: (j: DispatchJob | null) => void; setShowJobForm: (b: boolean) => void;
  selectedJobs: Set<string>; setSelectedJobs: (s: Set<string>) => void;
  batchUpdate: (u: Record<string, unknown>) => void;
  getJobsByStatus: (s: string) => DispatchJob[];
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          {STATUS_FLOW.map(s => (
            <button key={s.key} onClick={() => setFilters(prev => ({ ...prev, status: prev.status === s.key ? '' : s.key }))}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${filters.status === s.key ? s.bg : 'bg-surface-secondary text-muted hover:text-heading'}`}>
              {s.label} <span className="ml-1 opacity-70">{statusCounts[s.key] || 0}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {selectedJobs.size > 0 && !isReadOnly && (
            <div className="flex items-center gap-2 bg-primary/10 rounded-lg px-3 py-1.5">
              <span className="text-xs font-medium text-primary">{selectedJobs.size} selected</span>
              <select onChange={e => { if (e.target.value) batchUpdate({ status: e.target.value }); e.target.value = ''; }}
                className="text-xs bg-transparent border-none text-primary font-medium cursor-pointer">
                <option value="">Batch action...</option>
                <option value="assigned">Assign</option>
                <option value="in_progress">Start</option>
                <option value="completed">Complete</option>
                <option value="cancelled">Cancel</option>
              </select>
              <button onClick={() => setSelectedJobs(new Set())} className="text-primary hover:text-primary/70"><X className="h-3 w-3" /></button>
            </div>
          )}
          <button onClick={() => setShowFilters(!showFilters)}
            className={`p-2 rounded-lg transition-colors ${showFilters ? 'bg-primary/10 text-primary' : 'text-muted hover:text-heading hover:bg-surface-secondary'}`}>
            <Filter className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="bg-surface border border-border rounded-lg p-3 flex flex-wrap gap-3">
          <div className="flex-1 min-w-[150px]">
            <label className="block text-[10px] font-medium text-muted mb-1">Search</label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
              <input type="text" value={filters.search} onChange={e => { const v = e.target.value; setFilters(prev => ({ ...prev, search: v })); }}
                placeholder="Search jobs..." aria-label="Search dispatch jobs" className="w-full pl-7 pr-3 py-1.5 rounded-lg border border-border bg-surface text-heading text-xs focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          </div>
          <div className="min-w-[120px]">
            <label className="block text-[10px] font-medium text-muted mb-1">Priority</label>
            <select value={filters.priority} onChange={e => { const v = e.target.value; setFilters(prev => ({ ...prev, priority: v })); }}
              className="w-full px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-xs">
              <option value="">All</option>
              {['urgent','high','medium','low'].map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="min-w-[120px]">
            <label className="block text-[10px] font-medium text-muted mb-1">Territory</label>
            <select value={filters.territory_id} onChange={e => { const v = e.target.value; setFilters(prev => ({ ...prev, territory_id: v })); }}
              className="w-full px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-xs">
              <option value="">All</option>
              {territories.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="min-w-[120px]">
            <label className="block text-[10px] font-medium text-muted mb-1">Resource</label>
            <select value={filters.resource_id} onChange={e => { const v = e.target.value; setFilters(prev => ({ ...prev, resource_id: v })); }}
              className="w-full px-2 py-1.5 rounded-lg border border-border bg-surface text-heading text-xs">
              <option value="">All</option>
              {resources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <button onClick={() => setFilters({ status: '', priority: '', territory_id: '', resource_id: '', search: '' })}
            className="self-end px-3 py-1.5 text-xs text-muted hover:text-heading bg-surface-secondary rounded-lg">Clear</button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 min-h-[400px]">
        {BOARD_COLUMNS.map(colKey => {
          const col = STATUS_FLOW.find(s => s.key === colKey)!;
          const colJobs = getJobsByStatus(colKey);
          return (
            <div key={colKey} className={`bg-surface border border-border rounded-xl overflow-hidden border-t-4 ${col.color}`}>
              <div className="p-2.5 border-b border-border">
                <h3 className="text-xs font-semibold text-heading flex items-center justify-between">
                  {col.label}
                  <span className="text-[10px] font-normal text-muted bg-surface-secondary rounded-full px-2 py-0.5">{colJobs.length}</span>
                </h3>
              </div>
              <div className="p-1.5 space-y-1.5 overflow-y-auto max-h-[500px]">
                {colJobs.length === 0 ? (
                  <EmptyState
                    icon={Truck}
                    title="No jobs"
                    variant="compact"
                  />
                ) : colJobs.map(job => (
                  <JobCard key={job.id} job={job} isReadOnly={isReadOnly} selected={selectedJobs.has(job.id)}
                    onSelect={() => { const s = new Set(selectedJobs); s.has(job.id) ? s.delete(job.id) : s.add(job.id); setSelectedJobs(s); }}
                    onClick={() => openJobDetail(job.id)}
                    onTransition={(s) => transitionJob(job.id, s)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function JobCard({ job, isReadOnly, selected, onSelect, onClick, onTransition }: {
  job: DispatchJob; isReadOnly: boolean; selected: boolean;
  onSelect: () => void; onClick: () => void; onTransition: (s: string) => void;
}) {
  const nextStates = VALID_TRANSITIONS[job.status] || [];
  return (
    <div onClick={onClick}
      className={`bg-surface-secondary rounded-lg p-2.5 cursor-pointer hover:ring-1 hover:ring-primary/30 transition-all ${selected ? 'ring-2 ring-primary' : ''}`}>
      <div className="flex items-start justify-between gap-1">
        <div className="flex items-center gap-1.5">
          {!isReadOnly && (
            <input type="checkbox" checked={selected} onChange={e => { e.stopPropagation(); onSelect(); }}
              onClick={e => e.stopPropagation()} className="rounded border-border h-3 w-3" />
          )}
          <h4 className="text-xs font-medium text-heading leading-tight line-clamp-1">{job.title}</h4>
        </div>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[8px] font-semibold ${PRIORITY_BADGES[job.priority]}`}>
          {job.priority.toUpperCase()}
        </span>
      </div>
      {job.description && <p className="text-[10px] text-muted mt-1 line-clamp-1">{job.description}</p>}
      <div className="flex items-center justify-between mt-1.5">
        <div className="flex items-center gap-1 text-[10px] text-muted">
          <User className="h-2.5 w-2.5" />
          <span className="truncate max-w-[80px]">{job.resource_name || job.contact_name || job.assignee_email || 'Unassigned'}</span>
        </div>
        {job.territory_name && (
          <div className="flex items-center gap-0.5 text-[10px] text-muted">
            <MapPin className="h-2.5 w-2.5" />
            <span className="truncate max-w-[50px]">{job.territory_name}</span>
          </div>
        )}
      </div>
      {job.scheduled_at && (
        <div className="flex items-center gap-1 text-[10px] text-muted mt-1">
          <Clock className="h-2.5 w-2.5" />
          <span>{new Date(job.scheduled_at).toLocaleDateString()} {new Date(job.scheduled_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
        </div>
      )}
      {job.is_follow_up && <span className="text-[8px] px-1 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded mt-1 inline-block">Follow-up</span>}
      {!isReadOnly && nextStates.length > 0 && (
        <div className="flex gap-1 mt-1.5 flex-wrap" onClick={e => e.stopPropagation()}>
          {nextStates.slice(0, 2).map(s => {
            const st = STATUS_FLOW.find(x => x.key === s);
            return (
              <button key={s} onClick={() => onTransition(s)}
                className={`text-[9px] px-1.5 py-0.5 rounded ${st?.bg || 'bg-surface-hover text-text-primary'} hover:opacity-80`}>
                {st?.label || s}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============ QUEUE VIEW ============

function QueueView({ jobs, statusCounts, filters, setFilters, territories, resources, isReadOnly,
  transitionJob, openJobDetail, setEditingJob, setShowJobForm, selectedJobs, setSelectedJobs, batchUpdate }: {
  jobs: DispatchJob[]; statusCounts: Record<string, number>;
  filters: Record<string, string>; setFilters: React.Dispatch<React.SetStateAction<{ status: string; priority: string; territory_id: string; resource_id: string; search: string }>>;
  territories: Territory[]; resources: Resource[]; isReadOnly: boolean;
  transitionJob: (id: string, s: string) => void;
  openJobDetail: (id: string) => void;
  setEditingJob: (j: DispatchJob | null) => void; setShowJobForm: (b: boolean) => void;
  selectedJobs: Set<string>; setSelectedJobs: (s: Set<string>) => void;
  batchUpdate: (u: Record<string, unknown>) => void;
}) {
  const [queueFilter, setQueueFilter] = useState('');

  const filteredJobs = useMemo(() => {
    let result = jobs;
    if (queueFilter) result = result.filter(j => j.status === queueFilter);
    return result;
  }, [jobs, queueFilter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1 flex-wrap">
          <button onClick={() => setQueueFilter('')}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${!queueFilter ? 'bg-primary text-white' : 'bg-surface-secondary text-muted hover:text-heading'}`}>
            All ({jobs.length})
          </button>
          {STATUS_FLOW.map(s => (
            <button key={s.key} onClick={() => setQueueFilter(s.key)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${queueFilter === s.key ? s.bg : 'bg-surface-secondary text-muted hover:text-heading'}`}>
              {s.label} ({statusCounts[s.key] || 0})
            </button>
          ))}
        </div>
        {selectedJobs.size > 0 && !isReadOnly && (
          <div className="flex items-center gap-2 bg-primary/10 rounded-lg px-3 py-1.5">
            <span className="text-xs font-medium text-primary">{selectedJobs.size} selected</span>
            <select onChange={e => { if (e.target.value) batchUpdate({ status: e.target.value }); e.target.value = ''; }}
              className="text-xs bg-transparent border-none text-primary font-medium cursor-pointer">
              <option value="">Batch action...</option>
              <option value="assigned">Assign</option>
              <option value="in_progress">Start</option>
              <option value="completed">Complete</option>
              <option value="cancelled">Cancel</option>
            </select>
            <button onClick={() => setSelectedJobs(new Set())} className="text-primary"><X className="h-3 w-3" /></button>
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-surface-secondary">
              {!isReadOnly && <th className="p-2 w-8"><input type="checkbox" onChange={e => { setSelectedJobs(e.target.checked ? new Set(filteredJobs.map(j=>j.id)) : new Set()); }} className="rounded border-border h-3 w-3" /></th>}
              <th className="p-2 text-left text-muted font-medium">Title</th>
              <th className="p-2 text-left text-muted font-medium">Status</th>
              <th className="p-2 text-left text-muted font-medium">Priority</th>
              <th className="p-2 text-left text-muted font-medium">Resource</th>
              <th className="p-2 text-left text-muted font-medium">Territory</th>
              <th className="p-2 text-left text-muted font-medium">Scheduled</th>
              <th className="p-2 text-left text-muted font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.map(job => (
              <tr key={job.id} className="border-b border-border hover:bg-surface-secondary/50 cursor-pointer" onClick={() => openJobDetail(job.id)}>
                {!isReadOnly && (
                  <td className="p-2" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedJobs.has(job.id)}
                      onChange={() => { const s = new Set(selectedJobs); s.has(job.id) ? s.delete(job.id) : s.add(job.id); setSelectedJobs(s); }}
                      className="rounded border-border h-3 w-3" />
                  </td>
                )}
                <td className="p-2">
                  <div className="font-medium text-heading">{job.title}</div>
                  <div className="text-muted truncate max-w-[200px]">{job.contact_name}</div>
                </td>
                <td className="p-2"><StatusBadge status={job.status} /></td>
                <td className="p-2"><span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${PRIORITY_BADGES[job.priority]}`}>{job.priority}</span></td>
                <td className="p-2 text-muted">{job.resource_name || '-'}</td>
                <td className="p-2 text-muted">{job.territory_name || '-'}</td>
                <td className="p-2 text-muted">{job.scheduled_at ? new Date(job.scheduled_at).toLocaleDateString() : '-'}</td>
                <td className="p-2" onClick={e => e.stopPropagation()}>
                  {!isReadOnly && (VALID_TRANSITIONS[job.status] || []).length > 0 && (
                    <select onChange={e => { if (e.target.value) transitionJob(job.id, e.target.value); e.target.value = ''; }}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-surface">
                      <option value="">Move to...</option>
                      {(VALID_TRANSITIONS[job.status] || []).map(s => <option key={s} value={s}>{STATUS_FLOW.find(x=>x.key===s)?.label||s}</option>)}
                    </select>
                  )}
                </td>
              </tr>
            ))}
            {filteredJobs.length === 0 && (
              <tr><td colSpan={isReadOnly ? 7 : 8} className="p-0">
                <EmptyState
                  icon={Truck}
                  title={queueFilter || filters.search || filters.priority || filters.territory_id || filters.resource_id ? 'No jobs match your filters' : 'No jobs in the queue'}
                  description={queueFilter || filters.search || filters.priority || filters.territory_id || filters.resource_id
                    ? 'Try clearing filters to see more jobs in the queue.'
                    : 'Create a dispatch job to start scheduling work for your field team.'}
                  primaryAction={!isReadOnly && !queueFilter && !filters.search ? {
                    label: 'New Job',
                    icon: Plus,
                    onClick: () => { setEditingJob(null); setShowJobForm(true); },
                  } : undefined}
                  secondaryAction={(queueFilter || filters.search || filters.priority || filters.territory_id || filters.resource_id) ? {
                    label: 'Clear filters',
                    onClick: () => { setQueueFilter(''); setFilters({ status: '', priority: '', territory_id: '', resource_id: '', search: '' }); },
                  } : undefined}
                />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ RESOURCES VIEW ============

function ResourcesView({ resources, territories, skillTypes, isReadOnly, fetchResources, fetchSkillTypes }: {
  resources: Resource[]; territories: Territory[]; skillTypes: SkillType[];
  isReadOnly: boolean; fetchResources: () => void; fetchSkillTypes: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingResource, setEditingResource] = useState<Resource | null>(null);
  const [formData, setFormData] = useState({ name: '', email: '', phone: '', role: 'field_worker', territory_id: '', shift_start: '08:00', shift_end: '17:00', max_concurrent_jobs: 3 });
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);

  const openForm = (r?: Resource) => {
    if (r) {
      setEditingResource(r);
      setFormData({ name: r.name, email: r.email, phone: r.phone, role: r.role, territory_id: r.territory_id || '', shift_start: r.shift_start || '08:00', shift_end: r.shift_end || '17:00', max_concurrent_jobs: r.max_concurrent_jobs });
      setSelectedSkills(r.skills || []);
    } else {
      setEditingResource(null);
      setFormData({ name: '', email: '', phone: '', role: 'field_worker', territory_id: '', shift_start: '08:00', shift_end: '17:00', max_concurrent_jobs: 3 });
      setSelectedSkills([]);
    }
    setShowForm(true);
  };

  const [resError, setResError] = useState<string | null>(null);

  const saveResource = async () => {
    if (!formData.name) return;
    try {
      setResError(null);
      const payload = { ...formData, territory_id: formData.territory_id || null };
      let resourceId = editingResource?.id;
      if (editingResource) {
        await api.put(`/dispatch/resources/${editingResource.id}`, payload);
      } else {
        const resp = await api.post('/dispatch/resources', payload);
        resourceId = (resp as { resource: { id: string } }).resource?.id;
      }
      if (resourceId && selectedSkills.length > 0) {
        const skillTypeIds = skillTypes.filter(st => selectedSkills.includes(st.name)).map(st => st.id);
        await api.put(`/dispatch/resources/${resourceId}/skills`, { skill_type_ids: skillTypeIds });
      } else if (resourceId && selectedSkills.length === 0 && editingResource) {
        await api.put(`/dispatch/resources/${resourceId}/skills`, { skill_type_ids: [] });
      }
      setShowForm(false);
      fetchResources();
    } catch (e: unknown) {
      setResError(e instanceof Error ? e.message : 'Failed to save resource');
    }
  };

  const updateStatus = async (id: string, current_status: string) => {
    try {
      setResError(null);
      await api.put(`/dispatch/resources/${id}`, { current_status });
      fetchResources();
    } catch (e: unknown) {
      setResError(e instanceof Error ? e.message : 'Failed to update status');
    }
  };

  const statusColors: Record<string, string> = {
    available: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    busy: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
    on_break: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
    off_shift: 'bg-surface-hover text-text-primary',
    unavailable: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-heading">Resource Management</h2>
        {!isReadOnly && (
          <button onClick={() => openForm()} className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 flex items-center gap-1.5">
            <Plus className="h-3 w-3" /> Add Resource
          </button>
        )}
      </div>

      {resError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300 flex items-center justify-between">
          <span>{resError}</span>
          <button onClick={() => setResError(null)} className="ml-2 underline text-xs">Dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard icon={Users} label="Total Resources" value={resources.length} />
        <StatCard icon={Activity} label="Available" value={resources.filter(r => r.current_status === 'available').length} />
        <StatCard icon={Truck} label="Busy" value={resources.filter(r => r.current_status === 'busy').length} />
        <StatCard icon={Clock} label="Off Shift" value={resources.filter(r => r.current_status === 'off_shift').length} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {resources.map(r => (
          <div key={r.id} className="bg-surface border border-border rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-semibold text-heading">{r.name}</h3>
                <p className="text-xs text-muted">{r.role} {r.territory_name ? `- ${r.territory_name}` : ''}</p>
              </div>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${statusColors[r.current_status] || statusColors.unavailable}`}>
                {r.current_status.replace(/_/g, ' ')}
              </span>
            </div>
            <div className="mt-3 space-y-1.5 text-xs text-muted">
              {r.email && <div className="flex items-center gap-1.5"><MessageSquare className="h-3 w-3" />{r.email}</div>}
              {r.phone && <div className="flex items-center gap-1.5"><Activity className="h-3 w-3" />{r.phone}</div>}
              <div className="flex items-center gap-1.5"><Clock className="h-3 w-3" />{r.shift_start} - {r.shift_end}</div>
              <div className="flex items-center gap-1.5"><Layers className="h-3 w-3" />Active: {r.active_jobs}/{r.max_concurrent_jobs} jobs</div>
              {r.skills && r.skills.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {r.skills.map(s => <span key={s} className="px-1.5 py-0.5 bg-surface-secondary rounded text-[10px]">{s}</span>)}
                </div>
              )}
            </div>
            {!isReadOnly && (
              <div className="flex gap-1.5 mt-3">
                <select value={r.current_status} onChange={e => updateStatus(r.id, e.target.value)}
                  className="text-[10px] px-2 py-1 rounded border border-border bg-surface flex-1">
                  <option value="available">Available</option>
                  <option value="busy">Busy</option>
                  <option value="on_break">On Break</option>
                  <option value="off_shift">Off Shift</option>
                  <option value="unavailable">Unavailable</option>
                </select>
                <button onClick={() => openForm(r)} className="text-[10px] px-2 py-1 rounded bg-surface-secondary text-muted hover:text-heading">Edit</button>
              </div>
            )}
          </div>
        ))}
        {resources.length === 0 && (
          <div className="col-span-3">
            <EmptyState
              icon={Wrench}
              title="No resources configured yet"
              description="Add the technicians, vehicles, or crews that can be assigned to dispatch jobs."
              primaryAction={!isReadOnly ? {
                label: 'Add Resource',
                icon: Plus,
                onClick: () => openForm(),
              } : undefined}
              variant="compact"
            />
          </div>
        )}
      </div>

      {showForm && (
        <Modal open onClose={() => setShowForm(false)} ariaLabel={editingResource ? 'Edit Resource' : 'New Resource'} panelClassName="bg-surface border border-border rounded-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="font-semibold text-heading">{editingResource ? 'Edit Resource' : 'New Resource'}</h3>
              <button onClick={() => setShowForm(false)} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Name *</label>
                <input type="text" value={formData.name} onChange={e => setFormData(p => ({...p, name: e.target.value}))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Email</label>
                  <input type="email" value={formData.email} onChange={e => setFormData(p => ({...p, email: e.target.value}))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Phone</label>
                  <input type="tel" value={formData.phone} onChange={e => setFormData(p => ({...p, phone: e.target.value}))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Role</label>
                  <select value={formData.role} onChange={e => setFormData(p => ({...p, role: e.target.value}))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm">
                    <option value="field_worker">Field Worker</option>
                    <option value="technician">Technician</option>
                    <option value="supervisor">Supervisor</option>
                    <option value="dispatcher">Dispatcher</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Territory</label>
                  <select value={formData.territory_id} onChange={e => setFormData(p => ({...p, territory_id: e.target.value}))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm">
                    <option value="">None</option>
                    {territories.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Shift Start</label>
                  <input type="time" value={formData.shift_start} onChange={e => setFormData(p => ({...p, shift_start: e.target.value}))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Shift End</label>
                  <input type="time" value={formData.shift_end} onChange={e => setFormData(p => ({...p, shift_end: e.target.value}))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Max Jobs</label>
                  <input type="number" min={1} max={20} value={formData.max_concurrent_jobs} onChange={e => setFormData(p => ({...p, max_concurrent_jobs: parseInt(e.target.value)||3}))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm" />
                </div>
              </div>
              {skillTypes.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Skills</label>
                  <div className="flex flex-wrap gap-2">
                    {skillTypes.map(st => {
                      const sel = selectedSkills.includes(st.name);
                      return (
                        <button key={st.id} type="button"
                          onClick={() => setSelectedSkills(prev => sel ? prev.filter(s => s !== st.name) : [...prev, st.name])}
                          className={`px-2 py-1 rounded text-xs border ${sel ? 'bg-primary/20 border-primary text-primary' : 'bg-surface border-border text-muted'}`}
                        >
                          {st.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-heading bg-surface-secondary">Cancel</button>
              <button onClick={saveResource} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90">Save</button>
            </div>
        </Modal>
      )}
    </div>
  );
}

// ============ REPORTING VIEW ============

function ReportingView({ data, fetchReporting }: { data: ReportingData | null; fetchReporting: () => void }) {
  if (!data) return <SkeletonRows count={5} rowClassName="h-16" />;

  const m = data.metrics;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-heading">Dispatch Analytics</h2>
        <button onClick={fetchReporting} className="p-2 text-muted hover:text-heading"><RefreshCw className="h-4 w-4" /></button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard icon={Clipboard} label="Total Jobs" value={m.totalJobs as number} />
        <StatCard icon={CheckCircle2} label="Completed" value={m.completedJobs as number} sub={`${m.completionRate}% rate`} />
        <StatCard icon={Clock} label="Avg Completion" value={`${m.avgCompletionHours}h`} />
        <StatCard icon={Activity} label="Active Now" value={m.activeJobs as number} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard icon={TrendingUp} label="Avg Dispatch Time" value={`${m.avgTimeToDispatchMinutes}m`} />
        <StatCard icon={Wrench} label="Avg Time on Job" value={`${m.avgTimeOnJobMinutes}m`} />
        <StatCard icon={ArrowLeftRight} label="Reassignment Rate" value={`${m.reassignmentRate}%`} sub={`${m.reassignmentCount} total`} />
        <StatCard icon={AlertTriangle} label="Exception Rate" value={`${m.exceptionRate}%`} sub={`${m.exceptionCount} total`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-semibold text-heading mb-3">Exception Breakdown</h3>
          {data.exceptionBreakdown.length === 0 ? (
            <p className="text-xs text-muted">No exceptions recorded</p>
          ) : (
            <div className="space-y-2">
              {data.exceptionBreakdown.map(e => (
                <div key={e.exception_type} className="flex items-center justify-between">
                  <span className="text-xs text-heading capitalize">{e.exception_type.replace(/_/g, ' ')}</span>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-2 bg-surface-secondary rounded-full overflow-hidden">
                      <div className="h-full bg-red-400 rounded-full" style={{ width: `${Math.min(100, (e.count / Math.max(1, m.exceptionCount as number)) * 100)}%` }} />
                    </div>
                    <span className="text-xs text-muted w-6 text-right">{e.count}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <h3 className="text-sm font-semibold text-heading mb-3">Territory Performance</h3>
          {data.territoryPerformance.length === 0 ? (
            <p className="text-xs text-muted">No territory data</p>
          ) : (
            <div className="space-y-2">
              {data.territoryPerformance.map(t => (
                <div key={t.territory_name} className="flex items-center justify-between">
                  <span className="text-xs text-heading">{t.territory_name}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">{t.completed}/{t.total_jobs}</span>
                    <div className="w-20 h-2 bg-surface-secondary rounded-full overflow-hidden">
                      <div className="h-full bg-green-400 rounded-full" style={{ width: `${t.total_jobs > 0 ? (t.completed / t.total_jobs) * 100 : 0}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-heading mb-3">Resource Performance</h3>
        {data.resourcePerformance.length === 0 ? (
          <p className="text-xs text-muted">No resource data</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="p-2 text-left text-muted font-medium">Resource</th>
                  <th className="p-2 text-right text-muted font-medium">Total</th>
                  <th className="p-2 text-right text-muted font-medium">Completed</th>
                  <th className="p-2 text-right text-muted font-medium">Rate</th>
                  <th className="p-2 text-right text-muted font-medium">Avg Duration</th>
                </tr>
              </thead>
              <tbody>
                {data.resourcePerformance.map(r => (
                  <tr key={r.resource_name} className="border-b border-border">
                    <td className="p-2 text-heading font-medium">{r.resource_name}</td>
                    <td className="p-2 text-right text-muted">{r.total_jobs}</td>
                    <td className="p-2 text-right text-muted">{r.completed}</td>
                    <td className="p-2 text-right text-heading">{r.total_jobs > 0 ? ((r.completed/r.total_jobs)*100).toFixed(0) : 0}%</td>
                    <td className="p-2 text-right text-muted">{r.avg_duration ? `${Math.round(r.avg_duration)}m` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="text-sm font-semibold text-heading mb-3">Daily Trend</h3>
        {data.dailyTrend.length === 0 ? (
          <p className="text-xs text-muted">No trend data</p>
        ) : (
          <div className="flex items-end gap-1 h-32">
            {data.dailyTrend.slice(-30).map(d => {
              const maxVal = Math.max(...data.dailyTrend.map(x => Math.max(x.created, x.completed)), 1);
              return (
                <div key={d.date} className="flex-1 flex flex-col items-center gap-0.5" title={`${d.date}: ${d.created} created, ${d.completed} completed`}>
                  <div className="w-full flex gap-px">
                    <div className="flex-1 bg-blue-400 rounded-t" style={{ height: `${(d.created / maxVal) * 100}px` }} />
                    <div className="flex-1 bg-green-400 rounded-t" style={{ height: `${(d.completed / maxVal) * 100}px` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex gap-4 mt-2 text-[10px] text-muted">
          <span className="flex items-center gap-1"><div className="w-2 h-2 bg-blue-400 rounded" /> Created</span>
          <span className="flex items-center gap-1"><div className="w-2 h-2 bg-green-400 rounded" /> Completed</span>
        </div>
      </div>
    </div>
  );
}

// ============ ADMIN VIEW ============

function AdminView({ territories, skillTypes, notifTemplates, assignmentRules, isReadOnly,
  fetchTerritories, fetchSkillTypes, fetchNotifTemplates, fetchAssignmentRules }: {
  territories: Territory[]; skillTypes: SkillType[]; notifTemplates: NotificationTemplate[];
  assignmentRules: AssignmentRule[]; isReadOnly: boolean;
  fetchTerritories: () => void; fetchSkillTypes: () => void;
  fetchNotifTemplates: () => void; fetchAssignmentRules: () => void;
}) {
  const [adminTab, setAdminTab] = useState<'territories' | 'skills' | 'notifications' | 'rules'>('territories');
  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState<string>('');
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [adminError, setAdminError] = useState<string | null>(null);

  const openForm = (type: string, data?: Territory | SkillType | NotificationTemplate | AssignmentRule | Record<string, unknown>) => {
    setFormType(type);
    setFormData((data as Record<string, unknown>) || {});
    setShowForm(true);
  };

  const saveForm = async () => {
    try {
      setAdminError(null);
      if (formType === 'territory') {
        if (formData.id) await api.put(`/dispatch/territories/${formData.id}`, formData);
        else await api.post('/dispatch/territories', formData);
        fetchTerritories();
      } else if (formType === 'skill') {
        if (formData.id) await api.put(`/dispatch/skill-types/${formData.id}`, formData);
        else await api.post('/dispatch/skill-types', formData);
        fetchSkillTypes();
      } else if (formType === 'notification') {
        if (formData.id) await api.put(`/dispatch/notification-templates/${formData.id}`, formData);
        else await api.post('/dispatch/notification-templates', formData);
        fetchNotifTemplates();
      } else if (formType === 'rule') {
        if (formData.id) await api.put(`/dispatch/assignment-rules/${formData.id}`, formData);
        else await api.post('/dispatch/assignment-rules', formData);
        fetchAssignmentRules();
      }
      setShowForm(false);
    } catch (e: unknown) {
      setAdminError(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  const deleteItem = async (type: string, id: string) => {
    try {
      setAdminError(null);
      if (type === 'territory') { await api.delete(`/dispatch/territories/${id}`); fetchTerritories(); }
      else if (type === 'skill') { await api.delete(`/dispatch/skill-types/${id}`); fetchSkillTypes(); }
      else if (type === 'notification') { await api.delete(`/dispatch/notification-templates/${id}`); fetchNotifTemplates(); }
      else if (type === 'rule') { await api.delete(`/dispatch/assignment-rules/${id}`); fetchAssignmentRules(); }
    } catch (e: unknown) {
      setAdminError(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  const adminTabs = [
    { key: 'territories' as const, label: 'Territories', icon: MapPin },
    { key: 'skills' as const, label: 'Skill Types', icon: Wrench },
    { key: 'notifications' as const, label: 'Notifications', icon: Bell },
    { key: 'rules' as const, label: 'Assignment Rules', icon: Shield },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border">
        {adminTabs.map(t => (
          <button key={t.key} onClick={() => setAdminTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${adminTab === t.key ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-heading'}`}>
            <t.icon className="h-3 w-3" />{t.label}
          </button>
        ))}
      </div>

      {adminError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300 flex items-center justify-between">
          <span>{adminError}</span>
          <button onClick={() => setAdminError(null)} className="ml-2 underline text-xs">Dismiss</button>
        </div>
      )}

      {adminTab === 'territories' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">Define service territories for dispatching</p>
            {!isReadOnly && <button onClick={() => openForm('territory')} className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 flex items-center gap-1"><Plus className="h-3 w-3" /> Add</button>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {territories.map(t => (
              <div key={t.id} className="bg-surface border border-border rounded-xl p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-heading">{t.name}</h3>
                    <p className="text-xs text-muted">{t.region || 'No region'}</p>
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-surface-hover text-text-primary'}`}>{t.status}</span>
                </div>
                {t.description && <p className="text-xs text-muted mt-2">{t.description}</p>}
                <div className="flex gap-4 mt-3 text-xs text-muted">
                  <span>{t.resource_count} resources</span>
                  <span>{t.active_jobs} active jobs</span>
                </div>
                {!isReadOnly && (
                  <div className="flex gap-1.5 mt-3">
                    <button onClick={() => openForm('territory', t)} className="text-[10px] px-2 py-1 rounded bg-surface-secondary text-muted hover:text-heading">Edit</button>
                    <button onClick={() => deleteItem('territory', t.id)} className="text-[10px] px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100">Delete</button>
                  </div>
                )}
              </div>
            ))}
            {territories.length === 0 && (
              <div className="col-span-3">
                <EmptyState
                  icon={MapPin}
                  title="No territories defined"
                  description="Group resources and jobs by service area so dispatch can route work efficiently."
                  primaryAction={!isReadOnly ? { label: 'Add Territory', icon: Plus, onClick: () => openForm('territory') } : undefined}
                  variant="compact"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {adminTab === 'skills' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">Manage skill types for resource matching</p>
            {!isReadOnly && <button onClick={() => openForm('skill')} className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 flex items-center gap-1"><Plus className="h-3 w-3" /> Add</button>}
          </div>
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="p-2 text-left text-muted font-medium">Name</th>
                  <th className="p-2 text-left text-muted font-medium">Category</th>
                  <th className="p-2 text-left text-muted font-medium">Resources</th>
                  <th className="p-2 text-left text-muted font-medium">Status</th>
                  {!isReadOnly && <th className="p-2 text-left text-muted font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {skillTypes.map(s => (
                  <tr key={s.id} className="border-b border-border">
                    <td className="p-2 text-heading font-medium">{s.name}</td>
                    <td className="p-2 text-muted">{s.category}</td>
                    <td className="p-2 text-muted">{s.resource_count}</td>
                    <td className="p-2"><span className={`px-1.5 py-0.5 rounded text-[10px] ${s.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-surface-hover text-text-primary'}`}>{s.status}</span></td>
                    {!isReadOnly && (
                      <td className="p-2">
                        <div className="flex gap-1">
                          <button onClick={() => openForm('skill', s)} className="text-[10px] px-2 py-1 rounded bg-surface-secondary text-muted hover:text-heading">Edit</button>
                          <button onClick={() => deleteItem('skill', s.id)} className="text-[10px] px-2 py-1 rounded text-red-600 hover:bg-red-50">Delete</button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {skillTypes.length === 0 && (
                  <tr><td colSpan={5} className="p-0">
                    <EmptyState
                      icon={Wrench}
                      title="No skill types defined"
                      description="Define the skills your resources have so jobs can be matched to qualified people."
                      primaryAction={!isReadOnly ? { label: 'Add Skill Type', icon: Plus, onClick: () => openForm('skill') } : undefined}
                      variant="compact"
                    />
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adminTab === 'notifications' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">Configure notification templates for dispatch events</p>
            {!isReadOnly && <button onClick={() => openForm('notification')} className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 flex items-center gap-1"><Plus className="h-3 w-3" /> Add</button>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {notifTemplates.map(t => (
              <div key={t.id} className="bg-surface border border-border rounded-xl p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-heading">{t.name}</h3>
                    <div className="flex gap-2 mt-1">
                      <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{t.trigger_event.replace(/_/g, ' ')}</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-surface-hover text-text-primary rounded">{t.channel}</span>
                    </div>
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.is_active ? 'bg-green-100 text-green-700' : 'bg-surface-hover text-text-primary'}`}>{t.is_active ? 'Active' : 'Inactive'}</span>
                </div>
                {t.subject && <p className="text-xs text-muted mt-2">Subject: {t.subject}</p>}
                <p className="text-xs text-muted mt-1 line-clamp-2">{t.body_template}</p>
                {!isReadOnly && (
                  <div className="flex gap-1.5 mt-3">
                    <button onClick={() => openForm('notification', t)} className="text-[10px] px-2 py-1 rounded bg-surface-secondary text-muted hover:text-heading">Edit</button>
                    <button onClick={() => deleteItem('notification', t.id)} className="text-[10px] px-2 py-1 rounded text-red-600 hover:bg-red-50">Delete</button>
                  </div>
                )}
              </div>
            ))}
            {notifTemplates.length === 0 && (
              <div className="col-span-2">
                <EmptyState
                  icon={Bell}
                  title="No notification templates"
                  description="Create templates to notify customers and crews about job updates over email or SMS."
                  primaryAction={!isReadOnly ? { label: 'Add Template', icon: Plus, onClick: () => openForm('notification') } : undefined}
                  variant="compact"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {adminTab === 'rules' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">Configure automatic assignment rules</p>
            {!isReadOnly && <button onClick={() => openForm('rule')} className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 flex items-center gap-1"><Plus className="h-3 w-3" /> Add</button>}
          </div>
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="p-2 text-left text-muted font-medium">Name</th>
                  <th className="p-2 text-left text-muted font-medium">Type</th>
                  <th className="p-2 text-left text-muted font-medium">Priority</th>
                  <th className="p-2 text-left text-muted font-medium">Status</th>
                  {!isReadOnly && <th className="p-2 text-left text-muted font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {assignmentRules.map(r => (
                  <tr key={r.id} className="border-b border-border">
                    <td className="p-2"><div className="text-heading font-medium">{r.name}</div><div className="text-muted">{r.description}</div></td>
                    <td className="p-2"><span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px]">{r.rule_type.replace(/_/g, ' ')}</span></td>
                    <td className="p-2 text-muted">{r.priority}</td>
                    <td className="p-2"><span className={`px-1.5 py-0.5 rounded text-[10px] ${r.is_active ? 'bg-green-100 text-green-700' : 'bg-surface-hover text-text-primary'}`}>{r.is_active ? 'Active' : 'Inactive'}</span></td>
                    {!isReadOnly && (
                      <td className="p-2">
                        <div className="flex gap-1">
                          <button onClick={() => openForm('rule', r)} className="text-[10px] px-2 py-1 rounded bg-surface-secondary text-muted hover:text-heading">Edit</button>
                          <button onClick={() => deleteItem('rule', r.id)} className="text-[10px] px-2 py-1 rounded text-red-600 hover:bg-red-50">Delete</button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {assignmentRules.length === 0 && (
                  <tr><td colSpan={5} className="p-0">
                    <EmptyState
                      icon={Shield}
                      title="No assignment rules defined"
                      description="Add rules so dispatch automatically picks the right resource based on territory, skills, or priority."
                      primaryAction={!isReadOnly ? { label: 'Add Rule', icon: Plus, onClick: () => openForm('rule') } : undefined}
                      variant="compact"
                    />
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showForm && (
        <AdminFormModal formType={formType} formData={formData} setFormData={setFormData}
          onClose={() => setShowForm(false)} onSave={saveForm} />
      )}
    </div>
  );
}

function AdminFormModal({ formType, formData, setFormData, onClose, onSave }: {
  formType: string; formData: Record<string, unknown>;
  setFormData: (d: Record<string, unknown>) => void;
  onClose: () => void; onSave: () => void;
}) {
  const titles: Record<string, string> = { territory: 'Territory', skill: 'Skill Type', notification: 'Notification Template', rule: 'Assignment Rule' };
  return (
    <Modal open onClose={onClose} ariaLabel={`${formData.id ? 'Edit' : 'New'} ${titles[formType]}`} panelClassName="bg-surface border border-border rounded-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-semibold text-heading">{formData.id ? 'Edit' : 'New'} {titles[formType]}</h3>
          <button onClick={onClose} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Name *</label>
            <input type="text" value={(formData.name as string) || ''} onChange={e => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          {(formType === 'territory' || formType === 'skill' || formType === 'rule') && (
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Description</label>
              <textarea value={(formData.description as string) || ''} onChange={e => setFormData({ ...formData, description: e.target.value })}
                rows={2} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          )}
          {formType === 'territory' && (
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Region</label>
              <input type="text" value={(formData.region as string) || ''} onChange={e => setFormData({ ...formData, region: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          )}
          {formType === 'skill' && (
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Category</label>
              <input type="text" value={(formData.category as string) || 'general'} onChange={e => setFormData({ ...formData, category: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          )}
          {formType === 'notification' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Trigger Event *</label>
                  <select value={(formData.trigger_event as string) || ''} onChange={e => setFormData({ ...formData, trigger_event: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm">
                    <option value="">Select...</option>
                    {TRIGGER_EVENTS.map(e => <option key={e} value={e}>{e.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Channel</label>
                  <select value={(formData.channel as string) || 'sms'} onChange={e => setFormData({ ...formData, channel: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm">
                    <option value="sms">SMS</option>
                    <option value="email">Email</option>
                    <option value="both">Both</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Subject</label>
                <input type="text" value={(formData.subject as string) || ''} onChange={e => setFormData({ ...formData, subject: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Body Template *</label>
                <textarea value={(formData.body_template as string) || ''} onChange={e => setFormData({ ...formData, body_template: e.target.value })}
                  rows={4} placeholder="Use {{job_title}}, {{contact_name}}, {{eta}}, etc."
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
            </>
          )}
          {formType === 'rule' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Rule Type</label>
                <select value={(formData.rule_type as string) || 'auto_assign'} onChange={e => setFormData({ ...formData, rule_type: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm">
                  <option value="auto_assign">Auto Assign</option>
                  <option value="round_robin">Round Robin</option>
                  <option value="skill_match">Skill Match</option>
                  <option value="territory_match">Territory Match</option>
                  <option value="capacity_based">Capacity Based</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Priority</label>
                <input type="number" min={0} value={(formData.priority as number) || 0} onChange={e => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-heading bg-surface-secondary">Cancel</button>
          <button onClick={onSave} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90">Save</button>
        </div>
    </Modal>
  );
}

// ============ JOB FORM MODAL ============

function JobFormModal({ job, territories, resources, teamMembers, skillTypes, onClose, onSaved }: {
  job: DispatchJob | null; territories: Territory[]; resources: Resource[];
  teamMembers: TeamMember[]; skillTypes: SkillType[];
  onClose: () => void; onSaved: () => void;
}) {
  const [formData, setFormData] = useState({
    title: job?.title || '', description: job?.description || '', status: job?.status || 'pending',
    priority: job?.priority || 'medium', assignee_user_id: job?.assignee_user_id || '',
    contact_name: job?.contact_name || '', contact_phone: job?.contact_phone || '',
    contact_email: job?.contact_email || '', address: job?.address || '',
    territory_id: job?.territory_id || '', resource_id: job?.resource_id || '',
    job_type: job?.job_type || 'general', scheduled_at: job?.scheduled_at ? job.scheduled_at.slice(0, 16) : '',
    estimated_duration_minutes: job?.estimated_duration_minutes || '',
    notes: job?.notes || '',
    eta_start: job?.eta_start ? job.eta_start.slice(0, 16) : '',
    eta_end: job?.eta_end ? job.eta_end.slice(0, 16) : '',
    required_skills: job?.required_skills || [] as string[],
  });

  const [formError, setFormError] = useState<string | null>(null);

  const saveJob = async () => {
    if (!formData.title) return;
    try {
      setFormError(null);
      const payload = {
        ...formData,
        assignee_user_id: formData.assignee_user_id || null,
        territory_id: formData.territory_id || null,
        resource_id: formData.resource_id || null,
        scheduled_at: formData.scheduled_at || null,
        estimated_duration_minutes: formData.estimated_duration_minutes ? parseInt(String(formData.estimated_duration_minutes)) : null,
        eta_start: formData.eta_start || null,
        eta_end: formData.eta_end || null,
        required_skills: formData.required_skills.length > 0 ? formData.required_skills : null,
      };
      if (job) {
        await api.put(`/dispatch/jobs/${job.id}`, payload);
      } else {
        await api.post('/dispatch/jobs', payload);
      }
      onSaved();
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Failed to save job');
    }
  };

  const inputCls = "w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

  return (
    <Modal open onClose={onClose} ariaLabel={job ? 'Edit Job' : 'New Job'} panelClassName="bg-surface border border-border rounded-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-semibold text-heading">{job ? 'Edit Job' : 'New Job'}</h3>
          <button onClick={onClose} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-4 space-y-4">
          {formError && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2 text-xs text-red-700 dark:text-red-300 flex items-center justify-between">
              <span>{formError}</span>
              <button onClick={() => setFormError(null)} className="ml-2 underline text-[10px]">Dismiss</button>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Title *</label>
            <input type="text" value={formData.title} onChange={e => setFormData(p => ({...p, title: e.target.value}))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Description</label>
            <textarea value={formData.description} onChange={e => setFormData(p => ({...p, description: e.target.value}))} rows={2} className={inputCls} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Status</label>
              <select value={formData.status} onChange={e => setFormData(p => ({...p, status: e.target.value}))} className={inputCls}>
                {STATUS_FLOW.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Priority</label>
              <select value={formData.priority} onChange={e => setFormData(p => ({...p, priority: e.target.value as 'low' | 'medium' | 'high' | 'urgent'}))} className={inputCls}>
                <option value="low">Low</option><option value="medium">Medium</option>
                <option value="high">High</option><option value="urgent">Urgent</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Job Type</label>
              <input type="text" value={formData.job_type} onChange={e => setFormData(p => ({...p, job_type: e.target.value}))} className={inputCls} />
            </div>
          </div>
          {skillTypes.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Required Skills</label>
              <div className="flex flex-wrap gap-2">
                {skillTypes.map(st => {
                  const selected = formData.required_skills.includes(st.name);
                  return (
                    <button key={st.id} type="button"
                      onClick={() => setFormData(p => ({
                        ...p, required_skills: selected
                          ? p.required_skills.filter((s: string) => s !== st.name)
                          : [...p.required_skills, st.name],
                      }))}
                      className={`px-2 py-1 rounded text-xs border ${selected ? 'bg-primary/20 border-primary text-primary' : 'bg-surface border-border text-muted'}`}
                    >
                      {st.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Contact Name</label>
              <input type="text" value={formData.contact_name} onChange={e => setFormData(p => ({...p, contact_name: e.target.value}))} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Contact Phone</label>
              <input type="tel" value={formData.contact_phone} onChange={e => setFormData(p => ({...p, contact_phone: e.target.value}))} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Contact Email</label>
              <input type="email" value={formData.contact_email} onChange={e => setFormData(p => ({...p, contact_email: e.target.value}))} className={inputCls} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Address</label>
            <input type="text" value={formData.address} onChange={e => setFormData(p => ({...p, address: e.target.value}))} className={inputCls} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Territory</label>
              <select value={formData.territory_id} onChange={e => setFormData(p => ({...p, territory_id: e.target.value}))} className={inputCls}>
                <option value="">None</option>
                {territories.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Resource</label>
              <select value={formData.resource_id} onChange={e => setFormData(p => ({...p, resource_id: e.target.value}))} className={inputCls}>
                <option value="">Unassigned</option>
                {resources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Assignee</label>
              <select value={formData.assignee_user_id} onChange={e => setFormData(p => ({...p, assignee_user_id: e.target.value}))} className={inputCls}>
                <option value="">Unassigned</option>
                {teamMembers.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Scheduled At</label>
              <input type="datetime-local" value={formData.scheduled_at} onChange={e => setFormData(p => ({...p, scheduled_at: e.target.value}))} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">ETA Start</label>
              <input type="datetime-local" value={formData.eta_start} onChange={e => setFormData(p => ({...p, eta_start: e.target.value}))} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">ETA End</label>
              <input type="datetime-local" value={formData.eta_end} onChange={e => setFormData(p => ({...p, eta_end: e.target.value}))} className={inputCls} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Est. Duration (minutes)</label>
            <input type="number" min={0} value={formData.estimated_duration_minutes} onChange={e => setFormData(p => ({...p, estimated_duration_minutes: e.target.value}))} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Notes</label>
            <textarea value={formData.notes} onChange={e => setFormData(p => ({...p, notes: e.target.value}))} rows={2} className={inputCls} />
          </div>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-heading bg-surface-secondary">Cancel</button>
          <button onClick={saveJob} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90">Save</button>
        </div>
    </Modal>
  );
}

// ============ JOB DETAIL MODAL ============

function JobDetailModal({ detail, isReadOnly, transitionJob, onClose, onRefresh, refreshAll }: {
  detail: { job: DispatchJob; events: JobEvent[]; exceptions: JobException[]; attachments: JobAttachment[] };
  isReadOnly: boolean; transitionJob: (id: string, s: string, n?: string) => void;
  onClose: () => void; onRefresh: () => void; refreshAll: () => void;
}) {
  const [detailTab, setDetailTab] = useState<'overview' | 'timeline' | 'exceptions' | 'attachments'>('overview');
  const [showExceptionForm, setShowExceptionForm] = useState(false);
  const [showAttachmentForm, setShowAttachmentForm] = useState(false);
  const [showFollowUpForm, setShowFollowUpForm] = useState(false);
  const [exceptionData, setExceptionData] = useState({ exception_type: 'delay', reason: '' });
  const [attachmentData, setAttachmentData] = useState({ attachment_type: 'note', title: '', content: '' });
  const [followUpData, setFollowUpData] = useState({ title: '', description: '', notes: '' });

  const { job, events, exceptions, attachments } = detail;
  const nextStates = VALID_TRANSITIONS[job.status] || [];

  const [detailError, setDetailError] = useState<string | null>(null);

  const submitException = async () => {
    if (!exceptionData.reason) return;
    try {
      setDetailError(null);
      await api.post(`/dispatch/jobs/${job.id}/exceptions`, exceptionData);
      setShowExceptionForm(false);
      setExceptionData({ exception_type: 'delay', reason: '' });
      onRefresh();
    } catch (e: unknown) {
      setDetailError(e instanceof Error ? e.message : 'Failed to report exception');
    }
  };

  const submitAttachment = async () => {
    if (!attachmentData.content && !attachmentData.title) return;
    try {
      setDetailError(null);
      await api.post(`/dispatch/jobs/${job.id}/attachments`, attachmentData);
      setShowAttachmentForm(false);
      setAttachmentData({ attachment_type: 'note', title: '', content: '' });
      onRefresh();
    } catch (e: unknown) {
      setDetailError(e instanceof Error ? e.message : 'Failed to add attachment');
    }
  };

  const submitFollowUp = async () => {
    try {
      setDetailError(null);
      await api.post(`/dispatch/jobs/${job.id}/follow-up`, followUpData);
      setShowFollowUpForm(false);
      setFollowUpData({ title: '', description: '', notes: '' });
      refreshAll();
    } catch (e: unknown) {
      setDetailError(e instanceof Error ? e.message : 'Failed to create follow-up');
    }
  };

  const inputCls = "w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

  return (
    <Modal open onClose={onClose} ariaLabel={job.title} panelClassName="bg-surface border border-border rounded-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h3 className="font-semibold text-heading">{job.title}</h3>
            <div className="flex items-center gap-2 mt-1">
              <StatusBadge status={job.status} />
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${PRIORITY_BADGES[job.priority]}`}>{job.priority}</span>
              {job.is_follow_up && <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded">Follow-up</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
        </div>

        {!isReadOnly && nextStates.length > 0 && (
          <div className="px-4 py-2 border-b border-border bg-surface-secondary flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted">Move to:</span>
            {nextStates.map(s => {
              const st = STATUS_FLOW.find(x => x.key === s);
              return (
                <button key={s} onClick={() => transitionJob(job.id, s)}
                  className={`text-xs px-2.5 py-1 rounded ${st?.bg || 'bg-surface-hover text-text-primary'} hover:opacity-80`}>
                  {st?.label || s}
                </button>
              );
            })}
            {(job.status === 'incomplete' || job.status === 'completed') && (
              <button onClick={() => setShowFollowUpForm(true)}
                className="text-xs px-2.5 py-1 rounded bg-purple-100 text-purple-700 hover:opacity-80 ml-auto">
                Create Follow-up
              </button>
            )}
          </div>
        )}

        <div className="flex gap-1 px-4 pt-3 border-b border-border">
          {(['overview', 'timeline', 'exceptions', 'attachments'] as const).map(t => (
            <button key={t} onClick={() => setDetailTab(t)}
              className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors capitalize ${detailTab === t ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-heading'}`}>
              {t} {t === 'exceptions' ? `(${exceptions.length})` : t === 'attachments' ? `(${attachments.length})` : t === 'timeline' ? `(${events.length})` : ''}
            </button>
          ))}
        </div>

        <div className="p-4">
          {detailError && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2 text-xs text-red-700 dark:text-red-300 mb-3 flex items-center justify-between">
              <span>{detailError}</span>
              <button onClick={() => setDetailError(null)} className="ml-2 underline text-[10px]">Dismiss</button>
            </div>
          )}

          {detailTab === 'overview' && (
            <div className="space-y-4">
              {job.description && <div><h4 className="text-xs font-medium text-muted mb-1">Description</h4><p className="text-sm text-heading">{job.description}</p></div>}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-xs text-muted">Contact</span><p className="text-heading">{job.contact_name || '-'}</p></div>
                <div><span className="text-xs text-muted">Phone</span><p className="text-heading">{job.contact_phone || '-'}</p></div>
                <div><span className="text-xs text-muted">Email</span><p className="text-heading">{job.contact_email || '-'}</p></div>
                <div><span className="text-xs text-muted">Address</span><p className="text-heading">{job.address || '-'}</p></div>
                <div><span className="text-xs text-muted">Territory</span><p className="text-heading">{job.territory_name || '-'}</p></div>
                <div><span className="text-xs text-muted">Resource</span><p className="text-heading">{job.resource_name || '-'}</p></div>
                <div><span className="text-xs text-muted">Scheduled</span><p className="text-heading">{job.scheduled_at ? new Date(job.scheduled_at).toLocaleString() : '-'}</p></div>
                <div><span className="text-xs text-muted">ETA</span><p className="text-heading">{job.eta_start ? `${new Date(job.eta_start).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} - ${job.eta_end ? new Date(job.eta_end).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '?'}` : '-'}</p></div>
                <div><span className="text-xs text-muted">Est. Duration</span><p className="text-heading">{job.estimated_duration_minutes ? `${job.estimated_duration_minutes}m` : '-'}</p></div>
                <div><span className="text-xs text-muted">Job Type</span><p className="text-heading">{job.job_type}</p></div>
                <div><span className="text-xs text-muted">Created</span><p className="text-heading">{new Date(job.created_at).toLocaleString()}</p></div>
                {job.completed_at && <div><span className="text-xs text-muted">Completed</span><p className="text-heading">{new Date(job.completed_at).toLocaleString()}</p></div>}
              </div>
              {job.notes && <div><h4 className="text-xs font-medium text-muted mb-1">Notes</h4><p className="text-sm text-heading whitespace-pre-wrap">{job.notes}</p></div>}
            </div>
          )}

          {detailTab === 'timeline' && (
            <div className="space-y-3">
              {events.length === 0 ? <p className="text-sm text-muted text-center py-4">No events recorded</p> : (
                <div className="relative">
                  <div className="absolute left-3 top-0 bottom-0 w-px bg-border" />
                  {events.map(e => {
                    const meta = (e.metadata ?? {}) as Record<string, unknown>;
                    const attachmentId = e.event_type === 'attachment_added' && typeof meta.attachment_id === 'string' ? meta.attachment_id as string : null;
                    const inlineAttachment = attachmentId ? attachments.find(a => a.id === attachmentId) : null;
                    const showImage = inlineAttachment && (inlineAttachment.mime_type ?? '').startsWith('image/');
                    return (
                      <div key={e.id} className="relative pl-8 pb-4">
                        <div className="absolute left-1.5 top-1 w-3 h-3 rounded-full bg-primary border-2 border-surface" />
                        <div className="text-xs">
                          <span className="font-medium text-heading capitalize">{e.event_type.replace(/_/g, ' ')}</span>
                          {e.from_status && e.to_status && (
                            <span className="text-muted ml-1">{e.from_status} <ArrowRight className="inline h-3 w-3" /> {e.to_status}</span>
                          )}
                          <p className="text-muted mt-0.5">{e.notes}</p>
                          <p className="text-[10px] text-muted mt-0.5">{new Date(e.created_at).toLocaleString()}</p>
                          {showImage && (
                            <a href={`/api/dispatch/attachments/${inlineAttachment.id}/file`} target="_blank" rel="noreferrer" className="block mt-2">
                              <img
                                src={`/api/dispatch/attachments/${inlineAttachment.id}/file`}
                                alt={inlineAttachment.title || 'Attachment'}
                                className="rounded-lg border border-border max-h-40 object-cover"
                              />
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {detailTab === 'exceptions' && (
            <div className="space-y-3">
              {!isReadOnly && (
                <button onClick={() => setShowExceptionForm(true)}
                  className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-medium hover:bg-red-100 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> Report Exception
                </button>
              )}
              {showExceptionForm && (
                <div className="bg-surface-secondary border border-border rounded-lg p-3 space-y-2">
                  <select value={exceptionData.exception_type} onChange={e => setExceptionData(p => ({...p, exception_type: e.target.value}))} className={inputCls}>
                    {EXCEPTION_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                  </select>
                  <textarea value={exceptionData.reason} onChange={e => setExceptionData(p => ({...p, reason: e.target.value}))} placeholder="Reason..." rows={2} className={inputCls} />
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowExceptionForm(false)} className="text-xs px-3 py-1.5 text-muted">Cancel</button>
                    <button onClick={submitException} className="text-xs px-3 py-1.5 bg-red-600 text-white rounded-lg">Submit</button>
                  </div>
                </div>
              )}
              {exceptions.length === 0 ? <p className="text-sm text-muted text-center py-4">No exceptions</p> : (
                exceptions.map(e => (
                  <div key={e.id} className="bg-surface-secondary border border-border rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-heading capitalize">{e.exception_type.replace(/_/g, ' ')}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${e.resolved_at ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {e.resolved_at ? 'Resolved' : 'Open'}
                      </span>
                    </div>
                    <p className="text-xs text-muted mt-1">{e.reason}</p>
                    {e.resolution && <p className="text-xs text-green-700 mt-1">Resolution: {e.resolution}</p>}
                    <p className="text-[10px] text-muted mt-1">{new Date(e.created_at).toLocaleString()}</p>
                  </div>
                ))
              )}
            </div>
          )}

          {detailTab === 'attachments' && (
            <div className="space-y-3">
              {!isReadOnly && (
                <button onClick={() => setShowAttachmentForm(true)}
                  className="px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs font-medium hover:bg-blue-100 flex items-center gap-1">
                  <FileText className="h-3 w-3" /> Add Note / Attachment
                </button>
              )}
              {showAttachmentForm && (
                <div className="bg-surface-secondary border border-border rounded-lg p-3 space-y-2">
                  <select value={attachmentData.attachment_type} onChange={e => setAttachmentData(p => ({...p, attachment_type: e.target.value}))} className={inputCls}>
                    <option value="note">Field Note</option>
                    <option value="proof_of_service">Proof of Service</option>
                    <option value="proof_of_completion">Proof of Completion</option>
                    <option value="photo">Photo</option>
                    <option value="document">Document</option>
                    <option value="signature">Signature</option>
                  </select>
                  <input type="text" value={attachmentData.title} onChange={e => setAttachmentData(p => ({...p, title: e.target.value}))} placeholder="Title" className={inputCls} />
                  <textarea value={attachmentData.content} onChange={e => setAttachmentData(p => ({...p, content: e.target.value}))} placeholder="Content..." rows={3} className={inputCls} />
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowAttachmentForm(false)} className="text-xs px-3 py-1.5 text-muted">Cancel</button>
                    <button onClick={submitAttachment} className="text-xs px-3 py-1.5 bg-primary text-white rounded-lg">Add</button>
                  </div>
                </div>
              )}
              {attachments.length === 0 ? <p className="text-sm text-muted text-center py-4">No attachments</p> : (
                attachments.map(a => {
                  const isImage = (a.mime_type ?? '').startsWith('image/');
                  const fileUrl = a.object_path ? `/api/dispatch/attachments/${a.id}/file` : a.file_url;
                  return (
                    <div key={a.id} className="bg-surface-secondary border border-border rounded-lg p-3">
                      <div className="flex items-center gap-2">
                        <FileText className="h-3.5 w-3.5 text-muted" />
                        <span className="text-xs font-medium text-heading">{a.title || a.attachment_type.replace(/_/g, ' ')}</span>
                        <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{a.attachment_type.replace(/_/g, ' ')}</span>
                        {a.file_size_bytes ? (
                          <span className="text-[10px] text-muted">{Math.round(a.file_size_bytes / 1024)} KB</span>
                        ) : null}
                      </div>
                      {a.content && <p className="text-xs text-muted mt-1 whitespace-pre-wrap">{a.content}</p>}
                      {isImage && fileUrl && (
                        <a href={fileUrl} target="_blank" rel="noreferrer" className="block mt-2">
                          <img
                            src={fileUrl}
                            alt={a.title || 'Attachment'}
                            className="rounded-lg border border-border max-h-56 object-cover"
                          />
                        </a>
                      )}
                      {!isImage && a.object_path && fileUrl && (
                        <a href={fileUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-600 mt-2 inline-flex items-center gap-1">
                          <FileText className="h-3 w-3" /> Download file
                        </a>
                      )}
                      <p className="text-[10px] text-muted mt-1">{new Date(a.created_at).toLocaleString()}</p>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {showFollowUpForm && (
          <div className="border-t border-border p-4 bg-surface-secondary space-y-2">
            <h4 className="text-xs font-semibold text-heading">Create Follow-up Job</h4>
            <input type="text" value={followUpData.title} onChange={e => setFollowUpData(p => ({...p, title: e.target.value}))} placeholder={`Follow-up: ${job.title}`} className={inputCls} />
            <textarea value={followUpData.description} onChange={e => setFollowUpData(p => ({...p, description: e.target.value}))} placeholder="Description..." rows={2} className={inputCls} />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowFollowUpForm(false)} className="text-xs px-3 py-1.5 text-muted">Cancel</button>
              <button onClick={submitFollowUp} className="text-xs px-3 py-1.5 bg-purple-600 text-white rounded-lg">Create Follow-up</button>
            </div>
          </div>
        )}
    </Modal>
  );
}
