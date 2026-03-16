import { Phone, PhoneCall, PhoneOff, Loader2 } from 'lucide-react';

export type CallStatus = 'idle' | 'ringing' | 'connected' | 'ended';

interface CallStatusIndicatorProps {
  status: CallStatus;
  agentName?: string | null;
  duration?: number | null;
}

const STATUS_CONFIG: Record<CallStatus, {
  label: string;
  icon: typeof Phone;
  color: string;
  bgColor: string;
  borderColor: string;
  animate?: boolean;
}> = {
  idle: {
    label: 'Ready to Demo',
    icon: Phone,
    color: 'text-slate-ink/50',
    bgColor: 'bg-mist',
    borderColor: 'border-soft-steel/50',
  },
  ringing: {
    label: 'Incoming Call',
    icon: PhoneCall,
    color: 'text-warm-amber',
    bgColor: 'bg-warm-amber/5',
    borderColor: 'border-warm-amber/30',
    animate: true,
  },
  connected: {
    label: 'Call Active',
    icon: PhoneCall,
    color: 'text-calm-green',
    bgColor: 'bg-calm-green/5',
    borderColor: 'border-calm-green/30',
    animate: true,
  },
  ended: {
    label: 'Call Ended',
    icon: PhoneOff,
    color: 'text-slate-ink/50',
    bgColor: 'bg-mist',
    borderColor: 'border-soft-steel/50',
  },
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function CallStatusIndicator({ status, agentName, duration }: CallStatusIndicatorProps) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <div
      className={`flex items-center gap-3 px-5 py-4 rounded-xl border transition-all duration-500 ${config.bgColor} ${config.borderColor}`}
    >
      <div className="relative">
        <Icon className={`h-5 w-5 ${config.color}`} />
        {config.animate && (
          <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${
            status === 'ringing' ? 'bg-warm-amber' : 'bg-calm-green'
          } animate-pulse`} />
        )}
      </div>
      <div className="flex-1">
        <p className={`text-sm font-semibold font-body ${config.color}`}>{config.label}</p>
        {agentName && status !== 'idle' && (
          <p className="text-xs text-slate-ink/40 font-body">{agentName}</p>
        )}
      </div>
      {status === 'connected' && (
        <div className="flex items-center gap-1.5 text-xs text-calm-green font-body">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Live</span>
        </div>
      )}
      {status === 'ended' && duration != null && (
        <span className="text-xs text-slate-ink/40 font-body">{formatDuration(duration)}</span>
      )}
    </div>
  );
}
