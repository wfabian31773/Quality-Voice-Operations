import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Stethoscope, Scale, Megaphone, Headphones, Users, Home,
  Phone, Globe, MessageSquare, ArrowRight, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, Bot, Zap, Calendar, Shield,
  Clock, BarChart3, FileText,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';

type Category = 'All' | 'Healthcare' | 'Legal' | 'Sales & Marketing' | 'Operations' | 'Support';

interface AgentTemplate {
  id: string;
  name: string;
  category: Category;
  description: string;
  channels: Array<'phone' | 'web' | 'sms'>;
  capabilities: string[];
  icon: React.ElementType;
  color: string;
  conversationExample: { role: 'caller' | 'agent'; text: string }[];
  workflowSteps: string[];
  toolsUsed: string[];
  escalationBehavior: string;
}

const channelIcons: Record<string, { icon: React.ElementType; label: string }> = {
  phone: { icon: Phone, label: 'Phone' },
  web: { icon: Globe, label: 'Web Chat' },
  sms: { icon: MessageSquare, label: 'SMS' },
};

const categories: Category[] = ['All', 'Healthcare', 'Legal', 'Sales & Marketing', 'Operations', 'Support'];

const categoryIcons: Record<Category, React.ElementType> = {
  All: Bot,
  Healthcare: Stethoscope,
  Legal: Scale,
  'Sales & Marketing': Megaphone,
  Operations: Home,
  Support: Users,
};

