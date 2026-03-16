import { Link } from 'react-router-dom';
import {
  Phone, Clock, Calendar, BarChart3, Shield, ArrowRight,
  Zap, GitBranch, Layers, Bot, Bell, FileText,
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
              <div key={c.title} className="bg-white rounded-2xl border border-soft-steel/50 p-7 hover:border-teal/30 transition-colors">
                <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center mb-4">
                  <c.icon className="h-5 w-5 text-teal" />
                </div>
                <h3 className="font-display text-base font-semibold text-harbor mb-2">{c.title}</h3>
                <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{c.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center">
            <h2 className="font-display text-3xl font-bold text-harbor mb-4">
              How it works
            </h2>
            <p className="text-slate-ink/60 font-body mb-14">
              Get up and running in three steps.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            {[
              { step: '1', title: 'Configure your agent', desc: 'Choose an industry template, customize the voice and prompts, and set your routing rules.' },
              { step: '2', title: 'Connect a phone number', desc: 'Provision a number or bring your own. Assign it to your agent and set call handling preferences.' },
              { step: '3', title: 'Go live', desc: 'Start taking calls. Monitor performance, review transcripts, and refine your agent over time.' },
            ].map((s) => (
              <div key={s.step} className="text-center">
                <div className="w-12 h-12 rounded-full bg-teal text-white font-display text-xl font-bold flex items-center justify-center mx-auto mb-5">
                  {s.step}
                </div>
                <h3 className="font-display text-lg font-semibold text-harbor mb-2">{s.title}</h3>
                <p className="text-sm text-slate-ink/60 font-body leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-harbor text-white py-20 lg:py-24">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-3xl font-bold mb-4">
            See it in action.
          </h2>
          <p className="text-lg text-white/60 font-body mb-10">
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
              to="/login?mode=signup"
              className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
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
