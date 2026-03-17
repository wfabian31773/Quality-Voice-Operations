import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Plus, Pencil, Trash2, X, Save, ArrowLeft,
  GitBranch, Zap, Clock, Phone, MessageSquare,
  PhoneOff, UserPlus, Mail, ChevronDown, ChevronUp,
  Workflow as WorkflowIcon,
} from 'lucide-react';

interface WorkflowStep {
  id: string;
  type: 'trigger' | 'condition' | 'action';
  name: string;
  config: Record<string, string>;
}

interface Workflow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  steps: WorkflowStep[];
  created_at: string;
  updated_at: string;
}

const STEP_TYPES = {
  trigger: {
    label: 'Trigger',
    icon: Zap,
    color: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-900/30',
    border: 'border-amber-300 dark:border-amber-700',
  },
  condition: {
    label: 'Condition',
    icon: GitBranch,
    color: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-900/30',
    border: 'border-blue-300 dark:border-blue-700',
  },
  action: {
    label: 'Action',
    icon: Zap,
    color: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-900/30',
    border: 'border-emerald-300 dark:border-emerald-700',
  },
};

const CONDITION_OPTIONS = [
  { value: 'time-of-day', label: 'Time of Day' },
  { value: 'caller-intent', label: 'Caller Intent' },
  { value: 'business-hours', label: 'Business Hours' },
  { value: 'caller-history', label: 'Caller History' },
  { value: 'custom', label: 'Custom Expression' },
];

const ACTION_OPTIONS = [
  { value: 'transfer', label: 'Transfer Call', icon: Phone },
  { value: 'voicemail', label: 'Send to Voicemail', icon: PhoneOff },
  { value: 'sms', label: 'Send SMS', icon: Mail },
  { value: 'hang-up', label: 'Hang Up', icon: PhoneOff },
  { value: 'escalate', label: 'Escalate to Human', icon: UserPlus },
];

const TRIGGER_OPTIONS = [
  { value: 'inbound-call', label: 'Inbound Call Received' },
  { value: 'after-hours', label: 'After-Hours Call' },
  { value: 'overflow', label: 'Overflow / Queue Full' },
  { value: 'scheduled', label: 'Scheduled Trigger' },
];