const agentTemplates: AgentTemplate[] = [
  {
    id: 'medical-intake',
    name: 'Medical Intake Agent',
    category: 'Healthcare',
    description: 'Handles after-hours patient calls with clinical intake protocols. Triages urgency, schedules appointments, and escalates critical concerns to on-call providers.',
    channels: ['phone', 'web'],
    capabilities: ['Clinical triage', 'Appointment scheduling', 'Prescription refill requests', 'Insurance verification', 'HIPAA-compliant transcription'],
    icon: Stethoscope,
    color: 'bg-teal/10 text-teal border-teal/20',
    conversationExample: [
      { role: 'caller', text: 'Hi, I need to schedule a follow-up appointment with Dr. Chen.' },
      { role: 'agent', text: 'Of course! I can help you schedule that. Could you provide your date of birth so I can pull up your records?' },
      { role: 'caller', text: 'Sure, it\'s March 15, 1985.' },
      { role: 'agent', text: 'Thank you. I see your chart. Dr. Chen has openings this Thursday at 2 PM or Friday at 10 AM. Which works better for you?' },
      { role: 'caller', text: 'Thursday at 2 works.' },
      { role: 'agent', text: 'You\'re confirmed for Thursday at 2 PM with Dr. Chen. You\'ll receive a confirmation text shortly. Is there anything else I can help with?' },
    ],
    workflowSteps: ['Answer call & greet patient', 'Verify identity (DOB/name)', 'Assess intent & urgency', 'Route to scheduling, triage, or refill flow', 'Confirm action & send follow-up'],
    toolsUsed: ['EHR integration', 'Scheduling system', 'SMS notifications', 'Urgency classifier'],
    escalationBehavior: 'Immediately escalates to on-call provider for symptoms indicating emergencies (chest pain, difficulty breathing, severe bleeding). Non-urgent after-hours requests are queued for morning review.',
  },
  {
    id: 'dental-scheduling',
    name: 'Dental Scheduling Agent',
    category: 'Healthcare',
    description: 'Manages dental appointment scheduling, hygiene recall campaigns, and patient communication. Handles overflow calls during peak hours.',
    channels: ['phone', 'sms'],
    capabilities: ['Appointment booking', 'Hygiene recall outreach', 'Insurance pre-authorization', 'Cancellation management', 'New patient intake'],
    icon: Headphones,
    color: 'bg-harbor/10 text-harbor border-harbor/20',
    conversationExample: [
      { role: 'caller', text: 'I need to reschedule my cleaning appointment.' },
      { role: 'agent', text: 'I\'d be happy to help with that. Can I get your name and the date of your current appointment?' },
      { role: 'caller', text: 'It\'s Lisa Martinez, I have something next Tuesday.' },
      { role: 'agent', text: 'I found your appointment for Tuesday at 9 AM. I have Wednesday at 11 AM or Thursday at 3 PM available. Would either work?' },
      { role: 'caller', text: 'Wednesday at 11 is perfect.' },
      { role: 'agent', text: 'Done! Your cleaning is now Wednesday at 11 AM. We\'ll send you a reminder the day before.' },
    ],
    workflowSteps: ['Greet patient & identify account', 'Determine request type', 'Check availability in scheduling system', 'Confirm new appointment details', 'Send SMS confirmation'],
    toolsUsed: ['Practice management system', 'SMS gateway', 'Calendar API', 'Patient database'],
    escalationBehavior: 'Dental emergencies (severe pain, knocked-out tooth, excessive bleeding) are transferred to the on-call dentist. Insurance disputes are queued for billing staff.',
  },
  {
    id: 'legal-intake',
    name: 'Legal Intake Agent',
    category: 'Legal',
    description: 'Conducts structured legal intake conversations 24/7. Captures case details, qualifies leads, and routes to the appropriate practice area attorney.',
    channels: ['phone', 'web', 'sms'],
    capabilities: ['Case intake interviews', 'Lead qualification', 'Conflict checks', 'Statute of limitations alerts', 'Attorney matching'],
    icon: Scale,
    color: 'bg-amber-100/80 text-amber-700 border-amber-200',
    conversationExample: [
      { role: 'caller', text: 'I was in a car accident last week and I think I need a lawyer.' },
      { role: 'agent', text: 'I\'m sorry to hear about your accident. I can help connect you with the right attorney. Can you tell me when and where the accident occurred?' },
      { role: 'caller', text: 'It was last Thursday on Route 9. The other driver ran a red light.' },
      { role: 'agent', text: 'Thank you. Were you injured? And have you received any medical treatment?' },
      { role: 'caller', text: 'Yes, I went to the ER for whiplash and my back has been hurting.' },
      { role: 'agent', text: 'I\'ve noted all of that. This sounds like a personal injury case. I\'m flagging this as high priority and an attorney from our PI team will call you back within 2 hours. Can I confirm your callback number?' },
    ],
    workflowSteps: ['Answer & establish case type', 'Structured intake questions', 'Assess case merit & urgency', 'Run conflict check', 'Assign to practice area & schedule callback'],
    toolsUsed: ['Case management system', 'Conflict database', 'Attorney availability calendar', 'Lead scoring engine'],
    escalationBehavior: 'Time-sensitive matters (upcoming court dates, statute of limitations within 30 days) are immediately escalated to the managing partner. Criminal matters with clients in custody trigger emergency contact protocols.',
  },
  {
    id: 'property-maintenance',
    name: 'Property Maintenance Agent',
    category: 'Operations',
    description: 'Handles tenant maintenance requests, emergency after-hours calls, and vendor coordination for property management companies.',
    channels: ['phone', 'sms'],
    capabilities: ['Maintenance request intake', 'Emergency triage', 'Vendor dispatch', 'Tenant communication', 'Work order tracking'],
    icon: Home,
    color: 'bg-emerald-100/80 text-emerald-700 border-emerald-200',
    conversationExample: [
      { role: 'caller', text: 'There\'s water leaking from the ceiling in my apartment.' },
      { role: 'agent', text: 'I\'m sorry about that — let me help right away. Can you tell me your unit number and the building address?' },
      { role: 'caller', text: 'Unit 4B at 250 Oak Street.' },
      { role: 'agent', text: 'Thank you. Is the water actively flowing, or is it a slow drip? And is it near any electrical fixtures?' },
      { role: 'caller', text: 'It\'s a steady stream, but not near any lights.' },
      { role: 'agent', text: 'I\'m classifying this as urgent and dispatching our emergency plumber now. They should be there within 90 minutes. I\'ll text you their contact info and ETA. In the meantime, if you can place a bucket underneath, that would help.' },
    ],
    workflowSteps: ['Identify tenant & property', 'Classify issue severity', 'Create work order', 'Dispatch vendor if urgent', 'Send tenant confirmation & ETA'],
    toolsUsed: ['Property management platform', 'Vendor dispatch system', 'SMS notifications', 'Work order database'],
    escalationBehavior: 'Life-safety emergencies (gas leak, fire, flooding) trigger immediate 911 guidance and property manager notification. After-hours non-emergencies are queued as standard work orders for next-day dispatch.',
  },
  {
    id: 'outbound-sales',
    name: 'Outbound Sales Agent',
    category: 'Sales & Marketing',
    description: 'Runs automated outbound calling campaigns for lead qualification, appointment setting, and follow-up sequences with answering machine detection.',
    channels: ['phone', 'sms'],
    capabilities: ['Automated dialing', 'Lead qualification', 'Appointment setting', 'Answering machine detection', 'CRM integration'],
    icon: Megaphone,
    color: 'bg-purple-100/80 text-purple-700 border-purple-200',
    conversationExample: [
      { role: 'agent', text: 'Hi, this is Alex calling from Bright Solutions. We spoke briefly at the trade show last week. Do you have a moment?' },
      { role: 'caller', text: 'Oh yes, I remember. We were interested in your scheduling product.' },
      { role: 'agent', text: 'Great! I\'d love to set up a 15-minute demo with our product team. Would this Thursday or Friday afternoon work for you?' },
      { role: 'caller', text: 'Friday at 2 PM would be good.' },
      { role: 'agent', text: 'Perfect — I\'ll send a calendar invite to your email on file. Before that, could you tell me how many locations you\'re currently managing?' },
      { role: 'caller', text: 'We have about 12 offices across the state.' },
      { role: 'agent', text: 'That\'s helpful context for our team. You\'re all set for Friday at 2 PM. You\'ll get a confirmation email shortly. Thanks for your time!' },
    ],
    workflowSteps: ['Dial from campaign list', 'Detect answering machine vs. live pickup', 'Deliver personalized pitch', 'Qualify interest & gather info', 'Book meeting or schedule follow-up'],
    toolsUsed: ['Campaign dialer', 'CRM integration', 'Calendar booking', 'AMD detection', 'Lead scoring'],
    escalationBehavior: 'High-value leads (enterprise tier, 10+ locations) are immediately warm-transferred to a senior sales rep. Do-not-call requests are logged and the number is added to the suppression list.',
  },
  {
    id: 'customer-support',
    name: 'Customer Support Agent',
    category: 'Support',
    description: 'Provides first-line customer support for common inquiries, troubleshooting, and ticket creation. Handles high call volumes with consistent quality.',
    channels: ['phone', 'web', 'sms'],
    capabilities: ['FAQ handling', 'Ticket creation', 'Account lookup', 'Basic troubleshooting', 'Satisfaction surveys'],
    icon: Users,
    color: 'bg-blue-100/80 text-blue-700 border-blue-200',
    conversationExample: [
      { role: 'caller', text: 'I\'m having trouble logging into my account.' },
      { role: 'agent', text: 'I can help with that. Could you provide the email address associated with your account?' },
      { role: 'caller', text: 'It\'s john@example.com.' },
      { role: 'agent', text: 'I found your account. It looks like your password was reset recently. I\'ve just sent a new password reset link to your email. You should receive it within a minute.' },
      { role: 'caller', text: 'Got it, thanks!' },
      { role: 'agent', text: 'You\'re welcome! If you have any other issues after resetting, don\'t hesitate to call back. Have a great day!' },
    ],
    workflowSteps: ['Greet & identify customer', 'Classify issue category', 'Attempt resolution from knowledge base', 'Create ticket if unresolved', 'Collect satisfaction feedback'],
    toolsUsed: ['Knowledge base', 'Ticketing system', 'CRM lookup', 'SMS notifications', 'CSAT survey'],
    escalationBehavior: 'Issues unresolved after two troubleshooting attempts are escalated to a human agent with full context. VIP customers are immediately routed to senior support.',
  },
  {
    id: 'insurance-verification',
    name: 'Insurance Verification Agent',
    category: 'Healthcare',
    description: 'Automates insurance eligibility checks, benefits verification, and prior authorization follow-ups for medical and dental practices.',
    channels: ['phone', 'web'],
    capabilities: ['Eligibility verification', 'Benefits breakdown', 'Prior auth tracking', 'Patient cost estimates', 'Payer communication'],
    icon: Shield,
    color: 'bg-teal/10 text-teal border-teal/20',
    conversationExample: [
      { role: 'caller', text: 'I need to check if my insurance covers an MRI.' },
      { role: 'agent', text: 'I can look into that for you. May I have your insurance provider and member ID number?' },
      { role: 'caller', text: 'Blue Cross, member ID BX-445521.' },
      { role: 'agent', text: 'Thank you. I\'m checking your benefits now. Your plan covers diagnostic MRIs at 80% after your deductible. Your remaining deductible is $350. Would you like me to provide a cost estimate for your visit?' },
    ],
    workflowSteps: ['Collect patient & insurance info', 'Query payer eligibility system', 'Determine coverage & cost share', 'Communicate results to patient', 'Log verification in EHR'],
    toolsUsed: ['Payer portal integration', 'EHR system', 'Benefits calculator', 'Patient communication'],
    escalationBehavior: 'Denied prior authorizations are escalated to the billing team with denial reason codes. Patients with lapsed coverage are connected to the financial counselor.',
  },
  {
    id: 'appointment-reminder',
    name: 'Appointment Reminder Agent',
    category: 'Operations',
    description: 'Proactively contacts patients and clients to confirm upcoming appointments, handle rescheduling, and reduce no-show rates.',
    channels: ['phone', 'sms'],
    capabilities: ['Automated reminders', 'Confirmation collection', 'Rescheduling', 'Waitlist management', 'No-show follow-up'],
    icon: Calendar,
    color: 'bg-emerald-100/80 text-emerald-700 border-emerald-200',
    conversationExample: [
      { role: 'agent', text: 'Hi, this is a reminder from Westside Medical. You have an appointment with Dr. Patel tomorrow at 10:30 AM. Can you confirm you\'ll be there?' },
      { role: 'caller', text: 'Actually, I need to push it back. Can I come in the afternoon instead?' },
      { role: 'agent', text: 'Of course. Dr. Patel has 2:15 PM and 3:45 PM available tomorrow afternoon. Which would you prefer?' },
      { role: 'caller', text: '2:15 works.' },
      { role: 'agent', text: 'You\'re rescheduled for 2:15 PM tomorrow with Dr. Patel. We\'ll send a confirmation text. See you then!' },
    ],
    workflowSteps: ['Pull upcoming appointments', 'Contact patient via preferred channel', 'Collect confirmation or reschedule', 'Update calendar system', 'Backfill cancelled slots from waitlist'],
    toolsUsed: ['Scheduling system', 'SMS gateway', 'Outbound dialer', 'Waitlist manager'],
    escalationBehavior: 'Patients who miss multiple appointments are flagged for office manager review. Same-day cancellations trigger waitlist backfill automation.',
  },
];

