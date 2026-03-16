import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import {
  Phone, Clock, Calendar, BarChart3, Shield, ArrowRight,
  Zap, GitBranch, Layers, Bot, Bell, FileText,
  Settings, PhoneCall, Rocket, ChevronRight,
  LayoutDashboard, Activity, Sliders,
  Lock, Eye, Database, ShieldCheck,
  Plug, Link2,
} from 'lucide-react';

const capabilities = [
  {
    icon: Bot,
    title: 'AI voice agents',
    desc: 'Purpose-built voice agents that answer calls, collect information, and handle conversations with natural language understanding. Configurable per industry template.',
  },
  {
    icon: Phone,
    title: 'Real-time call handling',
    desc: 'Calls are answered immediately, 24/7. The AI agent engages callers in natural conversation, captures details, and routes based on your rules.',
  },
  {
    icon: GitBranch,
    title: 'Smart routing and escalation',
    desc: 'Define routing rules based on caller intent, urgency, time of day, or department. Escalate to on-call staff when the situation demands it.',
  },
  {
    icon: Calendar,
    title: 'Scheduling and intake',
    desc: 'Book appointments, collect patient intake information, and confirm details — all within the call flow. Integrates with your existing scheduling systems.',
  },
  {
    icon: Zap,
    title: 'Campaign dialing',
    desc: 'Run outbound campaigns to reach patients, clients, or leads. Automated dialing with answering machine detection and outcome classification.',
  },
  {
    icon: BarChart3,
    title: 'Operational analytics',
    desc: 'Real-time dashboards showing call volume, conversion rates, cost per call, agent performance, and campaign success metrics.',
  },
  {
    icon: Shield,
    title: 'Quality assurance',
    desc: 'Every call is scored for quality. Review transcripts, track prompt versions, and continuously improve agent performance.',
  },
  {
    icon: Bell,
    title: 'Alerts and notifications',
    desc: 'Get notified about missed calls, urgent escalations, and system events via SMS, email, or webhook integrations.',
  },
  {
    icon: Layers,
    title: 'Multi-tenant architecture',
    desc: 'Manage multiple locations, teams, or client organizations from one platform. Full isolation between tenants with role-based access control.',
  },
  {
    icon: FileText,
    title: 'Transcripts and recordings',
    desc: 'Full conversation transcripts and call recordings for compliance, training, and operational review. PHI redaction built in.',
  },
  {
    icon: Clock,
    title: 'After-hours coverage',
    desc: 'Your voice operations never sleep. Calls are handled with the same quality at 2 AM as they are at 2 PM.',
  },
  {
    icon: Phone,
    title: 'Number management',
    desc: 'Provision local or toll-free numbers, assign them to agents, and configure routing — all from the dashboard.',
  },
];

const setupSteps = [
  {
    step: 1,
    icon: Settings,
    title: 'Configure Agent',
    desc: 'Choose an industry template, customize the voice and prompts, and set your routing rules.',
    details: ['Select from healthcare, legal, or custom templates', 'Tune voice personality and tone', 'Define escalation triggers'],
  },
  {
    step: 2,
    icon: PhoneCall,
    title: 'Connect Number',
    desc: 'Provision a number or bring your own. Assign it to your agent and set call handling preferences.',
    details: ['Provision local or toll-free numbers instantly', 'Port existing numbers seamlessly', 'Configure after-hours and overflow rules'],
  },
  {
    step: 3,
    icon: Rocket,
    title: 'Go Live',
    desc: 'Start taking calls. Monitor performance, review transcripts, and refine your agent over time.',
    details: ['Real-time call monitoring dashboard', 'Automated quality scoring from day one', 'Continuous improvement with prompt versioning'],
  },
];

const dashboardScreenshots = [
  {
    icon: LayoutDashboard,
    title: 'Call History',
    desc: 'Complete log of every call with transcripts, outcomes, and quality scores.',
    gradient: 'from-teal/20 to-teal/5',
  },
  {
    icon: Activity,
    title: 'Analytics Dashboard',
    desc: 'Real-time metrics on call volume, conversion rates, and agent performance.',
    gradient: 'from-calm-green/20 to-calm-green/5',
  },
  {
    icon: Sliders,
    title: 'Agent Configuration',
    desc: 'Visual editor for prompts, routing rules, and voice personality settings.',
    gradient: 'from-warm-amber/20 to-warm-amber/5',
  },
];

