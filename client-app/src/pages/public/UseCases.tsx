import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import {
  Wrench, Calendar, Moon, ClipboardList, Target,
  ArrowRight, CheckCircle2, Phone, Truck, MessageSquare,
  Clock, Users, BarChart3,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackVerticalEngagement, trackCTAClick } from '../../lib/analytics';

const scenarios = [
  {
    icon: Wrench,
    title: 'HVAC Service Dispatch',
    subtitle: 'Emergency triage, technician dispatch, and real-time ETAs',
    problem: 'After-hours HVAC emergencies go to voicemail. Dispatchers manually coordinate technicians with no visibility into availability. Customers wait hours with no updates.',
    solution: 'QVO answers every service call 24/7, triages emergencies (gas leaks, no-heat, no-AC), and dispatches the nearest available technician automatically. Customers get SMS updates with real-time ETAs.',
    workflow: [
      'Caller describes the issue — AI captures location, equipment, and symptoms',
      'Urgency classifier flags safety risks (gas leak, carbon monoxide)',
      'Dispatch system assigns nearest available technician by skill and geography',
      'SMS sent to customer with technician name and live ETA',
      'Service ticket created with full call transcript and issue details',
    ],
    tools: ['Technician dispatch', 'SMS gateway', 'Service ticket system', 'Scheduling calendar', 'GPS routing'],
    metrics: [
      { icon: Clock, label: 'Response time', value: '< 30 seconds' },
      { icon: Truck, label: 'Dispatch speed', value: '5 min avg' },
      { icon: Phone, label: 'Calls captured', value: '100%' },
    ],
  },
  {
    icon: Calendar,
    title: 'Appointment Scheduling',
    subtitle: 'Book, reschedule, and confirm appointments during the call',
    problem: 'Front desk staff juggle scheduling with check-ins, leading to missed calls and booking errors. Patients and clients wait on hold or call back later — and often don\'t.',
    solution: 'QVO handles appointment scheduling entirely within the call. It checks real-time availability, books the appointment, sends a confirmation SMS, and logs everything in your calendar system.',
    workflow: [
      'Caller requests an appointment — AI identifies the provider or service type',
      'Real-time availability checked against calendar system',
      'Appointment booked with confirmation details read back to caller',
      'SMS confirmation sent with date, time, location, and prep instructions',
      'Calendar system updated and reminder sequence triggered',
    ],
    tools: ['Calendar API', 'Practice management system', 'SMS confirmations', 'Reminder scheduler', 'Patient database'],
    metrics: [
      { icon: Calendar, label: 'Booking rate', value: '94%' },
      { icon: MessageSquare, label: 'SMS confirmations', value: 'Instant' },
      { icon: Users, label: 'No-show reduction', value: '35%' },
    ],
  },
  {
    icon: Moon,
    title: 'After-Hours Answering',
    subtitle: '24/7 professional call handling when your office is closed',
    problem: '67% of callers won\'t leave a voicemail. After-hours calls to competitors mean lost patients, lost clients, and lost revenue. Overnight answering services lack context about your business.',
    solution: 'QVO answers after-hours calls with the same quality and knowledge as your best receptionist. It handles scheduling, FAQs, urgency triage, and escalation — all with full business context from your knowledge base.',
    workflow: [
      'Call answered with professional greeting customized to your business',
      'AI identifies caller intent using natural language understanding',
      'Routine requests handled immediately (scheduling, FAQs, directions)',
      'Urgent matters escalated to on-call staff with full context via SMS',
      'Complete call summary and transcript ready for morning review',
    ],
    tools: ['Knowledge base', 'On-call roster', 'SMS escalation', 'Call transcript system', 'Scheduling API'],
    metrics: [
      { icon: Moon, label: 'Coverage', value: '24/7/365' },
      { icon: Phone, label: 'Answer rate', value: '100%' },
      { icon: BarChart3, label: 'Resolution rate', value: '87%' },
    ],
  },
  {
    icon: ClipboardList,
    title: 'Customer Intake',
    subtitle: 'Structured intake conversations that capture every detail',
    problem: 'Intake forms are incomplete because details are lost between calls. Staff spend time on repetitive questions instead of higher-value work. No standardization across intake calls.',
    solution: 'QVO conducts structured intake conversations that capture all required information in a single call. Every question is asked, every answer is recorded, and the complete intake record flows into your system automatically.',
    workflow: [
      'Caller identified and matched to existing records (or new record created)',
      'Structured intake interview conducted with required fields',
      'Information validated and confirmed with caller',
      'Intake record created in case management or EHR system',
      'Follow-up tasks assigned to the appropriate team member',
    ],
    tools: ['Case management system', 'EHR integration', 'Patient database', 'Document generation', 'Task assignment'],
    metrics: [
      { icon: ClipboardList, label: 'Data completeness', value: '98%' },
      { icon: Clock, label: 'Intake time', value: '4 min avg' },
      { icon: Users, label: 'Staff time saved', value: '60%' },
    ],
  },
  {
    icon: Target,
    title: 'Lead Qualification',
    subtitle: 'Score and route inbound leads in real time',
    problem: 'Leads contacted after 5 minutes are 10x less likely to convert. Sales teams spend hours on unqualified leads. After-hours inquiries sit until morning while competitors respond instantly.',
    solution: 'QVO qualifies every inbound lead in real time — capturing contact info, budget, timeline, and needs. High-value leads are warm-transferred or flagged for immediate callback. Every lead gets a professional first impression.',
    workflow: [
      'Inbound call or inquiry answered immediately',
      'AI conducts qualifying questions (budget, timeline, decision-maker)',
      'Lead scored based on configurable criteria',
      'High-priority leads warm-transferred or flagged for urgent callback',
      'Lead record synced to CRM with full conversation context',
    ],
    tools: ['Lead scoring engine', 'CRM integration', 'SMS follow-up', 'Calendar booking', 'Call transfer system'],
    metrics: [
      { icon: Target, label: 'Qualification rate', value: '92%' },
      { icon: Clock, label: 'Response time', value: '< 10 sec' },
      { icon: BarChart3, label: 'Conversion lift', value: '2x' },
    ],
  },
];

