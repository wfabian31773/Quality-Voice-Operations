import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import {
  ArrowRight, Database, Calendar, Ticket, MessageSquare,
  Mail, Webhook, Phone, FileText, Shield, Plug,
  CreditCard, CheckCircle2,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackCTAClick } from '../../lib/analytics';

const primaryIntegrations = [
  {
    icon: Calendar,
    category: 'Scheduling',
    title: 'Google Calendar',
    desc: 'Book, reschedule, and confirm appointments directly within the call flow. Real-time availability checks ensure no double bookings.',
    features: ['Real-time availability', 'Automatic booking', 'Conflict detection', 'Reminder sync'],
    highlight: true,
  },
  {
    icon: Phone,
    category: 'Telephony',
    title: 'Twilio',
    desc: 'Enterprise-grade telephony infrastructure. Provision local and toll-free numbers, handle inbound and outbound calls, and send SMS — all through QVO.',
    features: ['Number provisioning', 'Inbound/outbound calls', 'SMS messaging', 'Call recording'],
    highlight: true,
  },
  {
    icon: CreditCard,
    category: 'Payments',
    title: 'Stripe',
    desc: 'Accept payments and process transactions during calls. Send payment links via SMS, collect deposits, and manage subscription billing.',
    features: ['Payment links', 'Invoice generation', 'Subscription management', 'Refund processing'],
    highlight: true,
  },
  {
    icon: Database,
    category: 'CRM',
    title: 'CRM Systems',
    desc: 'Sync caller data with Salesforce, HubSpot, Zoho CRM, or your custom CRM. Contact records, call logs, and follow-up tasks flow automatically.',
    features: ['Contact sync', 'Call log automation', 'Lead scoring', 'Task creation'],
    highlight: true,
  },
  {
    icon: Ticket,
    category: 'Ticketing',
    title: 'Ticketing Systems',
    desc: 'Create support tickets in Zendesk, Freshdesk, or Jira Service Management directly from call conversations. Auto-route tickets to the right team.',
    features: ['Ticket creation', 'Priority routing', 'SLA tracking', 'Status updates'],
    highlight: true,
  },
  {
    icon: Webhook,
    category: 'Automation',
    title: 'Zapier / Webhooks',
    desc: 'Push call events, transcripts, and outcomes to any external system. Build custom workflows with Zapier, Make, n8n, or direct webhook integration.',
    features: ['Event webhooks', 'Zapier triggers', 'Custom payloads', 'Retry logic'],
    highlight: true,
  },
];

const additionalIntegrations = [
  {
    icon: MessageSquare,
    category: 'SMS',
    title: 'SMS & Messaging',
    desc: 'Send confirmation texts, appointment reminders, and follow-up messages. Two-way messaging for callback coordination.',
    features: ['Appointment confirmations', 'Follow-up sequences', 'Two-way messaging', 'Template system'],
  },
  {
    icon: Mail,
    category: 'Email',
    title: 'Email Notifications',
    desc: 'Send call summaries, escalation alerts, and daily digests via email. Configurable per agent and urgency level.',
    features: ['Call summaries', 'Escalation alerts', 'Daily digests', 'Custom templates'],
  },
  {
    icon: FileText,
    category: 'Compliance',
    title: 'Compliance & Records',
    desc: 'Full call recordings, transcripts, and audit logs for regulatory compliance. PHI redaction built in for healthcare.',
    features: ['Call recordings', 'PHI redaction', 'Audit trails', 'Data retention'],
  },
  {
    icon: Shield,
    category: 'Security',
    title: 'Authentication & Access',
    desc: 'Role-based access control, JWT authentication, API key scoping, and tenant isolation for enterprise security.',
    features: ['RBAC', 'API keys', 'Tenant isolation', 'SSO support'],
  },
];

export default function Integrations() {
  useEffect(() => {
    trackPageView('/integrations');
  }, []);

  return (
    <div>
      <SEO
        title="Integrations — Google Calendar, Twilio, Stripe, CRM, and More"
        description="QVO integrates with Google Calendar, Twilio, Stripe, Salesforce, HubSpot, Zendesk, Zapier, and more. Connect your AI voice agents to the tools you already use."
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
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              QVO integrates with your calendar, CRM, helpdesk, payment system, and communication channels. Call data flows where it belongs, automatically.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/25"
                onClick={() => trackCTAClick('Try Live Demo', '/integrations', 'hero')}
              >
                Try Live Demo
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/features"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('See All Features', '/integrations', 'hero')}
              >
                See All Features
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Core Integrations
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                Six essential integrations that power every QVO deployment.
              </p>
            </div>
          </RevealSection>

          <RevealSection>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
              {primaryIntegrations.map((int) => (
                <div key={int.title} className="bg-white rounded-2xl border-2 border-teal/20 p-7 hover:border-teal/40 hover:shadow-lg hover:-translate-y-1 transition-all duration-300">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center">
                      <int.icon className="h-5 w-5 text-teal" />
                    </div>
                    <div>
                      <span className="text-xs font-semibold font-display text-teal uppercase tracking-wide">{int.category}</span>
                    </div>
                  </div>
                  <h3 className="font-display text-lg font-semibold text-harbor mb-2">{int.title}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body mb-4">{int.desc}</p>
                  <div className="space-y-1.5">
                    {int.features.map((f) => (
                      <div key={f} className="flex items-center gap-2 text-xs text-slate-ink/70 font-body">
                        <CheckCircle2 className="h-3.5 w-3.5 text-calm-green shrink-0" />
                        {f}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </RevealSection>

          <RevealSection>
            <div className="text-center mb-10">
              <h2 className="font-display text-2xl font-bold text-harbor mb-3">
                Additional Capabilities
              </h2>
            </div>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              {additionalIntegrations.map((int) => (
                <div key={int.title} className="bg-white rounded-2xl border border-soft-steel/50 p-6 hover:border-teal/30 hover:shadow-md transition-all duration-300">
                  <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center mb-4">
                    <int.icon className="h-5 w-5 text-teal" />
                  </div>
                  <h3 className="font-display text-base font-semibold text-harbor mb-2">{int.title}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{int.desc}</p>
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
                to="/signup"
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
                onClick={() => trackCTAClick('Start Free Trial', '/integrations', 'bottom-cta')}
              >
                Start Free Trial
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/contact"
                className="inline-flex items-center gap-2 bg-harbor hover:bg-harbor-light text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
                onClick={() => trackCTAClick('Talk to Engineering', '/integrations', 'bottom-cta')}
              >
                Talk to Engineering
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
