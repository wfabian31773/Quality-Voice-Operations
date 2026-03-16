import { Link } from 'react-router-dom';
import {
  ArrowRight, Database, Calendar, Ticket, MessageSquare,
  Mail, Webhook, Phone, FileText, Shield, Plug,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';

const integrations = [
  {
    icon: Database,
    category: 'CRM',
    title: 'CRM systems',
    desc: 'Connect to your customer relationship management system. Sync caller data, update contact records, and create follow-up tasks automatically after each call.',
    examples: 'Salesforce, HubSpot, Zoho CRM, and custom CRM via API',
  },
  {
    icon: Calendar,
    category: 'Scheduling',
    title: 'Scheduling platforms',
    desc: 'Book, reschedule, and confirm appointments directly within the call flow. Integrates with your existing calendar system to check availability in real time.',
    examples: 'Google Calendar, Calendly, and practice management systems',
  },
  {
    icon: Ticket,
    category: 'Ticketing',
    title: 'Ticketing and helpdesk',
    desc: 'Create support tickets, maintenance requests, or intake records automatically from call conversations. Route tickets to the right team.',
    examples: 'Zendesk, Freshdesk, Jira Service Management, and custom ticketing',
  },
  {
    icon: MessageSquare,
    category: 'SMS',
    title: 'SMS and messaging',
    desc: 'Send confirmation texts, appointment reminders, and follow-up messages via SMS. Two-way messaging for callback coordination.',
    examples: 'Twilio SMS, appointment confirmations, and follow-up sequences',
  },
  {
    icon: Mail,
    category: 'Email',
    title: 'Email notifications',
    desc: 'Send call summaries, escalation alerts, and daily digests to your team via email. Configurable per agent and urgency level.',
    examples: 'SMTP, SendGrid, and custom email delivery',
  },
  {
    icon: Webhook,
    category: 'Webhooks',
    title: 'Webhooks and API',
    desc: 'Push call events, transcripts, and outcomes to any external system in real time. Build custom workflows with our REST API and webhook delivery.',
    examples: 'Zapier, Make, n8n, and direct API integration',
  },
  {
    icon: Phone,
    category: 'Telephony',
    title: 'Telephony infrastructure',
    desc: 'Built on enterprise-grade telephony. Provision local and toll-free numbers, configure call routing, and manage number pools from the dashboard.',
    examples: 'Twilio voice, number provisioning, and call routing',
  },
  {
    icon: FileText,
    category: 'Compliance',
    title: 'Compliance and records',
    desc: 'Full call recordings, transcripts, and audit logs for regulatory compliance. PHI redaction built into the platform for healthcare use cases.',
    examples: 'HIPAA-ready logging, audit trails, and data retention policies',
  },
  {
    icon: Shield,
    category: 'Security',
    title: 'Authentication and access',
    desc: 'Role-based access control, JWT authentication, API key scoping, and tenant isolation. Enterprise-ready security built into the platform.',
    examples: 'RBAC, API keys, tenant isolation, and session management',
  },
];

export default function Integrations() {
  return (
    <div>
      <SEO
        title="Integrations — Connect QVO to Your Tools"
        description="QVO integrates with your CRM, calendar, helpdesk, and more. Connect Salesforce, Google Calendar, Zendesk, and dozens of other tools."
        canonicalPath="/integrations"
      />
      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Integrations
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Connects to the tools you already use.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              QVO integrates with your CRM, scheduling system, helpdesk, and communication channels. Push call data where it belongs automatically.
            </p>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {integrations.map((int) => (
              <div key={int.title} className="bg-white rounded-2xl border border-soft-steel/50 p-7 hover:border-teal/30 hover:shadow-md hover:-translate-y-1 transition-all duration-300">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center">
                    <int.icon className="h-5 w-5 text-teal" />
                  </div>
                  <span className="text-xs font-semibold font-display text-teal uppercase tracking-wide">{int.category}</span>
                </div>
                <h3 className="font-display text-lg font-semibold text-harbor mb-2">{int.title}</h3>
                <p className="text-sm text-slate-ink/60 leading-relaxed font-body mb-4">{int.desc}</p>
                <p className="text-xs text-slate-ink/40 font-body">
                  {int.examples}
                </p>
              </div>
            ))}
          </div>
          </RevealSection>
        </div>
      </section>

      <section className="bg-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center">
            <div className="w-14 h-14 rounded-2xl bg-teal/10 flex items-center justify-center mx-auto mb-6">
              <Plug className="h-7 w-7 text-teal" />
            </div>
            <h2 className="font-display text-3xl font-bold text-harbor mb-4">
              Need a custom integration?
            </h2>
            <p className="text-slate-ink/60 font-body mb-8 leading-relaxed">
              QVO's REST API and webhook system lets you connect to any external service. Our developer documentation covers authentication, event types, and payload formats.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/docs"
                className="inline-flex items-center gap-2 bg-harbor hover:bg-harbor-light text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
              >
                Read the docs
              </Link>
              <Link
                to="/contact"
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
              >
                Talk to engineering
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
