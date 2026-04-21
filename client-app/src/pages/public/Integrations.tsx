import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import {
  ArrowRight, MessageSquare, Mail, FileText, Shield, Plug, CheckCircle2,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import BrandLogo from '../../components/BrandLogo';
import { trackPageView, trackCTAClick } from '../../lib/analytics';

const primaryIntegrations = [
  {
    logoId: 'google-calendar',
    category: 'Scheduling',
    title: 'Google Calendar',
    desc: 'Book, reschedule, and confirm appointments directly within the call flow. Real-time availability checks ensure no double bookings.',
    features: ['Real-time availability', 'Automatic booking', 'Conflict detection', 'Reminder sync'],
  },
  {
    logoId: 'outlook-calendar',
    category: 'Scheduling',
    title: 'Outlook Calendar',
    desc: 'Sync appointments to Microsoft 365 calendars via Microsoft Graph. OAuth sign-in, timezone-aware booking, and real-time availability checks.',
    features: ['Microsoft 365 sign-in', 'Timezone-aware events', 'Conflict detection', 'Calendars.ReadWrite scope'],
  },
  {
    logoId: 'twilio',
    category: 'Telephony',
    title: 'Twilio',
    desc: 'Enterprise-grade telephony infrastructure. Provision local and toll-free numbers, handle inbound and outbound calls, and send SMS — all through QVO.',
    features: ['Number provisioning', 'Inbound/outbound calls', 'SMS messaging', 'Call recording'],
  },
  {
    logoId: 'stripe',
    category: 'Payments',
    title: 'Stripe',
    desc: 'Accept payments and process transactions during calls. Send payment links via SMS, collect deposits, and manage subscription billing.',
    features: ['Payment links', 'Invoice generation', 'Subscription management', 'Refund processing'],
  },
  {
    logoId: 'hubspot',
    category: 'CRM',
    title: 'HubSpot',
    desc: 'Sync caller data with HubSpot. Contact records, call logs, and follow-up tasks flow automatically into your CRM.',
    features: ['Contact sync', 'Call log automation', 'Lead scoring', 'Task creation'],
  },
  {
    logoId: 'salesforce',
    category: 'CRM',
    title: 'Salesforce',
    desc: 'Sync Contacts, Opportunities, and Tasks to Salesforce. Calls and meetings attach to the right open opportunity so reps always have the latest context.',
    features: ['Contact sync', 'Opportunity attachment', 'Call & task logging', 'Sandbox or production'],
  },
  {
    logoId: 'pipedrive',
    category: 'CRM',
    title: 'Pipedrive',
    desc: 'Sync contacts and deals to Pipedrive. Calls and meetings attach to the right open deal so reps always have the latest context.',
    features: ['Contact sync', 'Deal attachment', 'Activity logging', 'OAuth sign-in'],
  },
  {
    logoId: 'quickbooks',
    category: 'Accounting',
    title: 'QuickBooks',
    desc: 'Push customers to QuickBooks and create invoices when calls complete. Pair with your service item to auto-bill jobs booked by the agent.',
    features: ['Customer sync', 'Invoice automation', 'Sandbox or production', 'OAuth sign-in'],
  },
  {
    logoId: 'slack',
    category: 'Notifications',
    title: 'Slack',
    desc: 'Post call summaries, missed-call alerts, and escalation notices to the right Slack channels in real time.',
    features: ['Channel routing', 'Missed-call alerts', 'Daily digests', 'Mention escalations'],
  },
  {
    logoId: 'zapier',
    category: 'Automation',
    title: 'Zapier',
    desc: 'Push call events, transcripts, and outcomes to thousands of apps via Zapier. Build workflows without writing code.',
    features: ['Event triggers', 'No-code workflows', 'Custom payloads', 'Retry logic'],
  },
];

const additionalIntegrations = [
  {
    icon: MessageSquare,
    category: 'SMS',
    title: 'SMS & Messaging',
    desc: 'Send confirmation texts, appointment reminders, and follow-up messages. Two-way messaging for callback coordination.',
  },
  {
    icon: Mail,
    category: 'Email',
    title: 'Email Notifications',
    desc: 'Send call summaries, escalation alerts, and daily digests via email. Configurable per agent and urgency level.',
  },
  {
    icon: FileText,
    category: 'Compliance',
    title: 'Compliance & Records',
    desc: 'Full call recordings, transcripts, and audit logs for regulatory compliance. PHI redaction built in for healthcare.',
  },
  {
    icon: Shield,
    category: 'Security',
    title: 'Authentication & Access',
    desc: 'Role-based access control, JWT authentication, API key scoping, and tenant isolation for enterprise security.',
  },
];

export default function Integrations() {
  useEffect(() => {
    trackPageView('/integrations');
  }, []);

  return (
    <div>
      <SEO
        title="Integrations — Google Calendar, Outlook, Twilio, Stripe, Salesforce, HubSpot, Pipedrive, QuickBooks, and More"
        description="QVO integrates with Google Calendar, Outlook Calendar, Twilio, Stripe, Salesforce, HubSpot, Pipedrive, QuickBooks, Slack, Zapier, and more. Connect your AI voice agents to the tools you already use."
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
                Essential integrations across calendar, telephony, payments, CRM, accounting, and notifications — wired into every QVO deployment.
              </p>
            </div>
          </RevealSection>

          <RevealSection>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
              {primaryIntegrations.map((int) => (
                <div key={int.title} className="bg-white rounded-2xl border border-soft-steel/60 p-7 hover:border-teal/40 hover:shadow-lg hover:-translate-y-1 transition-all duration-300">
                  <div className="flex items-center gap-3 mb-4">
                    <BrandLogo provider={int.logoId} size={36} />
                    <span className="text-xs font-semibold font-display text-teal uppercase tracking-wide">{int.category}</span>
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
