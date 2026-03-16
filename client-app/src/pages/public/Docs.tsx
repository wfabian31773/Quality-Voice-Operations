import { Link } from 'react-router-dom';
import {
  BookOpen, Zap, Key, Phone, Bot, BarChart3,
  FileText, Shield, ArrowRight, Webhook, Users,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';

const gettingStarted = [
  {
    icon: Users,
    title: 'Create your account',
    desc: 'Sign up, choose a plan, and complete the onboarding wizard. Your tenant environment is provisioned automatically.',
  },
  {
    icon: Bot,
    title: 'Configure an agent',
    desc: 'Select an industry template (Medical, Dental, Legal, etc.), customize the voice and system prompt, and set routing rules.',
  },
  {
    icon: Phone,
    title: 'Connect a phone number',
    desc: 'Provision a local or toll-free number from the dashboard and assign it to your agent. Calls start flowing immediately.',
  },
  {
    icon: BarChart3,
    title: 'Monitor and improve',
    desc: 'Review call transcripts, check quality scores, and refine your agent prompt over time. Use analytics to track performance.',
  },
];

const apiSections = [
  {
    icon: Key,
    title: 'Authentication',
    desc: 'JWT-based auth for dashboard access. API keys with scoped permissions for programmatic access. All requests require a valid token.',
  },
  {
    icon: Bot,
    title: 'Agents API',
    desc: 'Create, update, and manage voice agents. Configure system prompts, voice settings, tool permissions, and escalation rules.',
  },
  {
    icon: Phone,
    title: 'Phone Numbers API',
    desc: 'Provision numbers, assign agents, configure routing rules, and manage number pools for multi-location deployments.',
  },
  {
    icon: FileText,
    title: 'Calls API',
    desc: 'Query call history, retrieve transcripts, access recordings, and filter by date, agent, outcome, or caller.',
  },
  {
    icon: BarChart3,
    title: 'Analytics API',
    desc: 'Pull call volume, cost metrics, campaign performance, and quality scores. Supports date-range filtering and tenant scoping.',
  },
  {
    icon: Webhook,
    title: 'Webhooks',
    desc: 'Subscribe to call events (started, completed, escalated) and push real-time data to your CRM, helpdesk, or custom systems.',
  },
];

const platformDocs = [
  {
    icon: Shield,
    title: 'Security and compliance',
    desc: 'Tenant isolation, RLS-enforced database access, PHI redaction, RBAC, audit logging, and API key scoping.',
  },
  {
    icon: Users,
    title: 'Multi-tenant architecture',
    desc: 'Each customer operates in an isolated tenant with dedicated agents, numbers, campaigns, and analytics. No data crosses tenant boundaries.',
  },
  {
    icon: Zap,
    title: 'Campaign system',
    desc: 'Outbound dialing with contact management, CSV import, DNC enforcement, retry logic, AMD detection, and outcome classification.',
  },
];

export default function Docs() {
  return (
    <div>
      <SEO
        title="Documentation — QVO Developer & User Guides"
        description="Get started with QVO: setup guides, API reference, webhook documentation, and best practices for configuring your AI voice agents."
        canonicalPath="/docs"
      />
      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Documentation
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Build with QVO.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              Everything you need to get started, integrate with your systems, and scale your voice operations.
            </p>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="flex items-center gap-3 mb-8">
              <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center">
                <BookOpen className="h-5 w-5 text-teal" />
              </div>
              <h2 className="font-display text-2xl font-bold text-harbor">Getting started</h2>
            </div>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-20">
              {gettingStarted.map((item, idx) => (
                <div key={item.title} className="bg-white rounded-2xl border border-soft-steel/50 p-7 hover:border-teal/30 hover:shadow-md hover:-translate-y-1 transition-all duration-300">
                  <div className="w-8 h-8 rounded-lg bg-teal text-white font-display text-sm font-bold flex items-center justify-center mb-4">
                    {idx + 1}
                  </div>
                  <h3 className="font-display text-base font-semibold text-harbor mb-2">{item.title}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{item.desc}</p>
                </div>
              ))}
            </div>
          </RevealSection>

          <RevealSection>
            <div className="flex items-center gap-3 mb-8">
              <div className="w-10 h-10 rounded-xl bg-harbor/10 flex items-center justify-center">
                <Key className="h-5 w-5 text-harbor" />
              </div>
              <h2 className="font-display text-2xl font-bold text-harbor">API reference</h2>
            </div>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-20">
              {apiSections.map((item) => (
                <div key={item.title} className="bg-white rounded-2xl border border-soft-steel/50 p-7 hover:border-teal/30 hover:shadow-md hover:-translate-y-1 transition-all duration-300">
                  <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center mb-4">
                    <item.icon className="h-5 w-5 text-teal" />
                  </div>
                  <h3 className="font-display text-base font-semibold text-harbor mb-2">{item.title}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{item.desc}</p>
                </div>
              ))}
            </div>
          </RevealSection>

          <RevealSection>
            <div className="flex items-center gap-3 mb-8">
              <div className="w-10 h-10 rounded-xl bg-harbor/10 flex items-center justify-center">
                <Shield className="h-5 w-5 text-harbor" />
              </div>
              <h2 className="font-display text-2xl font-bold text-harbor">Platform</h2>
            </div>
            <div className="grid md:grid-cols-3 gap-6">
              {platformDocs.map((item) => (
                <div key={item.title} className="bg-white rounded-2xl border border-soft-steel/50 p-7 hover:border-teal/30 hover:shadow-md hover:-translate-y-1 transition-all duration-300">
                  <div className="w-10 h-10 rounded-xl bg-harbor/10 flex items-center justify-center mb-4">
                    <item.icon className="h-5 w-5 text-harbor" />
                  </div>
                  <h3 className="font-display text-base font-semibold text-harbor mb-2">{item.title}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{item.desc}</p>
                </div>
              ))}
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="bg-harbor text-white py-16">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold mb-4">
            Need help integrating?
          </h2>
          <p className="text-white/60 font-body mb-8">
            Our engineering team can help you connect QVO to your existing systems.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/contact"
              className="inline-flex items-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
            >
              Contact engineering
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/signup"
              className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
            >
              Start building
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
