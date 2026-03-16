import { Link } from 'react-router-dom';
import {
  Stethoscope, Headphones, Scale, Home, Users, Megaphone,
  ArrowRight, CheckCircle2, Wrench,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';

const verticals = [
  {
    icon: Stethoscope,
    title: 'Medical practices',
    subtitle: 'After-hours triage and appointment scheduling',
    pains: [
      'Patients calling after hours reach voicemail and don\'t leave messages',
      'Urgent concerns aren\'t escalated until the next business day',
      'Staff spend mornings returning calls instead of seeing patients',
    ],
    solutions: [
      'AI agent answers after-hours calls with clinical intake protocols',
      'Urgency-based triage routes critical calls to on-call providers immediately',
      'Appointments are booked during the call, reducing morning callback volume',
      'Full transcripts and call recordings for compliance and continuity',
    ],
  },
  {
    icon: Headphones,
    title: 'Dental offices',
    subtitle: 'Patient scheduling and recall campaigns',
    pains: [
      'Missed calls during peak hours mean lost new-patient appointments',
      'Recall and hygiene reminders require manual phone outreach',
      'Front desk can\'t handle scheduling and check-in simultaneously',
    ],
    solutions: [
      'AI agent handles overflow calls and after-hours scheduling',
      'Outbound campaigns automate recall, reactivation, and appointment reminders',
      'Patients can reschedule or confirm without waiting on hold',
      'Dashboard shows booking rates, missed calls, and campaign performance',
    ],
  },
  {
    icon: Scale,
    title: 'Legal firms',
    subtitle: 'Client intake and lead qualification',
    pains: [
      'Potential clients call outside business hours and move to a competitor',
      'Intake forms are incomplete because details are lost between calls',
      'No visibility into how many leads were captured versus lost',
    ],
    solutions: [
      'AI agent conducts structured legal intake conversations 24/7',
      'Case details, contact info, and urgency are captured in every call',
      'Qualified leads are flagged and escalated to the right attorney',
      'Analytics show intake conversion rates and lead response times',
    ],
  },
  {
    icon: Home,
    title: 'Property management',
    subtitle: 'Maintenance requests and tenant communication',
    pains: [
      'Tenants report emergencies after hours with no structured response',
      'Maintenance requests are lost in voicemail or text messages',
      'Property managers lack visibility into communication volume',
    ],
    solutions: [
      'AI agent captures maintenance requests with urgency classification',
      'Emergency calls are escalated immediately to on-call maintenance staff',
      'All requests are logged with timestamps, details, and follow-up status',
      'Multi-property dashboards show request volume and response metrics',
    ],
  },
  {
    icon: Users,
    title: 'Customer support',
    subtitle: 'Tier-1 support and ticket creation',
    pains: [
      'Support teams are overwhelmed during peak hours',
      'Simple inquiries tie up agents who should handle complex issues',
      'After-hours coverage requires expensive overnight staffing',
    ],
    solutions: [
      'AI agent resolves common inquiries and creates tickets for complex issues',
      'Smart routing directs calls to the right department or escalation path',
      'After-hours coverage without additional staffing costs',
      'Quality scoring ensures consistent service delivery',
    ],
  },
  {
    icon: Megaphone,
    title: 'Outbound sales',
    subtitle: 'Lead outreach and appointment setting',
    pains: [
      'Sales reps spend hours on manual dialing with low connect rates',
      'No systematic follow-up process for missed connections',
      'Lack of data on outreach effectiveness and conversion rates',
    ],
    solutions: [
      'Automated campaign dialing with answering machine detection',
      'AI agent qualifies leads and schedules follow-up appointments',
      'Configurable retry logic ensures persistent but respectful outreach',
      'Campaign analytics track connect rates, outcomes, and ROI',
    ],
  },
  {
    icon: Wrench,
    title: 'HVAC & home services',
    subtitle: 'Service calls, dispatch, and emergency triage',
    pains: [
      'After-hours emergency calls go unanswered or to generic voicemail',
      'Dispatchers manually coordinate technicians with no visibility into availability',
      'Customers are left waiting with no ETA or status updates',
    ],
    solutions: [
      'AI agent answers service calls 24/7 and captures issue details',
      'Emergency triage identifies gas leaks, no-heat, and safety risks instantly',
      'Technician dispatch with real-time availability and automated SMS ETAs',
      'Service tickets are created automatically with full call context',
    ],
  },
];

export default function UseCases() {
  return (
    <div>
      <SEO
        title="Use Cases — AI Voice Agents by Industry"
        description="See how medical, dental, legal, property management, and service businesses use QVO's AI voice agents to handle calls, reduce no-shows, and grow revenue."
        canonicalPath="/use-cases"
      />
      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Use Cases
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Built for the industries that depend on every call.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              QVO comes with preconfigured agent templates for the verticals where missed calls mean lost revenue, missed patients, or unresolved emergencies.
            </p>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 space-y-16">
          {verticals.map((v, idx) => (
            <RevealSection key={v.title}>
            <div
              className="bg-white rounded-2xl border border-soft-steel/50 overflow-hidden"
            >
              <div className="p-8 lg:p-10">
                <div className="flex items-start gap-4 mb-8">
                  <div className="w-12 h-12 rounded-xl bg-teal/10 flex items-center justify-center shrink-0">
                    <v.icon className="h-6 w-6 text-teal" />
                  </div>
                  <div>
                    <h3 className="font-display text-2xl font-bold text-harbor">{v.title}</h3>
                    <p className="text-sm text-slate-ink/50 font-body mt-1">{v.subtitle}</p>
                  </div>
                </div>
                <div className="grid md:grid-cols-2 gap-8">
                  <div>
                    <h4 className="font-display text-sm font-semibold text-controlled-red uppercase tracking-wide mb-4">
                      The problem
                    </h4>
                    <ul className="space-y-3">
                      {v.pains.map((p) => (
                        <li key={p} className="text-sm text-slate-ink/70 font-body leading-relaxed pl-4 border-l-2 border-controlled-red/30">
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4 className="font-display text-sm font-semibold text-calm-green uppercase tracking-wide mb-4">
                      How QVO helps
                    </h4>
                    <ul className="space-y-3">
                      {v.solutions.map((s) => (
                        <li key={s} className="flex items-start gap-2.5 text-sm text-slate-ink/70 font-body leading-relaxed">
                          <CheckCircle2 className="h-4 w-4 text-calm-green shrink-0 mt-0.5" />
                          {s}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
            </RevealSection>
          ))}
        </div>
      </section>

      <section className="bg-harbor text-white py-16">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold mb-4">
            Don't see your industry?
          </h2>
          <p className="text-white/60 font-body mb-8">
            QVO's agent platform is fully configurable. Contact us to discuss your specific use case.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/contact"
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
            >
              Talk to us
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/signup"
              className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
            >
              Start free trial
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
