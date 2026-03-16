import { type ReactNode } from 'react';
import {
  Phone, MessageSquare, Search, Calendar, CheckCircle,
  Stethoscope, Brain, CalendarCheck, Pill, Smartphone,
  Scale, FileText, ShieldCheck, Clock, Mail,
  Home, Building, CalendarDays, Database, BellRing,
  Headphones, HelpCircle, BookOpen, Ticket, SmilePlus,
  PhoneIncoming, Bot, Wrench, Send, ClipboardCheck,
} from 'lucide-react';

export interface WorkflowStep {
  icon: ReactNode;
  label: string;
  description?: string;
}

const ACCENT_TOKENS = {
  teal: { color: '#2E8C83', bg: '#d0f0ed' },
  gold: { color: '#8B6914', bg: '#FDF6E3' },
  green: { color: '#1a6b4a', bg: '#e6f5ee' },
  blue: { color: '#2D5F96', bg: '#E8F0FA' },
} as const;

type AccentKey = keyof typeof ACCENT_TOKENS;

interface WorkflowDiagramProps {
  steps: WorkflowStep[];
  accent?: AccentKey;
  title?: string;
  compact?: boolean;
}

function ArrowConnector({ color, compact }: { color: string; compact?: boolean }) {
  return (
    <li className="flex items-center justify-center shrink-0" role="presentation" aria-hidden="true">
      <div className={`hidden md:flex items-center ${compact ? 'w-6 lg:w-8' : 'w-10 lg:w-14'}`}>
        <div className="h-0.5 flex-1 rounded-full" style={{ backgroundColor: color, opacity: 0.4 }} />
        <svg width="10" height="12" viewBox="0 0 10 12" fill="none" className="shrink-0 -ml-0.5" aria-hidden="true">
          <path d="M1 1L8 6L1 11" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.65" />
        </svg>
      </div>
      <div className="flex md:hidden items-center justify-center h-8 w-full">
        <svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden="true">
          <path d="M1 1L6 8L11 1" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.65" />
        </svg>
      </div>
    </li>
  );
}

function StepCard({ step, color, bg, compact, stepNumber, totalSteps }: {
  step: WorkflowStep;
  color: string;
  bg: string;
  compact?: boolean;
  stepNumber: number;
  totalSteps: number;
}) {
  const iconSize = compact ? 'w-10 h-10 lg:w-12 lg:h-12' : 'w-14 h-14 lg:w-16 lg:h-16';
  const iconInner = compact ? '[&_svg]:w-5 [&_svg]:h-5 lg:[&_svg]:w-6 lg:[&_svg]:h-6' : '[&_svg]:w-6 [&_svg]:h-6 lg:[&_svg]:w-7 lg:[&_svg]:h-7';

  return (
    <li
      className={`group/step flex flex-col items-center text-center flex-1 min-w-0 ${compact ? 'px-1' : 'px-2'}`}
      aria-label={`Step ${stepNumber} of ${totalSteps}: ${step.label}${step.description ? ` — ${step.description}` : ''}`}
    >
      <div
        className={`${iconSize} rounded-2xl flex items-center justify-center mb-3 transition-all duration-300 group-hover/step:scale-110 group-hover/step:shadow-lg ${iconInner}`}
        style={{ backgroundColor: bg, color }}
        aria-hidden="true"
      >
        {step.icon}
      </div>
      <p className={`font-display font-semibold text-harbor leading-tight mb-1 ${compact ? 'text-xs lg:text-sm' : 'text-sm lg:text-base'}`}>
        {step.label}
      </p>
      {step.description && (
        <p className={`text-slate-ink/70 font-body leading-snug ${compact ? 'text-[10px] lg:text-xs max-w-[110px]' : 'text-xs lg:text-sm max-w-[160px]'}`}>
          {step.description}
        </p>
      )}
    </li>
  );
}