const securityBadges = [
  { icon: ShieldCheck, title: 'HIPAA Ready', desc: 'Built for healthcare compliance with BAA support and PHI safeguards.' },
  { icon: Eye, title: 'PHI Redaction', desc: 'Automatic detection and redaction of protected health information in transcripts.' },
  { icon: Lock, title: 'Row-Level Security', desc: 'Tenant data isolation enforced at the database level with RLS policies.' },
  { icon: Database, title: 'Encryption at Rest', desc: 'All data encrypted at rest and in transit using industry-standard AES-256.' },
];

const integrations = [
  'EHR Systems', 'Google Calendar', 'Salesforce', 'HubSpot', 'Slack', 'Webhooks', 'Zapier', 'Custom API',
];

function WorkflowSection() {
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) return;
    const interval = setInterval(() => {
      setActiveStep((prev) => (prev + 1) % 3);
    }, 3500);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="bg-white py-20 lg:py-28 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="max-w-3xl mx-auto text-center mb-16">
          <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
            How it works
          </p>
          <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
            Live in three steps.
          </h2>
          <p className="text-slate-ink/60 font-body leading-relaxed">
            From sign-up to your first answered call in under 15 minutes.
          </p>
        </div>

        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-3 gap-0 relative">
            <div className="hidden md:block absolute top-12 left-[20%] right-[20%] h-0.5">
              <div className="w-full h-full bg-soft-steel/30 rounded-full" />
              <div
                className="absolute top-0 left-0 h-full bg-teal rounded-full transition-all duration-700 ease-out"
                style={{ width: `${activeStep * 50}%` }}
              />
            </div>

            {setupSteps.map((s, i) => {
              const isActive = i === activeStep;
              const isComplete = i < activeStep;
              return (
                <button
                  key={s.step}
                  type="button"
                  aria-label={`Step ${s.step}: ${s.title}`}
                  className="relative flex flex-col items-center text-center px-6 cursor-pointer group focus:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 rounded-xl"
                  onClick={() => setActiveStep(i)}
                >
                  <div
                    className={`relative z-10 w-24 h-24 rounded-2xl flex items-center justify-center mb-6 transition-all duration-500 ${
                      isActive
                        ? 'bg-teal text-white shadow-lg shadow-teal/25 scale-110'
                        : isComplete
                          ? 'bg-teal/15 text-teal'
                          : 'bg-mist text-slate-ink/40 group-hover:bg-teal/10 group-hover:text-teal/60'
                    }`}
                  >
                    <s.icon className={`transition-all duration-500 ${isActive ? 'h-10 w-10' : 'h-8 w-8'}`} />
                    <span
                      className={`absolute -top-2 -right-2 w-7 h-7 rounded-full font-display text-xs font-bold flex items-center justify-center transition-all duration-500 ${
                        isActive || isComplete
                          ? 'bg-teal text-white'
                          : 'bg-soft-steel/50 text-slate-ink/50'
                      }`}
                    >
                      {s.step}
                    </span>
                  </div>
                  <h3
                    className={`font-display text-lg font-semibold mb-2 transition-colors duration-300 ${
                      isActive ? 'text-teal' : 'text-harbor'
                    }`}
                  >
                    {s.title}
                  </h3>
                  <p className="text-sm text-slate-ink/60 font-body leading-relaxed mb-4">{s.desc}</p>
                  <ul
                    className={`space-y-1.5 transition-all duration-500 overflow-hidden ${
                      isActive ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'
                    }`}
                  >
                    {s.details.map((d) => (
                      <li key={d} className="flex items-center gap-2 text-xs text-slate-ink/50 font-body">
                        <ChevronRight className="h-3 w-3 text-teal flex-shrink-0" />
                        {d}
                      </li>
                    ))}
                  </ul>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function ScreenshotsSection() {
  return (
    <section className="py-20 lg:py-28 bg-mist">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="max-w-3xl mx-auto text-center mb-14">
          <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
            See it in action
          </p>
          <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
            Your voice operations command center.
          </h2>
          <p className="text-slate-ink/60 font-body leading-relaxed">
            Every call, every outcome, every metric — visible from one dashboard.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {dashboardScreenshots.map((s) => (
            <div key={s.title} className="group">
              <div
                className={`bg-gradient-to-br ${s.gradient} rounded-2xl border border-soft-steel/30 aspect-[4/3] flex items-center justify-center mb-4 transition-all duration-300 group-hover:shadow-lg group-hover:scale-[1.02]`}
              >
                <div className="text-center">
                  <div className="w-16 h-16 rounded-2xl bg-white/80 backdrop-blur-sm flex items-center justify-center mx-auto mb-3 shadow-sm">
                    <s.icon className="h-8 w-8 text-harbor/60" />
                  </div>
                  <span className="text-xs font-display font-semibold text-harbor/50 uppercase tracking-wider">
                    Preview
                  </span>
                </div>
              </div>
              <h3 className="font-display text-base font-semibold text-harbor mb-1">{s.title}</h3>
              <p className="text-sm text-slate-ink/60 font-body leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function IntegrationsSection() {
  return (
    <section className="py-20 lg:py-28">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="max-w-5xl mx-auto flex flex-col lg:flex-row items-center gap-12">
          <div className="lg:w-1/2">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
              Integrations
            </p>
            <h2 className="font-display text-3xl font-bold text-harbor mb-4">
              Connects to the tools you already use.
            </h2>
            <p className="text-slate-ink/60 font-body leading-relaxed mb-6">
              Sync call data, trigger workflows, and push outcomes to your CRM, calendar, or EHR system.
            </p>
            <Link
              to="/integrations"
              className="inline-flex items-center gap-2 text-teal hover:text-teal-hover font-semibold text-sm transition-colors"
            >
              View all integrations
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="lg:w-1/2">
            <div className="grid grid-cols-2 gap-3">
              {integrations.map((name) => (
                <div
                  key={name}
                  className="flex items-center gap-3 bg-white rounded-xl border border-soft-steel/30 px-4 py-3.5 hover:border-teal/30 hover:shadow-sm transition-all duration-200"
                >
                  <div className="w-8 h-8 rounded-lg bg-teal/10 flex items-center justify-center flex-shrink-0">
                    {name === 'Custom API' ? (
                      <Link2 className="h-4 w-4 text-teal" />
                    ) : (
                      <Plug className="h-4 w-4 text-teal" />
                    )}
                  </div>
                  <span className="text-sm font-medium text-harbor font-body">{name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SecuritySection() {
  return (
    <section className="py-20 lg:py-28 bg-harbor text-white">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="max-w-3xl mx-auto text-center mb-14">
          <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
            Security & Compliance
          </p>
          <h2 className="font-display text-3xl lg:text-4xl font-bold mb-4">
            Built for regulated industries.
          </h2>
          <p className="text-white/60 font-body leading-relaxed">
            Enterprise-grade security and compliance controls baked into every layer of the platform.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
          {securityBadges.map((b) => (
            <div
              key={b.title}
              className="bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 p-6 hover:bg-white/10 transition-all duration-300 group"
            >
              <div className="w-12 h-12 rounded-xl bg-teal/20 flex items-center justify-center mb-4 group-hover:bg-teal/30 transition-colors">
                <b.icon className="h-6 w-6 text-teal" />
              </div>
              <h3 className="font-display text-base font-semibold mb-2">{b.title}</h3>
              <p className="text-sm text-white/50 font-body leading-relaxed">{b.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Product() {
  return (
    <div>
      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Product
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              A voice operations command center for your business.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              QVO combines call handling, scheduling, routing, follow-up logic, and team visibility in one system. Every call is answered, every outcome is tracked.
            </p>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-2xl mb-14">
            <h2 className="font-display text-3xl font-bold text-harbor mb-4">
              Everything your front desk does, automated and visible.
            </h2>
            <p className="text-slate-ink/60 font-body leading-relaxed">
              From the first ring to the follow-up task, QVO handles the complete voice operations workflow.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {capabilities.map((c) => (
              <div key={c.title} className="bg-white rounded-2xl border border-soft-steel/50 p-7 hover:border-teal/30 hover:shadow-md transition-all duration-300 group">
                <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center mb-4 group-hover:bg-teal/15 transition-colors">
                  <c.icon className="h-5 w-5 text-teal" />
                </div>
                <h3 className="font-display text-base font-semibold text-harbor mb-2">{c.title}</h3>
                <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{c.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <WorkflowSection />
      <ScreenshotsSection />
      <IntegrationsSection />
      <SecuritySection />

      <section className="bg-mist py-20 lg:py-24">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-3xl font-bold text-harbor mb-4">
            See it in action.
          </h2>
          <p className="text-lg text-slate-ink/60 font-body mb-10">
            Try our live demo agents or start your free trial today.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/demo"
              className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
            >
              Try the demo
            </Link>
            <Link
              to="/signup"
              className="inline-flex items-center justify-center gap-2 bg-harbor hover:bg-harbor-light text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
            >
              Start free trial
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
