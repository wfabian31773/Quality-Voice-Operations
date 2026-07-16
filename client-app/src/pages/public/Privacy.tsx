import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import SEO from '../../components/SEO';
import { trackPageView } from '../../lib/analytics';

const sections = [
  { id: 'data-collected', title: '1. Data We Collect', body: 'Depending on the approved configuration, the Service may process account data, authentication data, voice audio, transcripts, summaries, caller details, tool payloads, message content, and audit metadata. Call recording is disabled by default.' },
  { id: 'lawful-basis', title: '2. Lawful Basis', body: 'The customer contract, deployment purpose, jurisdiction, consent language, and legal review determine the applicable basis for each production deployment. This draft notice does not make a universal legal determination.' },
  { id: 'purposes', title: '3. Purposes of Processing', body: 'To provide and improve the Service, run AI models on conversation data, deliver telephony, bill customers, prevent abuse, comply with law, and communicate with you about your account.' },
  { id: 'retention', title: '4. Data Retention', body: 'A unified, owner-approved healthcare retention and deletion schedule is not yet verified. Production PHI is prohibited until retention periods, deletion coverage, backups, legal holds, and customer instructions are approved and tested.' },
  { id: 'sharing', title: '5. Sharing & Sub-processors', body: 'Production data may reach the approved telephony, AI, hosting, messaging, payment, and support providers listed on the Sub-processors page. The list and required agreements must be verified for each pilot before regulated data is enabled.' },
  { id: 'transfers', title: '6. International Transfers', body: 'Processing regions, backup locations, transfer mechanisms, and contractual safeguards require customer and legal approval. No public data-residency or transfer commitment should be inferred from this draft notice.' },
  { id: 'rights', title: '7. Your Rights', body: 'Available product export and deletion workflows do not by themselves establish complete legal compliance. Use the QVO contact form for a scoped request; applicable rights and response obligations depend on law and the customer agreement.' },
  { id: 'children', title: '8. Children', body: 'The Service is not directed to anyone under 16. We do not knowingly collect Personal Data from children. If you believe we have, contact us to remove it.' },
  { id: 'security', title: '9. Security', body: 'The application implements tenant context, role guards, Row Level Security policies, selected-field envelope encryption, redaction utilities, and append-only audit controls. Production transport, storage, backup, key, access, monitoring, and full data-flow coverage remain subject to verification.' },
  { id: 'cookies', title: '10. Cookies', body: 'We use essential cookies for authentication and session state, and (with your consent) analytics cookies to improve the Service. You can manage preferences via the cookie banner on public pages.' },
  { id: 'contact', title: '11. Contact', body: 'Use the QVO contact form for privacy, security, and data-rights questions. No Data Protection Officer or EU representative appointment is asserted by this draft.' },
];

export default function Privacy() {
  useEffect(() => { trackPageView('/privacy'); }, []);
  return (
    <div className="bg-surface">
      <SEO title="Privacy Policy — QVO" description="How QVO collects, uses, and protects your data." canonicalPath="/privacy" />
      {/*
        Privacy hero — flat dark band placeholder. Wayne's bespoke
        Higgsfield render slots in here later (drop file at
        /hero/privacy-hero.{webp,mp4} and add a <picture>/<video> above
        the gradient layer). Until then:
          - radial-gradient backdrop at 70% 50% (mirrored opposite of
            /terms 30% 50% so the two legal pages feel paired)
          - oversize tracking-tight headline (text-5xl @ lg)
          - explicit text-white on h1 — defensive against the QVO base
            reset h1 color rule that renders headlines invisible on dark
            surfaces (same bug we fixed on /demo, /pricing, /features)
        Padding stayed py-16 — legal page, short hero.
      */}
      <section className="relative overflow-hidden bg-sidebar-bg text-white py-16">
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 70% 60% at 70% 50%, rgba(46,140,131,0.20), transparent 70%)',
          }}
        />
        <div className="relative max-w-4xl mx-auto px-6 lg:px-8">
          <h1 className="font-display text-white text-4xl lg:text-5xl font-bold tracking-tight mb-3">Privacy Policy</h1>
          <p className="text-white/70 font-body">Evidence-state update: July 12, 2026 · Legal approval pending</p>
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
              Contact QVO to scope a request. Healthcare production activation remains blocked until deletion coverage and the pilot operating boundary are approved.
            </p>
            <Link to="/contact" className="inline-flex text-sm font-medium text-primary hover:text-primary-hover">
              Contact QVO →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