export default function UseCases() {
  useEffect(() => {
    trackPageView('/use-cases');
  }, []);

  return (
    <div>
      <SEO
        title="Use Cases — AI Voice Agent Scenarios for Every Business"
        description="See how businesses use QVO AI voice agents for HVAC service dispatch, appointment scheduling, after-hours answering, customer intake, and lead qualification."
        canonicalPath="/use-cases"
      />
      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Use Cases
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Real-world scenarios, solved by AI voice agents.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              Five common business scenarios where QVO replaces manual processes with intelligent, automated voice handling — from emergency dispatch to lead qualification.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/25"
                onClick={() => trackCTAClick('Try Live Demo', '/use-cases', 'hero')}
              >
                Try Live Demo
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/agents"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Explore Agents', '/use-cases', 'hero')}
              >
                Explore Agents
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 space-y-16">
          {scenarios.map((s) => (
            <RevealSection key={s.title}>
              <div
                className="bg-white rounded-2xl border border-soft-steel/50 overflow-hidden"
                onMouseEnter={() => trackVerticalEngagement(s.title, 'view')}
              >
                <div className="p-8 lg:p-10">
                  <div className="flex items-start gap-4 mb-8">
                    <div className="w-12 h-12 rounded-xl bg-teal/10 flex items-center justify-center shrink-0">
                      <s.icon className="h-6 w-6 text-teal" />
                    </div>
                    <div>
                      <h3 className="font-display text-2xl font-bold text-harbor">{s.title}</h3>
                      <p className="text-sm text-slate-ink/50 font-body mt-1">{s.subtitle}</p>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-8 mb-8">
                    <div>
                      <h4 className="font-display text-sm font-semibold text-controlled-red uppercase tracking-wide mb-4">
                        The Problem
                      </h4>
                      <p className="text-sm text-slate-ink/70 font-body leading-relaxed">{s.problem}</p>
                    </div>
                    <div>
                      <h4 className="font-display text-sm font-semibold text-calm-green uppercase tracking-wide mb-4">
                        How QVO Solves It
                      </h4>
                      <p className="text-sm text-slate-ink/70 font-body leading-relaxed">{s.solution}</p>
                    </div>
                  </div>

                  <div className="bg-mist/50 rounded-xl p-6 mb-8">
                    <h4 className="font-display text-sm font-semibold text-harbor mb-4">Workflow</h4>
                    <ol className="space-y-2">
                      {s.workflow.map((step, i) => (
                        <li key={i} className="flex items-start gap-3 text-sm text-slate-ink/70 font-body">
                          <span className="w-5 h-5 rounded-full bg-teal/10 text-teal text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                            {i + 1}
                          </span>
                          {step}
                        </li>
                      ))}
                    </ol>
                  </div>

                  <div className="grid md:grid-cols-2 gap-8">
                    <div>
                      <h4 className="font-display text-sm font-semibold text-harbor mb-3">Tools Used</h4>
                      <div className="flex flex-wrap gap-2">
                        {s.tools.map((tool) => (
                          <span key={tool} className="text-xs font-medium bg-teal/5 text-teal border border-teal/15 px-3 py-1.5 rounded-full">
                            {tool}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h4 className="font-display text-sm font-semibold text-harbor mb-3">Key Metrics</h4>
                      <div className="grid grid-cols-3 gap-3">
                        {s.metrics.map((m) => (
                          <div key={m.label} className="text-center">
                            <m.icon className="h-4 w-4 text-teal mx-auto mb-1" />
                            <p className="font-display text-lg font-bold text-harbor">{m.value}</p>
                            <p className="text-[11px] text-slate-ink/50 font-body">{m.label}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </RevealSection>
          ))}
        </div>
      </section>

      <section className="py-16 lg:py-20 bg-mist">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <RevealSection>
            <h2 className="font-display text-2xl lg:text-3xl font-bold text-harbor mb-4">
              See these scenarios in action
            </h2>
            <p className="text-slate-ink/60 font-body mb-8 max-w-2xl mx-auto">
              Try our interactive demo to experience how QVO handles real conversations across industries. No signup required.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/demo"
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-8 py-3.5 rounded-xl text-sm transition-colors shadow-lg shadow-teal/20"
                onClick={() => trackCTAClick('Try the Demo', '/use-cases', 'mid-cta')}
              >
                Try the Demo
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/features"
                className="inline-flex items-center gap-2 bg-white border border-soft-steel/50 hover:border-teal/30 text-harbor font-semibold px-8 py-3.5 rounded-xl text-sm transition-colors"
                onClick={() => trackCTAClick('Explore Features', '/use-cases', 'mid-cta')}
              >
                Explore Features
              </Link>
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="bg-harbor text-white py-16">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold mb-4">
            Don't see your use case?
          </h2>
          <p className="text-white/60 font-body mb-8">
            QVO's agent platform is fully configurable. Contact us to discuss your specific scenario.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/contact"
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
              onClick={() => trackCTAClick('Talk to Us', '/use-cases', 'bottom-cta')}
            >
              Talk to us
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/signup"
              className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
              onClick={() => trackCTAClick('Start Free Trial', '/use-cases', 'bottom-cta')}
            >
              Start Free Trial
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
