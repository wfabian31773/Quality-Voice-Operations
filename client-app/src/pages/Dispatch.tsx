import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Truck, Plus, X, GripVertical, User, Clock, AlertTriangle } from 'lucide-react';

interface DispatchJob {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'assigned' | 'in_progress' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee_user_id: string | null;
  assignee_email: string | null;
  contact_id: string | null;
  contact_name: string;
  scheduled_at: string | null;
  completed_at: string | null;
  notes: string;
  created_at: string;
}

interface TeamMember {
  id: string;
  email: string;
}

const COLUMNS: { key: DispatchJob['status']; label: string; color: string }[] = [
  { key: 'pending', label: 'Pending', color: 'border-t-yellow-400' },
  { key: 'assigned', label: 'Assigned', color: 'border-t-blue-400' },
  { key: 'in_progress', label: 'In Progress', color: 'border-t-orange-400' },
  { key: 'done', label: 'Done', color: 'border-t-green-400' },
];

const PRIORITY_BADGES: Record<string, string> = {
  low: 'bg-gray-100 text-gray-700 dark:bg-gray-700/30 dark:text-gray-300',
  medium: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  urgent: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
};

export default function Dispatch() {
  const { user } = useAuth();
  const isReadOnly = !['tenant_owner', 'operations_manager'].includes(user?.role ?? '');
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<DispatchJob | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    title: '', description: '', status: 'pending', priority: 'medium',
    assignee_user_id: '', contact_name: '', scheduled_at: '', notes: '',
  });

  const fetchJobs = useCallback(async () => {
    try {
      const data = await api.get<{ jobs: DispatchJob[] }>('/dispatch/jobs?limit=200');
      setJobs(data.jobs);
    } catch {
      setError('Failed to load dispatch jobs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  useEffect(() => {
    api.get<{ users: TeamMember[] }>('/users?limit=100')
      .then(data => setTeamMembers(data.users))
      .catch(() => {});
  }, []);

  const openForm = (job?: DispatchJob) => {
    if (job) {
      setEditingJob(job);
      setFormData({
        title: job.title,
        description: job.description,
        status: job.status,
        priority: job.priority,
        assignee_user_id: job.assignee_user_id || '',
        contact_name: job.contact_name || '',
        scheduled_at: job.scheduled_at ? job.scheduled_at.slice(0, 16) : '',
        notes: job.notes,
      });
    } else {
      setEditingJob(null);
      setFormData({ title: '', description: '', status: 'pending', priority: 'medium', assignee_user_id: '', contact_name: '', scheduled_at: '', notes: '' });
    }
    setShowForm(true);
  };

  const saveJob = async () => {
    if (!formData.title) return;
    try {
      const payload = {
        ...formData,
        assignee_user_id: formData.assignee_user_id || null,
        scheduled_at: formData.scheduled_at || null,
      };
      if (editingJob) {
        await api.put(`/dispatch/jobs/${editingJob.id}`, payload);
      } else {
        await api.post('/dispatch/jobs', payload);
      }
      setShowForm(false);
      fetchJobs();
    } catch {
      setError('Failed to save job');
    }
  };

  const moveJob = async (jobId: string, newStatus: string) => {
    if (isReadOnly) return;
    try {
      await api.put(`/dispatch/jobs/${jobId}`, { status: newStatus });
      fetchJobs();
    } catch {
      setError('Failed to update job status');
    }
  };

  const getJobsByStatus = (status: string) => jobs.filter(j => j.status === status);

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
          <Truck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-heading">Dispatch</h1>
            <p className="text-sm text-muted mt-0.5">Manage and track jobs and service calls</p>
          </div>
        </div>
        {!isReadOnly && (
          <button onClick={() => openForm()} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
            <Plus className="h-4 w-4" /> New Job
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-4 gap-3">
        {COLUMNS.map(col => (
          <div key={col.key} className="bg-surface border border-border rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-heading">{getJobsByStatus(col.key).length}</div>
            <div className="text-xs font-medium text-muted mt-1">{col.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 min-h-[400px]">
        {COLUMNS.map(col => (
          <div key={col.key} className={`bg-surface border border-border rounded-xl overflow-hidden border-t-4 ${col.color}`}>
            <div className="p-3 border-b border-border">
              <h3 className="text-sm font-semibold text-heading flex items-center justify-between">
                {col.label}
                <span className="text-xs font-normal text-muted bg-surface-secondary rounded-full px-2 py-0.5">
                  {getJobsByStatus(col.key).length}
                </span>
              </h3>
            </div>
            <div className="p-2 space-y-2 overflow-y-auto max-h-[500px]">
              {getJobsByStatus(col.key).length === 0 ? (
                <div className="p-4 text-center text-xs text-muted">No jobs</div>
              ) : (
                getJobsByStatus(col.key).map(job => (
                  <div
                    key={job.id}
                    onClick={() => !isReadOnly && openForm(job)}
                    className="bg-surface-secondary rounded-lg p-3 cursor-pointer hover:ring-1 hover:ring-primary/30 transition-all"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h4 className="text-sm font-medium text-heading leading-tight">{job.title}</h4>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold ${PRIORITY_BADGES[job.priority]}`}>
                        {job.priority.toUpperCase()}
                      </span>
                    </div>
                    {job.description && (
                      <p className="text-xs text-muted mt-1 line-clamp-2">{job.description}</p>
                    )}
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex items-center gap-1 text-xs text-muted">
                        <User className="h-3 w-3" />
                        <span className="truncate max-w-[100px]">{job.contact_name || job.assignee_email || 'Unassigned'}</span>
                      </div>
                      {job.scheduled_at && (
                        <div className="flex items-center gap-1 text-xs text-muted">
                          <Clock className="h-3 w-3" />
                          <span>{new Date(job.scheduled_at).toLocaleDateString()}</span>
                        </div>
                      )}
                    </div>
                    {!isReadOnly && (
                      <div className="flex gap-1 mt-2" onClick={e => e.stopPropagation()}>
                        {col.key === 'pending' && (
                          <button onClick={() => moveJob(job.id, 'assigned')} className="text-[10px] px-2 py-1 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 hover:opacity-80">Assign</button>
                        )}
                        {col.key === 'assigned' && (
                          <button onClick={() => moveJob(job.id, 'in_progress')} className="text-[10px] px-2 py-1 rounded bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 hover:opacity-80">Start</button>
                        )}
                        {col.key === 'in_progress' && (
                          <button onClick={() => moveJob(job.id, 'done')} className="text-[10px] px-2 py-1 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 hover:opacity-80">Complete</button>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface border border-border rounded-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="font-semibold text-heading">{editingJob ? 'Edit Job' : 'New Job'}</h3>
              <button onClick={() => setShowForm(false)} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Title *</label>
                <input type="text" value={formData.title} onChange={e => setFormData(p => ({ ...p, title: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Description</label>
                <textarea value={formData.description} onChange={e => setFormData(p => ({ ...p, description: e.target.value }))} rows={3} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Status</label>
                  <select value={formData.status} onChange={e => setFormData(p => ({ ...p, status: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="pending">Pending</option>
                    <option value="assigned">Assigned</option>
                    <option value="in_progress">In Progress</option>
                    <option value="done">Done</option>
                    <option value="cancelled">Cancelled</option>
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Assignee</label>
                  <select value={formData.assignee_user_id} onChange={e => setFormData(p => ({ ...p, assignee_user_id: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="">Unassigned</option>
                    {teamMembers.map(m => <option key={m.id} value={m.id}>{m.email}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Contact</label>
                  <input type="text" placeholder="Contact name or reference" value={formData.contact_name} onChange={e => setFormData(p => ({ ...p, contact_name: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Scheduled At</label>
                <input type="datetime-local" value={formData.scheduled_at} onChange={e => setFormData(p => ({ ...p, scheduled_at: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Notes</label>
                <textarea value={formData.notes} onChange={e => setFormData(p => ({ ...p, notes: e.target.value }))} rows={3} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-heading bg-surface-secondary">Cancel</button>
              <button onClick={saveJob} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
