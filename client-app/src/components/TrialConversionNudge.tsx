import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { ArrowUpCircle, X, Zap, TrendingUp } from 'lucide-react';
import { useState, useMemo } from 'react';

interface Subscription {
  plan: string;
  status: string;
  monthly_call_limit: number;
  monthly_ai_minute_limit: number;
}

interface UsageData {
  usage: Record<string, number>;
}

interface ActivationMilestones {
  agent_created: boolean;
  agent_deployed: boolean;
  first_call_completed: boolean;
}

type NudgeType = 'usage_limit' | 'first_deployment' | 'first_call' | 'calls_milestone';

interface NudgeConfig {
  type: NudgeType;
  title: string;
  message: string;
  icon: typeof Zap;
  ctaLabel: string;
}

export default function TrialConversionNudge() {
  const navigate = useNavigate();
  const [dismissedNudges, setDismissedNudges] = useState<Set<NudgeType>>(() => {
    try {
      const stored = localStorage.getItem('dismissed_nudges');
      return stored ? new Set(JSON.parse(stored) as NudgeType[]) : new Set();
    } catch {
      return new Set();
    }
  });

  const { data: subData } = useQuery({
    queryKey: ['billing', 'subscription'],
    queryFn: () => api.get<{ subscription: Subscription | null }>('/billing/subscription'),
    staleTime: 60000,
  });

  const { data: usageData } = useQuery({
    queryKey: ['billing', 'usage-nudge'],
    queryFn: () => api.get<UsageData>('/billing/usage'),
    staleTime: 60000,
  });

  const { data: activationData } = useQuery({
    queryKey: ['activation-milestones'],
    queryFn: () => api.get<{ milestones: ActivationMilestones }>('/tenants/me/activation'),
    staleTime: 30000,
  });

  const sub = subData?.subscription;
  const isTrialOrStarter = !sub || sub.plan === 'starter' || sub.status === 'trialing';

  const nudge = useMemo<NudgeConfig | null>(() => {
    if (!isTrialOrStarter) return null;
    if (!usageData || !activationData) return null;

    const usage = usageData.usage;
    const milestones = activationData.milestones;
    const callsUsed = (usage.calls_inbound ?? 0) + (usage.calls_outbound ?? 0);
    const callLimit = sub?.monthly_call_limit ?? 500;
    const aiUsed = usage.ai_minutes ?? 0;
    const aiLimit = sub?.monthly_ai_minute_limit ?? 250;

    const callPct = callLimit > 0 ? callsUsed / callLimit : 0;
    const aiPct = aiLimit > 0 ? aiUsed / aiLimit : 0;

    if ((callPct >= 0.8 || aiPct >= 0.8) && !dismissedNudges.has('usage_limit')) {
      const resource = callPct >= aiPct ? 'calls' : 'AI minutes';
      const pct = Math.round(Math.max(callPct, aiPct) * 100);
      return {
        type: 'usage_limit',
        title: 'Approaching Plan Limit',
        message: `You've used ${pct}% of your monthly ${resource}. Upgrade to Pro for higher limits and unlock advanced features.`,
        icon: ArrowUpCircle,
        ctaLabel: 'View Plans',
      };
    }

    if (milestones.first_call_completed && callsUsed >= 3 && !dismissedNudges.has('calls_milestone')) {
      return {
        type: 'calls_milestone',
        title: 'Great Progress!',
        message: `You've completed ${callsUsed} calls. Upgrade to unlock advanced analytics, campaign tools, and higher limits.`,
        icon: TrendingUp,
        ctaLabel: 'See Pro Benefits',
      };
    }

    if (milestones.first_call_completed && callsUsed < 3 && !dismissedNudges.has('first_call')) {
      return {
        type: 'first_call',
        title: 'First Call Complete!',
        message: 'Congratulations on your first call! Upgrade to Pro for advanced analytics, unlimited agents, and priority support.',
        icon: TrendingUp,
        ctaLabel: 'See Pro Benefits',
      };
    }

    if (milestones.agent_deployed && !milestones.first_call_completed && !dismissedNudges.has('first_deployment')) {
      return {
        type: 'first_deployment',
        title: 'Agent Deployed!',
        message: 'Your agent is published and ready to handle calls. Upgrade to Pro for more agents, higher call volumes, and priority support.',
        icon: Zap,
        ctaLabel: 'Upgrade Now',
      };
    }

    return null;
  }, [isTrialOrStarter, usageData, activationData, sub, dismissedNudges]);

  const handleDismiss = (type: NudgeType) => {
    const next = new Set(dismissedNudges);
    next.add(type);
    setDismissedNudges(next);
    try {
      localStorage.setItem('dismissed_nudges', JSON.stringify([...next]));
    } catch {}
  };

  if (!nudge) return null;

  const Icon = nudge.icon;

  return (
    <div className="bg-gradient-to-r from-purple-600 to-indigo-600 rounded-xl p-4 text-white shadow-lg relative">
      <button
        onClick={() => handleDismiss(nudge.type)}
        className="absolute top-3 right-3 text-white/40 hover:text-white/80 transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex items-start gap-3">
        <div className="p-2 bg-white/10 rounded-lg shrink-0">
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold">{nudge.title}</h3>
          <p className="text-xs text-white/80 mt-1">{nudge.message}</p>
          <button
            onClick={() => navigate('/billing')}
            className="mt-3 text-xs bg-white/20 hover:bg-white/30 px-4 py-1.5 rounded-lg transition-colors font-medium"
          >
            {nudge.ctaLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
