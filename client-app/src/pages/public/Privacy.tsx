import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import SEO from '../../components/SEO';
import { trackPageView } from '../../lib/analytics';

const sections = [
  { id: 'data-collected', title: '1. Data We Collect', body: 'Account data (name, email, phone, billing details), authentication data, configuration and usage data, voice recordings and transcripts when calls are processed through the Service, SMS message content, and audit metadata (IP address, user agent, timestamps).' },
  { id: 'lawful-basis', title: '2. Lawful Basis', body: 'We process Personal Data on the basis of contract performance (providing the Service), legitimate interests (security, fraud prevention, product improvement), legal obligations (tax, telephony regulations), and consent where required.' },
  { id: 'purposes', title: '3. Purposes of Processing', body: 'To provide and improve the Service, run AI models on conversation data, deliver telephony, bill customers, prevent abuse, comply with law, and communicate with you about your account.' },
  { id: 'retention', title: '4. Data Retention', body: 'Account data is retained for the life of the account. Call recordings and transcripts are retained per tenant settings (default 90 days). Audit logs are retained for 1 year. Backups are retained for 30 days. We delete data within 30 days after account termination unless required to retain by law.' },
  { id: 'sharing', title: '5. Sharing & Sub-processors', body: 'We share Personal Data only with sub-processors required to deliver the Service (telephony, AI providers, payment processors, hosting). Our current sub-processor list is published at /subprocessors and is updated when changes occur.' },
  { id: 'transfers', title: '6. International Transfers', body: 'Personal Data may be processed in the United States and other jurisdictions. For transfers from the EEA/UK, we rely on Standard Contractual Clauses and additional safeguards in our DPA.' },
  { id: 'rights', title: '7. Your Rights', body: 'Subject to applicable law, you have the right to access, rectify, delete, restrict, port, and object to processing of your Personal Data. Tenant owners can self-serve data export and deletion requests from Settings → Privacy. Contact privacy@qvo.example to exercise other rights.' },
  { id: 'children', title: '8. Children', body: 'The Service is not directed to anyone under 16. We do not knowingly collect Personal Data from children. If you believe we have, contact us to remove it.' },
  { id: 'security', title: '9. Security', body: 'We use TLS 1.2+ in transit, AES-256 at rest, tenant-isolated databases via Row Level Security, role-based access, and immutable audit logging. See our Security page for details.' },
  { id: 'cookies', title: '10. Cookies', body: 'We use essential cookies for authentication and session state, and (with your consent) analytics cookies to improve the Service. You can manage preferences via the cookie banner on public pages.' },
  { id: 'contact', title: '11. Contact & DPO', body: 'Privacy questions: privacy@qvo.example. Data Protection Officer: dpo@qvo.example. EU representative: TBD.' },
];

export default function Privacy() {
  useEffect(() => { trackPageView('/privacy'); }, []);
  return (
    <div className="bg-white">
      <SEO title="Privacy Policy — QVO" description="How QVO collects, uses, and protects your data." canonicalPath="/privacy" />
      <section className="bg-sidebar-bg text-white py-16">
        <div className="max-w-4xl mx-auto px-6 lg:px-8">
          <h1 className="font-display text-4xl font-bold mb-3">Privacy Policy</h1>
          <p className="text-white/70 font-body">Last updated: {new Date().toISOString().slice(0, 10)}</p>
          <div className="mt-4 inline-block bg-accent/15 border border-accent/30 px-3 py-1.5 rounded-md text-xs text-accent font-medium">
            DRAFT — pending legal review
          </div>
        </div>
      </section>
      <section className="py-16">
        <div className="max-w-4xl mx-auto px-6 lg:px-8">
          <p className="text-text-primary/70 font-body mb-8 leading-relaxed">
            This Privacy Policy describes how Quality Voice Operations ("QVO", "we", "us") collects, uses, and shares Personal Data when you use our Service.
          </p>
          <div className="space-y-8">
            {sections.map((s) => (
              <div key={s.id} id={s.id}>
                <h2 className="font-display text-xl font-semibold text-text-primary mb-3">{s.title}</h2>
                <p className="text-sm text-text-primary/70 font-body leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-12 p-6 bg-surface-secondary rounded-xl border border-border/30">
            <h3 className="font-display text-base font-semibold text-text-primary mb-2">Exercise your rights</h3>
            <p className="text-sm text-text-primary/70 font-body mb-3">
              Tenant owners can request a full data export or schedule account deletion at any time from Settings.
            </p>
            <Link to="/settings/privacy" className="inline-flex text-sm font-medium text-primary hover:text-primary-hover">
              Settings → Privacy →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
