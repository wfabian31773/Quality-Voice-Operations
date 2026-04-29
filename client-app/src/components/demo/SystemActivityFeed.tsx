import {
  Phone,
  PhoneOff,
  Bot,
  Wrench,
  ArrowUpRight,
  CheckCircle,
  XCircle,
  Activity,
  Zap,
} from 'lucide-react';

export interface ActivityEvent {
  id: string;
  eventType: string;
  fromState: string | null;
  toState: string | null;
  payload: Record<string, unknown> | null;
  timestamp: string;
}

interface SystemActivityFeedProps {
  events: ActivityEvent[];
  isActive: boolean;
}

const EVENT_CONFIG: Record<string, { label: string; icon: typeof Phone; color: string; bgColor: string }> = {
  call_received: {
    label: 'Call Received',
    icon: Phone,
    color: 'text-primary',
    bgColor: 'bg-primary/10',
  },
  agent_connected: {
    label: 'Agent Connected',
    icon: Bot,
    color: 'text-success',
    bgColor: 'bg-success/10',
  },
  tool_start: {
    label: 'Tool Invoked',
    icon: Wrench,
    color: 'text-accent',
    bgColor: 'bg-accent/10',
  },
  tool_end: {
    label: 'Tool Completed',
    icon: CheckCircle,
    color: 'text-success',
    bgColor: 'bg-success/10',
  },
  workflow_execution_start: {
    label: 'Workflow Triggered',
    icon: Zap,
    color: 'text-accent',
    bgColor: 'bg-accent/10',
  },
  escalation_active: {
    label: 'Escalation Active',
    icon: ArrowUpRight,
    color: 'text-danger',
    bgColor: 'bg-danger/10',
  },
  escalation_success: {
    label: 'Escalation Successful',
    icon: CheckCircle,
    color: 'text-success',
    bgColor: 'bg-success/10',
  },
  escalation_failed: {
    label: 'Escalation Failed',
    icon: XCircle,
    color: 'text-danger',
    bgColor: 'bg-danger/10',
  },
  call_completed: {
    label: 'Call Completed',
    icon: PhoneOff,
    color: 'text-success',
    bgColor: 'bg-success/10',
  },
  session_closed: {
    label: 'Session Closed',
    icon: PhoneOff,
    color: 'text-text-primary/60',
    bgColor: 'bg-text-primary/5',
  },
};

function getEventConfig(eventType: string) {
  return EVENT_CONFIG[eventType.toLowerCase()] ?? {
    label: eventType.replace(/_/g, ' '),
    icon: Activity,
    color: 'text-text-primary/60',
    bgColor: 'bg-text-primary/5',
  };
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getToolDetail(payload: Record<string, unknown> | null): string | null {
  if (!payload?.tool) return null;
  const toolName = payload.tool as string;
  const labels: Record<string, string> = {
    createServiceTicket: 'Service Ticket',
    createAfterHoursTicket: 'After-Hours Ticket',
    checkAvailability: 'Calendar Check',
    scheduleAppointment: 'Scheduling',
    lookupCustomer: 'CRM Lookup',
    sendSMS: 'SMS',
    triageEscalate: 'Triage',
    retrieve_knowledge: 'Knowledge Base',
  };
  return labels[toolName] ?? toolName;
}

export default function SystemActivityFeed({ events, isActive }: SystemActivityFeedProps) {
  return (
    <div className="bg-white rounded-2xl border border-border-strong/50 p-6">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-lg bg-sidebar-bg/10 flex items-center justify-center">
          <Activity className="h-4 w-4 text-sidebar-bg" />
        </div>
        <h3 className="font-display font-semibold text-sidebar-bg">System Activity</h3>
        {isActive && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-success font-body">
            <span aria-hidden="true" className="w-2 h-2 bg-success rounded-full animate-pulse" />
            Streaming
          </span>
        )}
      </div>

      <div className="space-y-1.5 max-h-80 overflow-y-auto">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-primary/40 font-body">
            <Activity className="h-7 w-7 mb-2 opacity-40" />
            <p className="text-sm">
              {isActive ? 'Waiting for events...' : 'System events appear here during calls'}
            </p>
          </div>
        ) : (
          events.map((event) => {
            const config = getEventConfig(event.eventType);
            const Icon = config.icon;
            const toolDetail = getToolDetail(event.payload);

            return (
              <div
                key={event.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-secondary transition-colors animate-[fadeSlideIn_0.2s_ease-out]"
              >
                <div className={`w-7 h-7 rounded-md ${config.bgColor} flex items-center justify-center shrink-0`}>
                  <Icon className={`h-3.5 w-3.5 ${config.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-sidebar-bg font-body truncate">
                    {config.label}
                    {toolDetail && (
                      <span className="text-text-primary/40 font-normal"> — {toolDetail}</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-text-primary/30 font-body">{formatTimestamp(event.timestamp)}</span>
                  <span className="text-[10px] text-text-primary/20 font-body">{timeAgo(event.timestamp)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