function generateId() {
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function StepCard({
  step,
  index,
  total,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  onUpdate: (step: WorkflowStep) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const meta = STEP_TYPES[step.type];
  const Icon = meta.icon;

  return (
    <div className={`border-2 ${meta.border} ${meta.bg} rounded-xl p-4 transition-shadow hover:shadow-md`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${meta.color}`} />
          <span className={`text-xs font-semibold uppercase tracking-wider ${meta.color}`}>
            {meta.label}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onMoveUp}
            disabled={index === 0}
            className="p-1 text-text-secondary hover:text-text-primary disabled:opacity-30 transition"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            onClick={onMoveDown}
            disabled={index === total - 1}
            className="p-1 text-text-secondary hover:text-text-primary disabled:opacity-30 transition"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button onClick={onDelete} className="p-1 text-text-secondary hover:text-danger transition">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Step Type</label>
          <select
            value={step.type}
            onChange={(e) => onUpdate({ ...step, type: e.target.value as 'trigger' | 'condition' | 'action', config: {} })}
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm"
          >
            <option value="trigger">Trigger</option>
            <option value="condition">Condition</option>
            <option value="action">Action</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Step Name</label>
          <input
            value={step.name}
            onChange={(e) => onUpdate({ ...step, name: e.target.value })}
            placeholder="e.g., Check business hours"
            className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        {step.type === 'trigger' && (
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Trigger Type</label>
            <select
              value={step.config.triggerType ?? ''}
              onChange={(e) => onUpdate({ ...step, config: { ...step.config, triggerType: e.target.value } })}
              className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm"
            >
              <option value="">Select trigger...</option>
              {TRIGGER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}

        {step.type === 'condition' && (
          <>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Condition Type</label>
              <select
                value={step.config.conditionType ?? ''}
                onChange={(e) => onUpdate({ ...step, config: { ...step.config, conditionType: e.target.value } })}
                className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm"
              >
                <option value="">Select condition...</option>
                {CONDITION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Expression / Value</label>
              <input
                value={step.config.expression ?? ''}
                onChange={(e) => onUpdate({ ...step, config: { ...step.config, expression: e.target.value } })}
                placeholder={step.config.conditionType === 'time-of-day' ? 'e.g., 09:00-17:00' : 'e.g., scheduling, billing'}
                className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">True Branch Label</label>
              <input
                value={step.config.trueBranch ?? ''}
                onChange={(e) => onUpdate({ ...step, config: { ...step.config, trueBranch: e.target.value } })}
                placeholder="e.g., During hours"
                className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">False Branch Label</label>
              <input
                value={step.config.falseBranch ?? ''}
                onChange={(e) => onUpdate({ ...step, config: { ...step.config, falseBranch: e.target.value } })}
                placeholder="e.g., After hours"
                className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </>
        )}

        {step.type === 'action' && (
          <>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Action Type</label>
              <select
                value={step.config.actionType ?? ''}
                onChange={(e) => onUpdate({ ...step, config: { ...step.config, actionType: e.target.value } })}
                className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm"
              >
                <option value="">Select action...</option>
                {ACTION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            {step.config.actionType === 'transfer' && (
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Transfer To (number or department)</label>
                <input
                  value={step.config.transferTo ?? ''}
                  onChange={(e) => onUpdate({ ...step, config: { ...step.config, transferTo: e.target.value } })}
                  placeholder="e.g., +15551234567 or Sales"
                  className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            )}
            {step.config.actionType === 'sms' && (
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">SMS Message Template</label>
                <textarea
                  value={step.config.smsMessage ?? ''}
                  onChange={(e) => onUpdate({ ...step, config: { ...step.config, smsMessage: e.target.value } })}
                  rows={2}
                  placeholder="e.g., Thank you for calling. We will get back to you shortly."
                  className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
                />
              </div>
            )}
            {step.config.actionType === 'voicemail' && (
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Voicemail Prompt</label>
                <input
                  value={step.config.voicemailPrompt ?? ''}
                  onChange={(e) => onUpdate({ ...step, config: { ...step.config, voicemailPrompt: e.target.value } })}
                  placeholder="e.g., Please leave a message after the tone"
                  className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            )}
            {step.config.actionType === 'escalate' && (
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Escalation Target</label>
                <input
                  value={step.config.escalationTarget ?? ''}
                  onChange={(e) => onUpdate({ ...step, config: { ...step.config, escalationTarget: e.target.value } })}
                  placeholder="e.g., On-call manager"
                  className="w-full px-3 py-1.5 rounded-lg border border-border bg-white dark:bg-gray-800 text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function WorkflowBuilder({
  workflow,
  onBack,
}: {
  workflow?: Workflow;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [steps, setSteps] = useState<WorkflowStep[]>(workflow?.steps ?? []);

  const saveMutation = useMutation({
    mutationFn: (data: { name: string; description: string; steps: WorkflowStep[] }) =>
      workflow
        ? api.patch<{ workflow: Workflow }>(`/workflows/${workflow.id}`, data)
        : api.post<{ workflow: Workflow }>('/workflows', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      onBack();
    },
  });

  const addStep = (type: 'trigger' | 'condition' | 'action') => {
    setSteps((prev) => [...prev, { id: generateId(), type, name: '', config: {} }]);
  };

  const updateStep = (index: number, step: WorkflowStep) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? step : s)));
  };

  const deleteStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const newSteps = [...steps];
    const target = index + direction;
    if (target < 0 || target >= newSteps.length) return;
    [newSteps[index], newSteps[target]] = [newSteps[target], newSteps[index]];
    setSteps(newSteps);
  };

  const handleSave = () => {
    if (!name.trim()) return;
    saveMutation.mutate({ name: name.trim(), description: description.trim(), steps });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition">
          <ArrowLeft className="h-4 w-4" /> Back to Workflows
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || saveMutation.isPending}
          className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition disabled:opacity-50"
        >
          <Save className="h-4 w-4" /> {saveMutation.isPending ? 'Saving...' : 'Save Workflow'}
        </button>
      </div>

      {saveMutation.error && (
        <p className="text-danger text-sm">{(saveMutation.error as Error).message}</p>
      )}

      <div className="bg-surface border border-border rounded-xl p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Workflow Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Lead Qualification Flow"
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Describe what this workflow does..."
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
          />
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-text-primary">Steps</h3>

        {steps.length === 0 && (
          <div className="bg-surface border border-border border-dashed rounded-xl p-8 text-center">
            <WorkflowIcon className="h-8 w-8 text-text-muted mx-auto mb-2" />
            <p className="text-sm text-text-secondary">No steps yet. Add a trigger to start building your workflow.</p>
          </div>
        )}

        {steps.map((step, i) => (
          <div key={step.id}>
            {i > 0 && (
              <div className="flex justify-center py-1">
                <div className="w-px h-6 bg-border" />
              </div>
            )}
            <StepCard
              step={step}
              index={i}
              total={steps.length}
              onUpdate={(s) => updateStep(i, s)}
              onDelete={() => deleteStep(i)}
              onMoveUp={() => moveStep(i, -1)}
              onMoveDown={() => moveStep(i, 1)}
            />
          </div>
        ))}

        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={() => addStep('trigger')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition"
          >
            <Zap className="h-3.5 w-3.5" /> Add Trigger
          </button>
          <button
            onClick={() => addStep('condition')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition"
          >
            <GitBranch className="h-3.5 w-3.5" /> Add Condition
          </button>
          <button
            onClick={() => addStep('action')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition"
          >
            <Zap className="h-3.5 w-3.5" /> Add Action
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Workflows() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'list' | 'builder'>('list');
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | undefined>();

  const { data, isLoading } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api.get<{ workflows: Workflow[]; total: number }>('/workflows?limit=100'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/workflows/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workflows'] }),
  });

  const workflows = data?.workflows ?? [];

  if (view === 'builder') {
    return (
      <WorkflowBuilder
        workflow={editingWorkflow}
        onBack={() => {
          setView('list');
          setEditingWorkflow(undefined);
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Workflows</h1>
          <p className="text-sm text-text-secondary mt-1">Configure call routing, lead qualification, and escalation rules</p>
        </div>
        <button
          onClick={() => {
            setEditingWorkflow(undefined);
            setView('builder');
          }}
          className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2.5 rounded-lg transition"
        >
          <Plus className="h-4 w-4" /> New Workflow
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">Loading...</div>
      ) : workflows.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <WorkflowIcon className="h-12 w-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-secondary">No workflows yet. Create your first workflow to automate call handling.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.map((wf) => (
            <div key={wf.id} className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <h3 className="font-semibold text-text-primary">{wf.name}</h3>
                  {wf.description && (
                    <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{wf.description}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs text-text-secondary mb-4">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {new Date(wf.created_at).toLocaleDateString()}
                </span>
                <span>{wf.steps.length} step{wf.steps.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="flex flex-wrap gap-1 mb-4">
                {wf.steps.slice(0, 4).map((s) => {
                  const meta = STEP_TYPES[s.type];
                  return (
                    <span key={s.id} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${meta.bg} ${meta.color} border ${meta.border}`}>
                      {s.name || meta.label}
                    </span>
                  );
                })}
                {wf.steps.length > 4 && (
                  <span className="text-[10px] text-text-muted px-1">+{wf.steps.length - 4} more</span>
                )}
              </div>
              <div className="flex items-center gap-2 pt-2 border-t border-border">
                <button
                  onClick={() => {
                    setEditingWorkflow(wf);
                    setView('builder');
                  }}
                  className="text-text-secondary hover:text-primary text-xs font-medium inline-flex items-center gap-1 transition"
                >
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
                <button
                  onClick={() => {
                    if (confirm('Delete this workflow? Any agents using it will be unlinked.')) deleteMut.mutate(wf.id);
                  }}
                  className="text-text-secondary hover:text-danger text-xs font-medium inline-flex items-center gap-1 transition ml-auto"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
