import { Calendar, Search, Ticket, MessageSquare, Wrench, Check, Loader2 } from 'lucide-react';

export interface ToolExecution {
  id: string;
  tool: string;
  status: 'running' | 'completed';
  startedAt: string;
  completedAt?: string;
}

interface ToolExecutionPanelProps {
  tools: ToolExecution[];
  isActive: boolean;
}

const TOOL_CONFIG: Record<string, { label: string; icon: typeof Calendar; color: string; bgColor: string }> = {
  createServiceTicket: {
    label: 'Create Service Ticket',
    icon: Ticket,
    color: 'text-accent',
    bgColor: 'bg-accent/10',
  },
  createAfterHoursTicket: {
    label: 'After-Hours Ticket',
    icon: Ticket,
    color: 'text-accent',
    bgColor: 'bg-accent/10',
  },
  checkAvailability: {
    label: 'Check Calendar',
    icon: Calendar,
    color: 'text-primary',
    bgColor: 'bg-primary/10',
  },
  scheduleAppointment: {
    label: 'Schedule Appointment',
    icon: Calendar,
    color: 'text-primary',
    bgColor: 'bg-primary/10',
  },
  lookupCustomer: {
    label: 'CRM Lookup',
    icon: Search,
    color: 'text-sidebar-hover',
    bgColor: 'bg-sidebar-bg/10',
  },
  searchCRM: {
    label: 'CRM Search',
    icon: Search,
    color: 'text-sidebar-hover',
    bgColor: 'bg-sidebar-bg/10',
  },
  sendSMS: {
    label: 'SMS Confirmation',
    icon: MessageSquare,
    color: 'text-success',
    bgColor: 'bg-success/10',
  },
  triageEscalate: {
    label: 'Triage Escalation',
    icon: Ticket,
    color: 'text-danger',
    bgColor: 'bg-danger/10',
  },
  retrieve_knowledge: {
    label: 'Knowledge Base Search',
    icon: Search,
    color: 'text-sidebar-hover',
    bgColor: 'bg-sidebar-bg/10',
  },
};

function getToolConfig(toolName: string) {
  return TOOL_CONFIG[toolName] ?? {
    label: toolName.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim(),
    icon: Wrench,
    color: 'text-text-primary/60',
    bgColor: 'bg-text-primary/5',
  };
}

function formatToolTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function ToolExecutionPanel({ tools, isActive }: ToolExecutionPanelProps) {
  return (
    <div className="bg-white rounded-2xl border border-border-strong/50 p-6">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center">
          <Wrench className="h-4 w-4 text-accent" />
        </div>
        <h3 className="font-display font-semibold text-sidebar-bg">Tool Executions</h3>
        {isActive && tools.some((t) => t.status === 'running') && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-accent font-body">
            <Loader2 className="h-3 w-3 animate-spin" />
            Processing
          </span>
        )}
      </div>

      <div className="space-y-2.5 max-h-80 overflow-y-auto">
        {tools.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-primary/40 font-body">
            <Wrench className="h-7 w-7 mb-2 opacity-40" />
            <p className="text-sm">
              {isActive ? 'Waiting for tool invocations...' : 'Tool activity will appear here during calls'}
            </p>
          </div>
        ) : (
          tools.map((tool) => {
            const config = getToolConfig(tool.tool);
            const Icon = config.icon;

            return (
              <div
                key={tool.id}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-all duration-300 animate-[fadeSlideIn_0.3s_ease-out] ${
                  tool.status === 'running'
                    ? 'border-accent/30 bg-accent/5'
                    : 'border-border-strong/30 bg-surface-secondary'
                }`}
              >
                <div className={`w-9 h-9 rounded-lg ${config.bgColor} flex items-center justify-center shrink-0`}>
                  <Icon className={`h-4 w-4 ${config.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-sidebar-bg font-body truncate">{config.label}</p>
                  <p className="text-[11px] text-text-primary/40 font-body">{formatToolTime(tool.startedAt)}</p>
                </div>
                <div className="shrink-0">
                  {tool.status === 'running' ? (
                    <div className="flex items-center gap-1.5 text-xs text-accent font-body">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Running</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs text-success font-body">
                      <Check className="h-3.5 w-3.5" />
                      <span>Done</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