function ChannelBadge({ channel }: { channel: string }) {
  const info = channelIcons[channel];
  if (!info) return null;
  const Icon = info.icon;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-white/80 text-slate-ink/70 rounded border border-steel/30">
      <Icon className="h-3 w-3" />
      {info.label}
    </span>
  );
}

function AgentCard({ agent }: { agent: AgentTemplate }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = agent.icon;

  return (
    <div className="bg-white rounded-xl border border-steel/30 shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden">
      <div className="p-6">
        <div className="flex items-start gap-4 mb-4">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${agent.color}`}>
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <h3 className="font-display text-lg font-bold text-harbor mb-1">{agent.name}</h3>
            <span className="text-xs font-medium text-teal uppercase tracking-wide">{agent.category}</span>
          </div>
        </div>

        <p className="text-sm text-slate-ink/70 leading-relaxed mb-4">{agent.description}</p>

        <div className="flex flex-wrap gap-1.5 mb-4">
          {agent.channels.map((ch) => (
            <ChannelBadge key={ch} channel={ch} />
          ))}
        </div>

        <div className="space-y-1.5 mb-5">
          {agent.capabilities.slice(0, 4).map((cap) => (
            <div key={cap} className="flex items-center gap-2 text-sm text-slate-ink/80">
              <CheckCircle2 className="h-3.5 w-3.5 text-calm-green shrink-0" />
              {cap}
            </div>
          ))}
          {agent.capabilities.length > 4 && (
            <p className="text-xs text-soft-steel ml-5.5">+{agent.capabilities.length - 4} more</p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Link
            to={`/signup?agent=${agent.id}`}
            className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-hover text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            Deploy This Agent
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <button
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 text-sm font-medium text-harbor hover:text-teal transition-colors px-2 py-2"
          >
            {expanded ? 'Less detail' : 'More detail'}
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-steel/20 bg-mist/50 px-6 py-5 space-y-5">
          <div>
            <h4 className="font-display text-sm font-semibold text-harbor mb-3 flex items-center gap-1.5">
              <MessageSquare className="h-4 w-4 text-teal" />
              Example Conversation
            </h4>
            <div className="space-y-2.5 bg-white rounded-lg border border-steel/20 p-4">
              {agent.conversationExample.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'agent' ? 'justify-start' : 'justify-end'}`}>
                  <div
                    className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                      msg.role === 'agent'
                        ? 'bg-teal/10 text-harbor border border-teal/20'
                        : 'bg-harbor/10 text-harbor border border-harbor/20'
                    }`}
                  >
                    <span className="block text-[10px] font-semibold uppercase tracking-wider mb-0.5 opacity-60">
                      {msg.role === 'agent' ? 'AI Agent' : 'Caller'}
                    </span>
                    {msg.text}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="font-display text-sm font-semibold text-harbor mb-3 flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-teal" />
              Workflow Steps
            </h4>
            <ol className="space-y-1.5">
              {agent.workflowSteps.map((step, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm text-slate-ink/80">
                  <span className="w-5 h-5 rounded-full bg-teal/10 text-teal text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <h4 className="font-display text-sm font-semibold text-harbor mb-2 flex items-center gap-1.5">
                <Bot className="h-4 w-4 text-teal" />
                Tools Used
              </h4>
              <ul className="space-y-1">
                {agent.toolsUsed.map((tool) => (
                  <li key={tool} className="text-sm text-slate-ink/70 flex items-center gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-teal shrink-0" />
                    {tool}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="font-display text-sm font-semibold text-harbor mb-2 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Escalation Behavior
              </h4>
              <p className="text-sm text-slate-ink/70 leading-relaxed">{agent.escalationBehavior}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AgentsShowcase() {
  const [activeCategory, setActiveCategory] = useState<Category>('All');

  const filtered = activeCategory === 'All'
    ? agentTemplates
    : agentTemplates.filter((a) => a.category === activeCategory);

  return (
    <div>
      <SEO
        title="AI Voice Agents — Pre-Built Templates for Every Industry"
        description="Browse QVO's library of pre-built AI voice agent templates for healthcare, legal, sales, support, and operations. Customize and deploy in minutes."
        canonicalPath="/agents"
      />
      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Agent Marketplace
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Industry-ready AI voice agents, deploy in minutes.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed mb-8 font-body">
              Browse our library of pre-built voice agents designed for specific industries. Each template is ready to handle calls, schedule appointments, qualify leads, and escalate when needed.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
              >
                Start Free Trial
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 border border-white/25 hover:bg-white/10 text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
              >
                Try Live Demo
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex flex-wrap gap-2 mb-10">
            {categories.map((cat) => {
              const CatIcon = categoryIcons[cat];
              return (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    activeCategory === cat
                      ? 'bg-harbor text-white shadow-sm'
                      : 'bg-white text-slate-ink/70 border border-steel/30 hover:border-harbor/40 hover:text-harbor'
                  }`}
                >
                  <CatIcon className="h-4 w-4" />
                  {cat}
                </button>
              );
            })}
          </div>

          <RevealSection>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {filtered.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
          </RevealSection>

          {filtered.length === 0 && (
            <div className="text-center py-16">
              <Bot className="h-12 w-12 text-soft-steel mx-auto mb-4" />
              <p className="text-slate-ink/60 font-body">No agents found in this category.</p>
            </div>
          )}
        </div>
      </section>

      <section className="bg-harbor text-white py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-3xl lg:text-4xl font-bold mb-4">
            Ready to deploy your first agent?
          </h2>
          <p className="text-lg text-white/70 mb-8 max-w-2xl mx-auto font-body">
            Start with a 14-day free trial. Pick a template, customize it for your business, and go live in minutes.
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <Link
              to="/signup"
              className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-8 py-3.5 rounded-lg transition-colors text-sm"
            >
              Start Free Trial
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/pricing"
              className="inline-flex items-center justify-center gap-2 border border-white/25 hover:bg-white/10 text-white font-semibold px-8 py-3.5 rounded-lg transition-colors text-sm"
            >
              View Pricing
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
