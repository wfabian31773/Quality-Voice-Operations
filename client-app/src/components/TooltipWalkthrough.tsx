import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { X, Lightbulb } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';

interface ActivationMilestones {
  agent_created: boolean;
  agent_deployed: boolean;
  phone_connected: boolean;
  tools_connected: boolean;
  first_call_completed: boolean;
  first_workflow_executed: boolean;
}

const milestoneKeyMap: Record<string, keyof ActivationMilestones> = {
  'agents-create': 'agent_created',
  'phone-setup': 'phone_connected',
  'knowledge-base-intro': 'tools_connected',
  'builder-deploy': 'agent_deployed',
};

interface TooltipWalkthroughProps {
  tooltipKey: string;
  title: string;
  description: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
  children: React.ReactNode;
}

export default function TooltipWalkthrough({
  tooltipKey,
  title,
  description,
  position = 'bottom',
  children,
}: TooltipWalkthroughProps) {
  const queryClient = useQueryClient();
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['tooltip-dismissals'],
    queryFn: () => api.get<{ dismissed: string[] }>('/tenants/me/tooltips'),
    staleTime: 60000,
  });

  const { data: activationData } = useQuery({
    queryKey: ['activation-milestones'],
    queryFn: () => api.get<{ milestones: ActivationMilestones }>('/tenants/me/activation'),
    staleTime: 30000,
  });

  const dismissMutation = useMutation({
    mutationFn: () => api.post('/tenants/me/tooltips/dismiss', { tooltipKey }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tooltip-dismissals'] });
    },
  });

  useEffect(() => {
    if (!data || !activationData) return;

    const milestoneField = milestoneKeyMap[tooltipKey];
    if (milestoneField && activationData.milestones[milestoneField]) {
      setVisible(false);
      return;
    }

    if (!data.dismissed.includes(tooltipKey)) {
      const timer = setTimeout(() => setVisible(true), 500);
      return () => clearTimeout(timer);
    }
    setVisible(false);
  }, [data, activationData, tooltipKey]);

  const handleDismiss = () => {
    setVisible(false);
    dismissMutation.mutate();
  };

  const positionClasses: Record<string, string> = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  const arrowClasses: Record<string, string> = {
    top: 'top-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-b-transparent border-t-primary',
    bottom: 'bottom-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-t-transparent border-b-primary',
    left: 'left-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-r-transparent border-l-primary',
    right: 'right-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-l-transparent border-r-primary',
  };

  return (
    <div className="relative inline-block" ref={ref}>
      {children}
      {visible && (
        <div
          className={`absolute z-50 ${positionClasses[position]} w-72 bg-primary text-white rounded-xl p-4 shadow-xl animate-in fade-in slide-in-from-bottom-2 duration-300`}
        >
          <div className={`absolute border-8 ${arrowClasses[position]}`} />
          <button
            onClick={handleDismiss}
            className="absolute top-2 right-2 text-white/60 hover:text-white transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="flex items-start gap-2">
            <Lightbulb className="h-4 w-4 shrink-0 mt-0.5 text-white/80" />
            <div>
              <p className="text-sm font-semibold mb-1">{title}</p>
              <p className="text-xs text-white/80 leading-relaxed">{description}</p>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            className="mt-3 text-xs bg-white/20 hover:bg-white/30 px-3 py-1.5 rounded-lg transition-colors w-full"
          >
            Got it
          </button>
        </div>
      )}
    </div>
  );
}