export default function WorkflowDiagram({
  steps,
  accent = 'teal',
  title,
  compact = false,
}: WorkflowDiagramProps) {
  const tokens = ACCENT_TOKENS[accent];

  return (
    <div
      className={`rounded-2xl border border-soft-steel/20 bg-white overflow-hidden transition-all duration-300 shadow-sm hover:shadow-lg hover:border-soft-steel/30 ${compact ? 'p-5 lg:p-6' : 'p-6 lg:p-10'}`}
      role="figure"
      aria-label={title ? `${title} workflow diagram` : 'Agent workflow diagram'}
    >
      {title && (
        <h4 className="font-display text-base lg:text-lg font-bold text-harbor text-center mb-6 lg:mb-8">
          {title}
        </h4>
      )}
      <ol className={`flex flex-col md:flex-row items-center md:items-start justify-between list-none p-0 m-0 ${compact ? 'gap-2 md:gap-1' : 'gap-2 md:gap-0'}`}>
        {steps.flatMap((step, i) => {
          const items = [
            <StepCard
              key={`step-${i}`}
              step={step}
              color={tokens.color}
              bg={tokens.bg}
              compact={compact}
              stepNumber={i + 1}
              totalSteps={steps.length}
            />,
          ];
          if (i < steps.length - 1) {
            items.push(<ArrowConnector key={`arrow-${i}`} color={tokens.color} compact={compact} />);
          }
          return items;
        })}
      </ol>
    </div>
  );
}

export const genericWorkflowSteps: WorkflowStep[] = [
  { icon: <PhoneIncoming />, label: 'Incoming Call', description: 'Call received and routed' },
  { icon: <Bot />, label: 'AI Greeting', description: 'Agent answers naturally' },
  { icon: <Search />, label: 'Issue Identification', description: 'Understands caller needs' },
  { icon: <Wrench />, label: 'Tool Execution', description: 'CRM, calendar, tickets' },
  { icon: <CheckCircle />, label: 'Resolution', description: 'Action completed' },
  { icon: <Send />, label: 'Confirmation', description: 'SMS or email follow-up' },
];

export const healthcareWorkflow = {
  title: 'Healthcare',
  accent: 'teal' as AccentKey,
  steps: [
    { icon: <Phone />, label: 'Patient Greeting', description: 'Warm, HIPAA-aware welcome' },
    { icon: <Stethoscope />, label: 'Symptom Assessment', description: 'Guided triage questions' },
    { icon: <CalendarCheck />, label: 'Appointment Booking', description: 'Real-time availability' },
    { icon: <Pill />, label: 'Prescription Handling', description: 'Refill requests captured' },
    { icon: <Smartphone />, label: 'SMS Confirmation', description: 'Appointment details sent' },
  ] as WorkflowStep[],
};

export const legalWorkflow = {
  title: 'Legal',
  accent: 'gold' as AccentKey,
  steps: [
    { icon: <Phone />, label: 'Caller Greeting', description: 'Professional intake start' },
    { icon: <FileText />, label: 'Case Intake', description: 'Nature, dates, key details' },
    { icon: <ShieldCheck />, label: 'Conflict Check', description: 'Automated screening' },
    { icon: <Calendar />, label: 'Attorney Scheduling', description: 'Book consultation' },
    { icon: <Mail />, label: 'Follow-up Confirmation', description: 'Email with next steps' },
  ] as WorkflowStep[],
};

export const realEstateWorkflow = {
  title: 'Real Estate',
  accent: 'green' as AccentKey,
  steps: [
    { icon: <Phone />, label: 'Lead Greeting', description: 'Qualify interest level' },
    { icon: <Home />, label: 'Property Inquiry', description: 'Match preferences' },
    { icon: <CalendarDays />, label: 'Showing Scheduling', description: 'Book property tour' },
    { icon: <Database />, label: 'CRM Update', description: 'Lead record updated' },
    { icon: <BellRing />, label: 'Follow-up Notification', description: 'Agent alerted' },
  ] as WorkflowStep[],
};

export const customerSupportWorkflow = {
  title: 'Customer Support',
  accent: 'blue' as AccentKey,
  steps: [
    { icon: <Headphones />, label: 'Customer Greeting', description: 'Account identified' },
    { icon: <HelpCircle />, label: 'Issue Classification', description: 'Categorize the problem' },
    { icon: <BookOpen />, label: 'Knowledge Base Lookup', description: 'Search for solutions' },
    { icon: <Ticket />, label: 'Ticket Creation', description: 'Track the issue' },
    { icon: <SmilePlus />, label: 'Satisfaction Survey', description: 'Capture feedback' },
  ] as WorkflowStep[],
};

