import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import {
  Users, Bot, ArrowRight, Plus, Trash2, Activity,
  GitBranch, ChevronDown, ChevronRight, BarChart3,
  Clock, CheckCircle2, XCircle, Network, Layers, Phone,
  Lightbulb, DollarSign, Megaphone, Zap, TrendingUp,
  AlertTriangle, ThumbsUp, X, Send, PlayCircle, Rocket,
  Bell, RefreshCw, Shield,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface Team {
  id: string;
  name: string;
  description: string | null;
  status: string;
  member_count: number;
  created_at: string;
}

interface Member {
  id: string;
  team_id: string;
  agent_id: string;
  role: string;
  is_receptionist: boolean;
  priority: number;
  status: string;
  agent_name?: string;
  agent_type?: string;
}

interface RoutingRule {
  id: string;
  team_id: string;
  intent: string;
  target_member_id: string;
  fallback_member_id: string | null;
  priority: number;
  target_agent_name?: string;
  target_role?: string;
  fallback_agent_name?: string;
}

interface Template {
  id: string;
  name: string;
  description: string | null;
  vertical: string | null;
  is_system: boolean;
  template_config: {
    roles: { role: string; agentType: string; isReceptionist: boolean; description: string }[];
    routingRules: { intent: string; targetRole: string; fallbackRole?: string }[];
    outboundAutomations?: { type: string; description: string }[];
  };
}

interface HistoryEntry {
  id: string;
  call_session_id: string;
  from_agent_name: string;
  to_agent_name: string;
  intent: string | null;
  reason: string | null;
  outcome: string | null;
  created_at: string;
}

interface Metrics {
  teamId: string;
  totalHandoffs: number;
  successfulHandoffs: number;
  avgHandoffDurationMs: number;
  handoffsByIntent: Record<string, number>;
  handoffsByAgent: { agentId: string; agentName: string; count: number }[];
  activeCallsByAgent: { agentId: string; agentName: string; activeCalls: number }[];
}

interface AgentOption {
  id: string;
  name: string;
  type: string;
}

interface OptimizationInsight {
  id: string;
  category: string;
  title: string;
  description: string;
  impactEstimate: string | null;
  difficulty: string;
  estimatedRevenueImpactCents: number | null;
  status: string;
  actionType: string | null;
  createdAt: string;
}

interface RevenueMetrics {
  callsHandled: number;
  bookingsGenerated: number;
  missedCallsRecovered: number;
  estimatedRevenueCents: number;
  missedRevenueCents: number;
  agentBreakdown: Array<{
    agentId: string;
    agentName: string;
    callsHandled: number;
    bookingsGenerated: number;
    revenueCents: number;
  }>;
  dailyBreakdown: Array<{
    date: string;
    callsHandled: number;
    bookingsGenerated: number;
    revenueCents: number;
  }>;
}

interface OutboundTask {
  id: string;
  campaignType: string;
  name: string;
  status: string;
  totalContacts: number;
  contactsReached: number;
  createdAt: string;
}

function StatCard({ icon: Icon, label, value, color, subtext }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  color: string;
  subtext?: string;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${color}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xs text-text-secondary">{label}</p>
          <p className="text-lg font-bold text-text-primary">{value}</p>
          {subtext && <p className="text-xs text-text-secondary">{subtext}</p>}
        </div>
      </div>
    </div>
  );
}

function CreateTeamDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.post('/workforce/teams', { name, description }),
    onSuccess: () => { onCreated(); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-text-primary mb-4">Create Workforce Team</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Team Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-surface-secondary border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="e.g., Medical Office Team"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-surface-secondary border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              rows={3}
              placeholder="Describe your team's purpose..."
            />
          </div>
          <div className="flex gap-3 justify-end">
            <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!name || mutation.isPending}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {mutation.isPending ? 'Creating...' : 'Create Team'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddMemberDialog({ teamId, existingAgentIds, onClose, onAdded }: {
  teamId: string;
  existingAgentIds: string[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [agentId, setAgentId] = useState('');
  const [role, setRole] = useState('specialist');
  const [isReceptionist, setIsReceptionist] = useState(false);

  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'list'],
    queryFn: () => api.get<{ agents: AgentOption[] }>('/agents'),
  });

  const availableAgents = (agentsData?.agents ?? []).filter((a) => !existingAgentIds.includes(a.id));

  const mutation = useMutation({
    mutationFn: () => api.post(`/workforce/teams/${teamId}/members`, { agent_id: agentId, role, is_receptionist: isReceptionist }),
    onSuccess: () => { onAdded(); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-text-primary mb-4">Add Team Member</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Agent</label>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full px-3 py-2 bg-surface-secondary border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">Select an agent...</option>
              {availableAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full px-3 py-2 bg-surface-secondary border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="receptionist">Receptionist</option>
              <option value="scheduler">Scheduler</option>
              <option value="dispatcher">Dispatcher</option>
              <option value="billing">Billing</option>
              <option value="support">Support</option>
              <option value="triage">Triage</option>
              <option value="intake">Intake</option>
              <option value="specialist">Specialist</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
            <input
              type="checkbox"
              checked={isReceptionist}
              onChange={(e) => setIsReceptionist(e.target.checked)}
              className="rounded border-border"
            />
            Primary receptionist (first point of contact)
          </label>
          <div className="flex gap-3 justify-end">
            <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!agentId || mutation.isPending}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {mutation.isPending ? 'Adding...' : 'Add Member'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddRoutingRuleDialog({ teamId, members, onClose, onAdded }: {
  teamId: string;
  members: Member[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [intent, setIntent] = useState('');
  const [targetMemberId, setTargetMemberId] = useState('');
  const [fallbackMemberId, setFallbackMemberId] = useState('');

  const intents = [
    'schedule_appointment', 'billing_inquiry', 'urgent_medical', 'general_inquiry',
    'service_request', 'maintenance_request', 'schedule_consultation', 'complaint',
    'cancel', 'transfer_human', 'file_claim', 'make_reservation',
    'emergency_dispatch', 'new_patient',
  ];

  const mutation = useMutation({
    mutationFn: () => api.post(`/workforce/teams/${teamId}/routing-rules`, {
      intent, target_member_id: targetMemberId, fallback_member_id: fallbackMemberId || null,
    }),
    onSuccess: () => { onAdded(); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-text-primary mb-4">Add Routing Rule</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Intent</label>
            <select
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              className="w-full px-3 py-2 bg-surface-secondary border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">Select an intent...</option>
              {intents.map((i) => (
                <option key={i} value={i}>{i.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Route To</label>
            <select
              value={targetMemberId}
              onChange={(e) => setTargetMemberId(e.target.value)}
              className="w-full px-3 py-2 bg-surface-secondary border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">Select target agent...</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.agent_name ?? m.agent_id} ({m.role})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Fallback (optional)</label>
            <select
              value={fallbackMemberId}
              onChange={(e) => setFallbackMemberId(e.target.value)}
              className="w-full px-3 py-2 bg-surface-secondary border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">No fallback</option>
              {members.filter((m) => m.id !== targetMemberId).map((m) => (
                <option key={m.id} value={m.id}>{m.agent_name ?? m.agent_id} ({m.role})</option>
              ))}
            </select>
          </div>
          <div className="flex gap-3 justify-end">
            <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!intent || !targetMemberId || mutation.isPending}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {mutation.isPending ? 'Adding...' : 'Add Rule'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateOutboundTaskDialog({ teamId, onClose, onCreated }: {
  teamId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [campaignType, setCampaignType] = useState('appointment_reminder');

  const campaignTypes = [
    { value: 'appointment_reminder', label: 'Appointment Reminder' },
    { value: 'follow_up', label: 'Follow-up Call' },
    { value: 'maintenance_reminder', label: 'Maintenance Reminder' },
    { value: 'review_request', label: 'Review Request' },
    { value: 'reactivation', label: 'Customer Reactivation' },
    { value: 'recall', label: 'Recall Campaign' },
    { value: 'lease_renewal', label: 'Lease Renewal' },
    { value: 'custom', label: 'Custom Campaign' },
  ];

  const mutation = useMutation({
    mutationFn: () => api.post(`/workforce/teams/${teamId}/outbound-tasks`, { campaignType, name }),
    onSuccess: () => { onCreated(); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-text-primary mb-4">Create Outbound Campaign</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Campaign Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-surface-secondary border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="e.g., March Follow-up Calls"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Campaign Type</label>
            <select
              value={campaignType}
              onChange={(e) => setCampaignType(e.target.value)}
              className="w-full px-3 py-2 bg-surface-secondary border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {campaignTypes.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-3 justify-end">
            <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!name || mutation.isPending}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {mutation.isPending ? 'Creating...' : 'Create Campaign'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InsightCard({ insight, onAcknowledge, onDismiss }: {
  insight: OptimizationInsight;
  onAcknowledge: () => void;
  onDismiss: () => void;
}) {
  const categoryColors: Record<string, string> = {
    missed_opportunity: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    performance: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    agent_improvement: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    workflow: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    scheduling: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    cost_optimization: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  };

  const difficultyColors: Record<string, string> = {
    easy: 'text-green-600 dark:text-green-400',
    medium: 'text-amber-600 dark:text-amber-400',
    hard: 'text-red-600 dark:text-red-400',
  };

  return (
    <div className="border border-border rounded-lg p-4 bg-surface hover:bg-surface-hover transition-colors">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-900/30 mt-0.5">
          <Lightbulb className="h-4 w-4 text-amber-700 dark:text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h4 className="text-sm font-semibold text-text-primary">{insight.title}</h4>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${categoryColors[insight.category] ?? 'bg-gray-100 text-gray-600'}`}>
              {insight.category.replace(/_/g, ' ')}
            </span>
          </div>
          <p className="text-xs text-text-secondary mb-2">{insight.description}</p>
          <div className="flex items-center gap-4 text-xs">
            {insight.impactEstimate && (
              <span className="flex items-center gap-1 text-text-secondary">
                <TrendingUp className="h-3 w-3" /> {insight.impactEstimate}
              </span>
            )}
            {insight.estimatedRevenueImpactCents && (
              <span className="flex items-center gap-1 text-green-600 dark:text-green-400 font-medium">
                <DollarSign className="h-3 w-3" /> ${(insight.estimatedRevenueImpactCents / 100).toLocaleString()}
              </span>
            )}
            <span className={`${difficultyColors[insight.difficulty] ?? 'text-text-secondary'}`}>
              {insight.difficulty} effort
            </span>
          </div>
        </div>
        {insight.status === 'new' && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={onAcknowledge}
              className="p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors"
              title="Acknowledge"
            >
              <ThumbsUp className="h-4 w-4" />
            </button>
            <button
              onClick={onDismiss}
              className="p-1.5 text-text-secondary hover:bg-surface-secondary rounded-lg transition-colors"
              title="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {insight.status !== 'new' && (
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${
            insight.status === 'acknowledged'
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
          }`}>
            {insight.status}
          </span>
        )}
      </div>
    </div>
  );
}

function TeamDashboard({ teamId }: { teamId: string }) {
  const queryClient = useQueryClient();

  const { data: metricsData } = useQuery({
    queryKey: ['workforce', 'metrics', teamId],
    queryFn: () => api.get<{ metrics: Metrics }>(`/workforce/teams/${teamId}/metrics`),
  });

  const { data: insightsData } = useQuery({
    queryKey: ['workforce', 'insights', teamId],
    queryFn: () => api.get<{ insights: OptimizationInsight[]; total: number }>(`/workforce/teams/${teamId}/optimization-insights`),
  });

  const { data: revenueData } = useQuery({
    queryKey: ['workforce', 'revenue', teamId],
    queryFn: () => api.get<{ metrics: RevenueMetrics | null }>(`/workforce/teams/${teamId}/revenue-metrics`),
  });

  const { data: outboundData } = useQuery({
    queryKey: ['workforce', 'outbound', teamId],
    queryFn: () => api.get<{ tasks: OutboundTask[]; total: number }>(`/workforce/teams/${teamId}/outbound-tasks`),
  });

  const runAnalysis = useMutation({
    mutationFn: () => api.post(`/workforce/teams/${teamId}/optimization-insights/analyze`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workforce', 'insights', teamId] }),
  });

  const calculateRevenue = useMutation({
    mutationFn: () => api.post(`/workforce/teams/${teamId}/revenue-metrics/calculate`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workforce', 'revenue', teamId] }),
  });

  const acknowledgeInsight = useMutation({
    mutationFn: (id: string) => api.patch(`/workforce/optimization-insights/${id}/acknowledge`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workforce', 'insights', teamId] }),
  });

  const dismissInsight = useMutation({
    mutationFn: (id: string) => api.patch(`/workforce/optimization-insights/${id}/dismiss`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workforce', 'insights', teamId] }),
  });

  const metrics = metricsData?.metrics;
  const insights = insightsData?.insights ?? [];
  const revenue = revenueData?.metrics;
  const outboundTasks = outboundData?.tasks ?? [];
  const newInsights = insights.filter((i) => i.status === 'new');

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Phone}
          label="Calls Handled"
          value={revenue?.callsHandled ?? 0}
          color="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
        />
        <StatCard
          icon={CheckCircle2}
          label="Bookings Generated"
          value={revenue?.bookingsGenerated ?? 0}
          color="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
        />
        <StatCard
          icon={DollarSign}
          label="AI-Influenced Revenue"
          value={revenue ? `$${(revenue.estimatedRevenueCents / 100).toLocaleString()}` : '$0'}
          color="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
        />
        <StatCard
          icon={AlertTriangle}
          label="Missed Revenue"
          value={revenue ? `$${(revenue.missedRevenueCents / 100).toLocaleString()}` : '$0'}
          color="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
          subtext={revenue?.missedCallsRecovered ? `${revenue.missedCallsRecovered} calls recovered` : undefined}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          icon={Activity}
          label="Total Handoffs"
          value={metrics?.totalHandoffs ?? 0}
          color="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
        />
        <StatCard
          icon={CheckCircle2}
          label="Successful Handoffs"
          value={metrics?.successfulHandoffs ?? 0}
          color="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
        />
        <StatCard
          icon={Lightbulb}
          label="Active Recommendations"
          value={newInsights.length}
          color="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
        />
      </div>

      {metrics?.activeCallsByAgent && metrics.activeCallsByAgent.some((a) => a.activeCalls > 0) && (
        <div className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-base font-semibold text-text-primary">Live Agent Status</h3>
          </div>
          <div className="divide-y divide-border">
            {metrics.activeCallsByAgent.map((item) => (
              <div key={item.agentId} className="px-5 py-3 flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${item.activeCalls > 0 ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`} />
                <Bot className="h-4 w-4 text-text-secondary" />
                <span className="text-sm text-text-primary flex-1">{item.agentName}</span>
                <span className={`text-sm font-medium ${item.activeCalls > 0 ? 'text-green-600 dark:text-green-400' : 'text-text-secondary'}`}>
                  {item.activeCalls > 0 ? `${item.activeCalls} active call${item.activeCalls > 1 ? 's' : ''}` : 'Idle'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-text-primary">Optimization Recommendations</h3>
            <p className="text-xs text-text-secondary mt-0.5">AI-powered insights to improve your workforce performance</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => calculateRevenue.mutate()}
              disabled={calculateRevenue.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-surface-secondary hover:bg-surface-hover border border-border rounded-lg text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              <DollarSign className="h-3 w-3" />
              {calculateRevenue.isPending ? 'Calculating...' : 'Refresh Revenue'}
            </button>
            <button
              onClick={() => runAnalysis.mutate()}
              disabled={runAnalysis.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:opacity-50"
            >
              <Zap className="h-3 w-3" />
              {runAnalysis.isPending ? 'Analyzing...' : 'Run Analysis'}
            </button>
          </div>
        </div>
        <div className="p-4 space-y-3">
          {insights.length === 0 ? (
            <div className="p-8 text-center">
              <Lightbulb className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No optimization insights yet</p>
              <p className="text-sm text-text-secondary mt-1">Run an analysis to generate AI-powered recommendations</p>
            </div>
          ) : (
            insights.slice(0, 8).map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                onAcknowledge={() => acknowledgeInsight.mutate(insight.id)}
                onDismiss={() => dismissInsight.mutate(insight.id)}
              />
            ))
          )}
        </div>
      </div>

      {revenue && revenue.agentBreakdown.length > 0 && (
        <div className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-base font-semibold text-text-primary">Revenue by Agent</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-5 py-3 text-text-secondary font-medium">Agent</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Calls</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Bookings</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Revenue</th>
                  <th className="px-5 py-3 text-text-secondary font-medium">Conversion</th>
                </tr>
              </thead>
              <tbody>
                {revenue.agentBreakdown.map((agent) => (
                  <tr key={agent.agentId} className="border-b border-border last:border-0">
                    <td className="px-5 py-3 text-text-primary font-medium">{agent.agentName}</td>
                    <td className="px-5 py-3 text-text-secondary">{agent.callsHandled}</td>
                    <td className="px-5 py-3 text-text-secondary">{agent.bookingsGenerated}</td>
                    <td className="px-5 py-3 text-green-600 dark:text-green-400 font-medium">
                      ${(agent.revenueCents / 100).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 text-text-secondary">
                      {agent.callsHandled > 0 ? `${((agent.bookingsGenerated / agent.callsHandled) * 100).toFixed(1)}%` : '--'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {outboundTasks.length > 0 && (
        <div className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-base font-semibold text-text-primary">Outbound Campaigns</h3>
          </div>
          <div className="divide-y divide-border">
            {outboundTasks.map((task) => (
              <div key={task.id} className="px-5 py-3 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                  <Send className="h-4 w-4 text-indigo-700 dark:text-indigo-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{task.name}</p>
                  <p className="text-xs text-text-secondary">
                    {task.campaignType.replace(/_/g, ' ')} | {task.contactsReached}/{task.totalContacts} contacted
                  </p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  task.status === 'running'
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                    : task.status === 'completed'
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                    : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                }`}>
                  {task.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <OperationalAlerts insights={insights} metrics={metrics ?? null} revenue={revenue ?? null} />
    </div>
  );
}

function TeamDetail({ teamId, onBack }: { teamId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const [showAddMember, setShowAddMember] = useState(false);
  const [showAddRule, setShowAddRule] = useState(false);
  const [showCreateOutbound, setShowCreateOutbound] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'members' | 'routing' | 'outbound' | 'history'>('dashboard');

  const { data: teamData, isLoading } = useQuery({
    queryKey: ['workforce', 'team', teamId],
    queryFn: () => api.get<{ team: Team; members: Member[]; routingRules: RoutingRule[] }>(`/workforce/teams/${teamId}`),
  });

  const { data: historyData } = useQuery({
    queryKey: ['workforce', 'history', teamId],
    queryFn: () => api.get<{ history: HistoryEntry[]; total: number }>(`/workforce/teams/${teamId}/history`),
    enabled: activeTab === 'history',
  });

  const deleteMember = useMutation({
    mutationFn: (memberId: string) => api.delete(`/workforce/members/${memberId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workforce', 'team', teamId] }),
  });

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) => api.delete(`/workforce/routing-rules/${ruleId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workforce', 'team', teamId] }),
  });

  const team = teamData?.team;
  const members = teamData?.members ?? [];
  const rules = teamData?.routingRules ?? [];
  const history = historyData?.history ?? [];

  if (isLoading) {
    return <div className="space-y-4">{[1,2,3].map(i => <div key={i} className="h-20 bg-surface-secondary rounded-xl animate-pulse" />)}</div>;
  }

  const tabs = [
    { key: 'dashboard' as const, label: 'Dashboard', icon: BarChart3 },
    { key: 'members' as const, label: 'Members', icon: Users, count: members.length },
    { key: 'routing' as const, label: 'Routing', icon: GitBranch, count: rules.length },
    { key: 'outbound' as const, label: 'Outbound', icon: Megaphone },
    { key: 'history' as const, label: 'History', icon: Clock },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-text-secondary hover:text-text-primary transition-colors flex items-center gap-1">
          <ChevronRight className="h-4 w-4 rotate-180" /> Back
        </button>
        <div className="flex-1">
          <h2 className="text-xl font-bold text-text-primary">{team?.name}</h2>
          {team?.description && <p className="text-sm text-text-secondary mt-0.5">{team.description}</p>}
        </div>
        <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
          team?.status === 'active'
            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
        }`}>
          {team?.status}
        </span>
      </div>

      <div className="flex gap-1 bg-surface-secondary rounded-lg p-1 overflow-x-auto">
        {tabs.map((tab) => {
          const TabIcon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? 'bg-surface text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              <TabIcon className="h-4 w-4" />
              {tab.label}
              {'count' in tab && tab.count !== undefined && (
                <span className="bg-surface-secondary text-text-secondary text-xs px-1.5 py-0.5 rounded-full">{tab.count}</span>
              )}
            </button>
          );
        })}
      </div>

      {activeTab === 'dashboard' && <TeamDashboard teamId={teamId} />}

      {activeTab === 'members' && (
        <div className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h3 className="text-base font-semibold text-text-primary">Team Members</h3>
            <button
              onClick={() => setShowAddMember(true)}
              className="flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
            >
              <Plus className="h-3.5 w-3.5" /> Add Agent
            </button>
          </div>
          {members.length === 0 ? (
            <div className="p-8 text-center">
              <Bot className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No team members yet</p>
              <p className="text-sm text-text-secondary mt-1">Add AI agents to form your workforce team</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {members.map((member) => (
                <div key={member.id} className="px-5 py-4 flex items-center gap-4">
                  <div className={`p-2 rounded-lg ${member.is_receptionist ? 'bg-blue-100 dark:bg-blue-900/30' : 'bg-surface-secondary'}`}>
                    <Bot className={`h-5 w-5 ${member.is_receptionist ? 'text-blue-700 dark:text-blue-400' : 'text-text-secondary'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-text-primary">{member.agent_name ?? member.agent_id}</p>
                      {member.is_receptionist && (
                        <span className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 text-xs px-2 py-0.5 rounded-full font-medium">
                          Receptionist
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-secondary">
                      Role: {member.role} | Type: {member.agent_type ?? 'unknown'}
                    </p>
                  </div>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    member.status === 'active'
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                  }`}>
                    {member.status}
                  </span>
                  <button
                    onClick={() => deleteMember.mutate(member.id)}
                    className="p-1.5 text-text-secondary hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'routing' && (
        <>
        <RoutingFlowVisualization rules={rules} members={members} />
        <div className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h3 className="text-base font-semibold text-text-primary">Routing Rules</h3>
            <button
              onClick={() => setShowAddRule(true)}
              disabled={members.length === 0}
              className="flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" /> Add Rule
            </button>
          </div>
          {rules.length === 0 ? (
            <div className="p-8 text-center">
              <GitBranch className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No routing rules configured</p>
              <p className="text-sm text-text-secondary mt-1">Define how calls should be routed between team members</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {rules.map((rule) => (
                <div key={rule.id} className="px-5 py-4 flex items-center gap-4">
                  <div className="p-2 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                    <ArrowRight className="h-4 w-4 text-purple-700 dark:text-purple-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">
                      {rule.intent.replace(/_/g, ' ')}
                    </p>
                    <p className="text-xs text-text-secondary">
                      Route to: {rule.target_agent_name ?? 'Unknown'} ({rule.target_role ?? 'specialist'})
                      {rule.fallback_agent_name && ` | Fallback: ${rule.fallback_agent_name}`}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteRule.mutate(rule.id)}
                    className="p-1.5 text-text-secondary hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        </>
      )}

      {activeTab === 'outbound' && (
        <OutboundTab teamId={teamId} showCreateOutbound={showCreateOutbound} setShowCreateOutbound={setShowCreateOutbound} />
      )}

      {activeTab === 'history' && (
        <div className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border">
            <h3 className="text-base font-semibold text-text-primary">Routing History</h3>
          </div>
          {history.length === 0 ? (
            <div className="p-8 text-center">
              <Clock className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No routing history yet</p>
              <p className="text-sm text-text-secondary mt-1">Handoff events will appear here as calls are routed</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-5 py-3 text-text-secondary font-medium">From</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">To</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">Intent</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">Outcome</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id} className="border-b border-border last:border-0">
                      <td className="px-5 py-3 text-text-primary">{entry.from_agent_name}</td>
                      <td className="px-5 py-3 text-text-primary">{entry.to_agent_name}</td>
                      <td className="px-5 py-3 text-text-secondary">{entry.intent?.replace(/_/g, ' ') ?? '--'}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${
                          entry.outcome === 'success'
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}>
                          {entry.outcome === 'success' ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                          {entry.outcome ?? 'unknown'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-text-secondary">
                        {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showAddMember && (
        <AddMemberDialog
          teamId={teamId}
          existingAgentIds={members.map((m) => m.agent_id)}
          onClose={() => setShowAddMember(false)}
          onAdded={() => queryClient.invalidateQueries({ queryKey: ['workforce', 'team', teamId] })}
        />
      )}

      {showAddRule && (
        <AddRoutingRuleDialog
          teamId={teamId}
          members={members}
          onClose={() => setShowAddRule(false)}
          onAdded={() => queryClient.invalidateQueries({ queryKey: ['workforce', 'team', teamId] })}
        />
      )}
    </div>
  );
}

function OperationalAlerts({ insights, metrics, revenue }: {
  insights: OptimizationInsight[];
  metrics: Metrics | null;
  revenue: RevenueMetrics | null;
}) {
  const alerts: Array<{ level: 'critical' | 'warning' | 'info'; message: string; detail: string }> = [];

  const criticalInsights = insights.filter((i) => i.severity === 'critical' && i.status === 'new');
  criticalInsights.forEach((i) => {
    alerts.push({ level: 'critical', message: i.title, detail: i.description });
  });

  if (metrics && metrics.totalHandoffs > 0) {
    const successRate = metrics.successfulHandoffs / metrics.totalHandoffs;
    if (successRate < 0.7) {
      alerts.push({
        level: 'critical',
        message: 'Low handoff success rate',
        detail: `Only ${(successRate * 100).toFixed(0)}% of handoffs are completing successfully. Review routing rules and agent availability.`,
      });
    } else if (successRate < 0.85) {
      alerts.push({
        level: 'warning',
        message: 'Handoff success rate below target',
        detail: `${(successRate * 100).toFixed(0)}% success rate — target is 85%. Consider adjusting routing priorities.`,
      });
    }
  }

  if (revenue && revenue.missedRevenueCents > revenue.estimatedRevenueCents * 0.3) {
    alerts.push({
      level: 'warning',
      message: 'High missed revenue ratio',
      detail: `Missed revenue ($${(revenue.missedRevenueCents / 100).toLocaleString()}) is over 30% of generated revenue. Review agent handling and scheduling.`,
    });
  }

  if (alerts.length === 0) {
    return null;
  }

  const levelConfig = {
    critical: { bg: 'bg-red-50 dark:bg-red-900/20', border: 'border-red-200 dark:border-red-800', icon: 'text-red-600 dark:text-red-400', label: 'Critical' },
    warning: { bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-200 dark:border-amber-800', icon: 'text-amber-600 dark:text-amber-400', label: 'Warning' },
    info: { bg: 'bg-blue-50 dark:bg-blue-900/20', border: 'border-blue-200 dark:border-blue-800', icon: 'text-blue-600 dark:text-blue-400', label: 'Info' },
  };

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Bell className="h-4 w-4 text-text-secondary" />
        <h3 className="text-base font-semibold text-text-primary">Operational Alerts</h3>
        <span className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-xs px-2 py-0.5 rounded-full font-medium">{alerts.length}</span>
      </div>
      <div className="divide-y divide-border">
        {alerts.map((alert, idx) => {
          const config = levelConfig[alert.level];
          return (
            <div key={idx} className={`px-5 py-3 ${config.bg} border-l-4 ${config.border}`}>
              <div className="flex items-center gap-2 mb-1">
                <Shield className={`h-3.5 w-3.5 ${config.icon}`} />
                <span className={`text-xs font-semibold uppercase ${config.icon}`}>{config.label}</span>
                <span className="text-sm font-medium text-text-primary">{alert.message}</span>
              </div>
              <p className="text-xs text-text-secondary ml-5">{alert.detail}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoutingFlowVisualization({ rules, members }: { rules: RoutingRule[]; members: Member[] }) {
  if (rules.length === 0 || members.length === 0) {
    return null;
  }

  const receptionist = members.find((m) => m.is_receptionist);

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm mb-4">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Network className="h-4 w-4 text-text-secondary" />
        <h3 className="text-base font-semibold text-text-primary">Task Distribution Flow</h3>
      </div>
      <div className="p-5">
        <div className="flex flex-col items-center gap-3">
          <div className="bg-blue-100 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-2.5 text-center">
            <p className="text-xs text-blue-600 dark:text-blue-400 font-medium">Incoming Call</p>
            <p className="text-sm font-semibold text-text-primary">Customer</p>
          </div>

          <div className="w-px h-6 bg-border" />

          {receptionist && (
            <>
              <div className="bg-green-100 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg px-4 py-2.5 text-center">
                <p className="text-xs text-green-600 dark:text-green-400 font-medium">Receptionist</p>
                <p className="text-sm font-semibold text-text-primary">{receptionist.agent_name ?? 'Primary Agent'}</p>
                <p className="text-xs text-text-secondary">Intent Detection</p>
              </div>
              <div className="w-px h-4 bg-border" />
            </>
          )}

          <div className="flex flex-wrap justify-center gap-3 max-w-2xl">
            {rules.map((rule) => (
              <div key={rule.id} className="flex flex-col items-center gap-1">
                <div className="w-px h-4 bg-border" />
                <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg px-3 py-2 text-center min-w-[140px]">
                  <p className="text-xs text-purple-600 dark:text-purple-400 font-medium">{rule.intent.replace(/_/g, ' ')}</p>
                  <div className="flex items-center gap-1 justify-center mt-1">
                    <ArrowRight className="h-3 w-3 text-text-secondary" />
                    <p className="text-xs font-medium text-text-primary">{rule.target_agent_name ?? 'Specialist'}</p>
                  </div>
                  {rule.fallback_agent_name && (
                    <p className="text-[10px] text-text-secondary mt-0.5">Fallback: {rule.fallback_agent_name}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function OutboundTab({ teamId, showCreateOutbound, setShowCreateOutbound }: {
  teamId: string;
  showCreateOutbound: boolean;
  setShowCreateOutbound: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const { data: outboundData } = useQuery({
    queryKey: ['workforce', 'outbound', teamId],
    queryFn: () => api.get<{ tasks: OutboundTask[]; total: number }>(`/workforce/teams/${teamId}/outbound-tasks`),
  });

  const deleteTask = useMutation({
    mutationFn: (taskId: string) => api.delete(`/workforce/outbound-tasks/${taskId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workforce', 'outbound', teamId] }),
  });

  const launchTask = useMutation({
    mutationFn: (taskId: string) => api.post(`/workforce/outbound-tasks/${taskId}/launch`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workforce', 'outbound', teamId] }),
  });

  const syncTask = useMutation({
    mutationFn: (taskId: string) => api.post(`/workforce/outbound-tasks/${taskId}/sync`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workforce', 'outbound', teamId] }),
  });

  const tasks = outboundData?.tasks ?? [];

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-text-primary">Outbound Automation</h3>
          <p className="text-xs text-text-secondary mt-0.5">Launch automated outbound campaigns from your workforce team</p>
        </div>
        <button
          onClick={() => setShowCreateOutbound(true)}
          className="flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
        >
          <Plus className="h-3.5 w-3.5" /> New Campaign
        </button>
      </div>
      {tasks.length === 0 ? (
        <div className="p-8 text-center">
          <Megaphone className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
          <p className="text-text-secondary font-medium">No outbound campaigns yet</p>
          <p className="text-sm text-text-secondary mt-1">Create campaigns for appointment reminders, follow-ups, and more</p>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {tasks.map((task) => (
            <div key={task.id} className="px-5 py-4 flex items-center gap-4">
              <div className="p-2 rounded-lg bg-indigo-100 dark:bg-indigo-900/30">
                <Send className="h-4 w-4 text-indigo-700 dark:text-indigo-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">{task.name}</p>
                <p className="text-xs text-text-secondary">
                  Type: {task.campaignType.replace(/_/g, ' ')} |
                  {task.totalContacts > 0
                    ? ` ${task.contactsReached}/${task.totalContacts} contacted`
                    : ' No contacts added yet'}
                  {task.campaignId && ` | Campaign: ${task.campaignId.slice(0, 8)}...`}
                </p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                task.status === 'running'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                  : task.status === 'completed'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                  : task.status === 'draft'
                  ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
              }`}>
                {task.status}
              </span>
              <div className="flex items-center gap-1">
                {task.status === 'draft' && (
                  <button
                    onClick={() => launchTask.mutate(task.id)}
                    disabled={launchTask.isPending}
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50"
                    title="Launch campaign via CampaignScheduler"
                  >
                    <Rocket className="h-3 w-3" />
                    {launchTask.isPending ? 'Launching...' : 'Launch'}
                  </button>
                )}
                {(task.status === 'running' || task.status === 'paused') && (
                  <button
                    onClick={() => syncTask.mutate(task.id)}
                    disabled={syncTask.isPending}
                    className="flex items-center gap-1 text-xs px-2 py-1.5 bg-surface-secondary hover:bg-surface-hover border border-border rounded-lg text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                    title="Sync status from campaign"
                  >
                    <RefreshCw className={`h-3 w-3 ${syncTask.isPending ? 'animate-spin' : ''}`} />
                    Sync
                  </button>
                )}
                {(task.status === 'draft' || task.status === 'cancelled') && (
                  <button
                    onClick={() => deleteTask.mutate(task.id)}
                    className="p-1.5 text-text-secondary hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateOutbound && (
        <CreateOutboundTaskDialog
          teamId={teamId}
          onClose={() => setShowCreateOutbound(false)}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ['workforce', 'outbound', teamId] })}
        />
      )}
    </div>
  );
}

function TemplateCard({ template, onDeploy }: { template: Template; onDeploy: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  const verticalIcons: Record<string, string> = {
    hvac: 'bg-orange-100 dark:bg-orange-900/30',
    dental: 'bg-cyan-100 dark:bg-cyan-900/30',
    medical: 'bg-red-100 dark:bg-red-900/30',
    'property-management': 'bg-violet-100 dark:bg-violet-900/30',
    'home-services': 'bg-amber-100 dark:bg-amber-900/30',
    legal: 'bg-indigo-100 dark:bg-indigo-900/30',
  };

  return (
    <div className="border border-border rounded-lg p-4 hover:bg-surface-hover transition-colors">
      <div className="flex items-center gap-3 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className={`p-2 rounded-lg ${verticalIcons[template.vertical ?? ''] ?? 'bg-purple-100 dark:bg-purple-900/30'}`}>
          <Layers className="h-4 w-4 text-purple-700 dark:text-purple-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-text-primary">{template.name}</p>
            {template.is_system && (
              <span className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-xs px-2 py-0.5 rounded-full font-medium">System</span>
            )}
            {template.vertical && (
              <span className="bg-surface-secondary text-text-secondary text-xs px-2 py-0.5 rounded-full">{template.vertical}</span>
            )}
          </div>
          <p className="text-xs text-text-secondary">{template.description}</p>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDeploy(template.id); }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-xs font-medium rounded-lg transition-colors"
        >
          <Rocket className="h-3 w-3" /> Deploy
        </button>
        {expanded ? <ChevronDown className="h-4 w-4 text-text-secondary" /> : <ChevronRight className="h-4 w-4 text-text-secondary" />}
      </div>
      {expanded && (
        <div className="mt-4 pl-11 space-y-3">
          <div>
            <p className="text-xs font-medium text-text-secondary mb-1">Roles ({template.template_config.roles.length})</p>
            <div className="space-y-1">
              {template.template_config.roles.map((r, i) => (
                <div key={i} className="text-xs text-text-primary flex items-center gap-2">
                  <Bot className="h-3 w-3 text-text-secondary" />
                  <span className="font-medium">{r.role}</span>
                  <span className="text-text-secondary">({r.agentType})</span>
                  {r.isReceptionist && <span className="text-blue-600 dark:text-blue-400">- Primary</span>}
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-text-secondary mb-1">Routing Rules</p>
            <div className="space-y-1">
              {template.template_config.routingRules.map((r, i) => (
                <div key={i} className="text-xs text-text-primary flex items-center gap-1">
                  <ArrowRight className="h-3 w-3 text-text-secondary" />
                  <span>{r.intent.replace(/_/g, ' ')}</span>
                  <span className="text-text-secondary">to {r.targetRole}</span>
                  {r.fallbackRole && <span className="text-text-secondary">(fallback: {r.fallbackRole})</span>}
                </div>
              ))}
            </div>
          </div>
          {template.template_config.outboundAutomations && template.template_config.outboundAutomations.length > 0 && (
            <div>
              <p className="text-xs font-medium text-text-secondary mb-1">Outbound Automations</p>
              <div className="space-y-1">
                {template.template_config.outboundAutomations.map((a, i) => (
                  <div key={i} className="text-xs text-text-primary flex items-center gap-2">
                    <Send className="h-3 w-3 text-text-secondary" />
                    <span className="font-medium">{a.type.replace(/_/g, ' ')}</span>
                    <span className="text-text-secondary">- {a.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Workforce() {
  const queryClient = useQueryClient();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [activeSection, setActiveSection] = useState<'teams' | 'templates'>('teams');

  const { data: teamsData, isLoading: teamsLoading } = useQuery({
    queryKey: ['workforce', 'teams'],
    queryFn: () => api.get<{ teams: Team[]; total: number }>('/workforce/teams'),
  });

  const { data: templatesData } = useQuery({
    queryKey: ['workforce', 'templates'],
    queryFn: () => api.get<{ templates: Template[] }>('/workforce/templates'),
    enabled: activeSection === 'templates',
  });

  const deleteTeam = useMutation({
    mutationFn: (teamId: string) => api.delete(`/workforce/teams/${teamId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workforce', 'teams'] }),
  });

  const deployTemplate = useMutation({
    mutationFn: (templateId: string) => api.post(`/workforce/templates/${templateId}/deploy`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workforce', 'teams'] });
      setActiveSection('teams');
    },
  });

  const teams = teamsData?.teams ?? [];
  const templates = templatesData?.templates ?? [];

  if (selectedTeamId) {
    return (
      <div className="space-y-6">
        <TeamDetail teamId={selectedTeamId} onBack={() => setSelectedTeamId(null)} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">AI Workforce</h1>
          <p className="text-sm text-text-secondary mt-1">Orchestrate teams of specialized AI agents with intelligent call routing and optimization</p>
        </div>
        <button
          onClick={() => setShowCreateTeam(true)}
          className="flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" /> New Team
        </button>
      </div>

      <div className="flex gap-1 bg-surface-secondary rounded-lg p-1 w-fit">
        <button
          onClick={() => setActiveSection('teams')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            activeSection === 'teams' ? 'bg-surface text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <Network className="h-4 w-4" /> Teams
        </button>
        <button
          onClick={() => setActiveSection('templates')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            activeSection === 'templates' ? 'bg-surface text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          <Layers className="h-4 w-4" /> Industry Templates
        </button>
      </div>

      {activeSection === 'teams' && (
        <>
          {teamsLoading ? (
            <div className="space-y-4">
              {[1,2,3].map(i => <div key={i} className="h-24 bg-surface-secondary rounded-xl animate-pulse" />)}
            </div>
          ) : teams.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center shadow-sm">
              <Network className="h-12 w-12 text-text-secondary/30 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-text-primary mb-2">No workforce teams yet</h3>
              <p className="text-sm text-text-secondary max-w-md mx-auto mb-6">
                Create a team of specialized AI agents that work together to handle incoming calls.
                Or deploy an industry template to get started quickly.
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => setShowCreateTeam(true)}
                  className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  <Plus className="h-4 w-4" /> Create Team
                </button>
                <button
                  onClick={() => setActiveSection('templates')}
                  className="inline-flex items-center gap-2 bg-surface-secondary hover:bg-surface-hover text-text-primary text-sm font-medium px-4 py-2 rounded-lg border border-border transition-colors"
                >
                  <Layers className="h-4 w-4" /> Browse Templates
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {teams.map((team) => (
                <div
                  key={team.id}
                  className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow cursor-pointer group"
                  onClick={() => setSelectedTeamId(team.id)}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Network className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        team.status === 'active'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                      }`}>
                        {team.status}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteTeam.mutate(team.id); }}
                        className="p-1 text-text-secondary hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <h3 className="text-base font-semibold text-text-primary mb-1">{team.name}</h3>
                  {team.description && (
                    <p className="text-xs text-text-secondary mb-3 line-clamp-2">{team.description}</p>
                  )}
                  <div className="flex items-center gap-3 text-xs text-text-secondary">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" /> {team.member_count} agents
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {formatDistanceToNow(new Date(team.created_at), { addSuffix: true })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {activeSection === 'templates' && (
        <div className="space-y-4">
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-5 py-4 border-b border-border">
              <h3 className="text-base font-semibold text-text-primary">Industry Workforce Templates</h3>
              <p className="text-xs text-text-secondary mt-0.5">Pre-built team configurations for common verticals. Deploy with one click to create a team.</p>
            </div>
            <div className="p-4 space-y-3">
              {templates.length === 0 ? (
                <div className="p-8 text-center">
                  <Layers className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
                  <p className="text-text-secondary font-medium">No templates available</p>
                </div>
              ) : (
                templates.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    onDeploy={(id) => deployTemplate.mutate(id)}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {showCreateTeam && (
        <CreateTeamDialog
          onClose={() => setShowCreateTeam(false)}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ['workforce', 'teams'] })}
        />
      )}
    </div>
  );
}
