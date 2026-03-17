import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { CheckCircle2, Circle, Bot, Phone, Plug, PhoneCall, ArrowRight, X } from 'lucide-react';
import { useState } from 'react';

interface ActivationMilestones {
  agent_created: boolean;
  phone_connected: boolean;
  tools_connected: boolean;
  first_call_completed: boolean;
  first_workflow_executed: boolean;
}

const STEPS = [
  { key: 'agent_created', label: 'Create your first agent', icon: Bot, path: '/agents', cta: 'Create Agent' },
  { key: 'phone_connected', label: 'Connect a phone number', icon: Phone, path: '/phone-numbers', cta: 'Add Number' },
  { key: 'tools_connected', label: 'Connect your tools', icon: Plug, path: '/connectors', cta: 'Connect' },
  { key: 'first_call_completed', label: 'Complete your first call', icon: PhoneCall, path: '/agents', cta: 'Test Call' },
] as const;

export default function OnboardingChecklist() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['activation-milestones'],
    queryFn: () => api.get<{ milestones: ActivationMilestones }>('/tenants/me/activation'),
    staleTime: 30000,
  });

  if (isLoading || !data || dismissed) return null;

  const milestones = data.milestones;
  const completed = STEPS.filter((s) => milestones[s.key]).length;

  if (completed >= STEPS.length) return null;

  const progress = Math.round((completed / STEPS.length) * 100);

  return (
    <div className="bg-gradient-to-br from-[#123047] to-[#1a4a6b] rounded-xl p-6 text-white shadow-lg relative">
      <button
        onClick={() => setDismissed(true)}
        className="absolute top-3 right-3 text-white/40 hover:text-white/80 transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex items-center gap-3 mb-4">
        <div>
          <h2 className="text-lg font-semibold">Activation Progress</h2>
          <p className="text-sm text-white/70">{completed} of {STEPS.length} steps complete</p>
        </div>
      </div>

      <div className="w-full bg-white/10 rounded-full h-2 mb-5">
        <div
          className="bg-green-400 h-2 rounded-full transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="space-y-3">
        {STEPS.map((step) => {
          const done = milestones[step.key];
          const Icon = step.icon;
          return (
            <div key={step.key} className="flex items-center gap-3">
              {done ? (
                <CheckCircle2 className="h-5 w-5 text-green-400 shrink-0" />
              ) : (
                <Circle className="h-5 w-5 text-white/30 shrink-0" />
              )}
              <Icon className={`h-4 w-4 shrink-0 ${done ? 'text-white/50' : 'text-white/80'}`} />
              <span className={`text-sm flex-1 ${done ? 'text-white/50 line-through' : 'text-white'}`}>
                {step.label}
              </span>
              {!done && (
                <button
                  onClick={() => navigate(step.path)}
                  className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1 rounded-lg transition-colors flex items-center gap-1"
                >
                  {step.cta} <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
