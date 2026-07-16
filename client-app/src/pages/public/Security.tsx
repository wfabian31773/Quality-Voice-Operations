import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Shield, Lock, Key, Eye, FileCheck, Server, Users, AlertTriangle, Download } from 'lucide-react';
import SEO from '../../components/SEO';
import { trackPageView } from '../../lib/analytics';
import { PUBLIC_COMPLIANCE_FRAMEWORKS } from '../../../../shared/compliance/publicCompliancePosture';

const controls = [
  { icon: Lock, title: 'Transport Security', body: 'Application support for secure transport exists. Production TLS, proxy, certificate, and HSTS configuration remain deployment evidence that must be verified.' },
  { icon: Server, title: 'Storage Protection', body: 'Envelope encryption protects selected sensitive fields. Database, backup, object-storage, key-rotation, and full field-coverage evidence remain under review.' },
  { icon: Users, title: 'Tenant Isolation', body: 'Tenant-scoped tables use Row Level Security and application tenant context. Production policy coverage and deployment enforcement require release verification.' },
  { icon: Key, title: 'Access Controls', body: 'Role guards and scoped credentials are implemented. Least-privilege assignments, MFA, and production access reviews remain operator-controlled evidence.' },
  { icon: Eye, title: 'Audit Logging', body: 'The platform implements append-only controls for its audit log. End-to-end event coverage, retention, export, and monitoring require pilot approval.' },
  { icon: AlertTriangle, title: 'Recording Boundary', body: 'Call recording is disabled by default. Enabling it requires an approved purpose, consent script, jurisdiction review, retention rule, and access boundary.' },
  { icon: Shield, title: 'Personnel Controls', body: 'Personnel screening, access-review cadence, incident staffing, and notification commitments are not verified in the repository.' },
  { icon: FileCheck, title: 'Assurance Evidence', body: 'Independent assessments, certification scope, vulnerability-management cadence, and remediation evidence require owner verification before publication.' },
];

const certifications = PUBLIC_COMPLIANCE_FRAMEWORKS;

export default function Security() {
  useEffect(() => { trackPageView('/security'); }, []);
  return (
    <div className="bg-surface">
      <SEO title="Security Evidence State — QVO" description="Current QVO security-control evidence, unverified claims, and healthcare pilot approval boundary." canonicalPath="/security" />
      {/*
        Security hero — flat dark band placeholder. Wayne's bespoke
        Higgsfield render slots in here later (drop file at
        /hero/security-hero.{webp,mp4} and add a <picture>/<video> above
        the gradient layer). Until then:
          - radial-gradient backdrop at 25% 50% (off-center, distinct
            from sibling marketing pages)
          - oversize tracking-tight headline (text-6xl @ lg)
          - explicit text-white on h1 — defensive against the QVO base
            reset h1 color rule that renders headlines invisible on dark
            surfaces (same bug we fixed on /demo, /pricing, /features)
        py-16 lg:py-24 (was py-20) — tighter density now that there's
        no image to support the larger padding.
      */}
      <section className="relative overflow-hidden bg-sidebar-bg text-white py-16 lg:py-24">
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 70% 60% at 25% 50%, rgba(46,140,131,0.20), transparent 70%)',
          }}
        />
        <div className="relative max-w-5xl mx-auto px-6 lg:px-8">
          <div className="inline-flex items-center gap-2 bg-primary/15 border border-primary/25 rounded-full px-4 py-1.5 mb-6">
            <Shield className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-primary">Trust & Security</span>
          </div>
          <h1 className="font-display text-white text-4xl lg:text-6xl font-bold tracking-tight mb-4">Evidence before claims.</h1>
          <p className="text-lg text-white/70 font-body max-w-3xl">
            QVO publishes only the controls and approvals it can currently prove. Healthcare pilot traffic remains synthetic-only,
            with recording disabled, until the required technical, legal, customer, and vendor gates are approved.
          </p>
        </div>
      </section>

      <section className="py-16 bg-surface">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          <h2 className="font-display text-2xl font-bold text-text-primary mb-8">Control evidence state</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {controls.map((c) => (
              <div key={c.title} className="bg-surface-secondary rounded-xl p-5 border border-border/30">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-3">
                  <c.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-display text-sm font-semibold text-text-primary mb-1.5">{c.title}</h3>
                <p className="text-xs text-text-secondary font-body leading-relaxed">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16 bg-surface-secondary">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          <h2 className="font-display text-2xl font-bold text-text-primary mb-8">Framework review status</h2>
          <div className="bg-surface rounded-xl border border-border/30 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-secondary/50 border-b border-border/30">
                <tr>
                  <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">Framework</th>
                  <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">Status</th>
                  <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">Scope</th>
                  <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody>
                {certifications.map((c) => (
                  <tr key={c.name} className="border-b border-border/20 last:border-0">
                    <td className="px-5 py-4 font-medium text-text-primary">{c.name}</td>
                    <td className="px-5 py-4">
                      <span className="inline-block text-xs font-medium px-2 py-0.5 rounded bg-border-strong/30 text-text-secondary">
                        {c.status_label}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-text-primary/70">{c.scope}</td>
                    <td className="px-5 py-4 text-text-secondary text-xs">{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="py-16 bg-surface">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold text-text-primary mb-3">Data Processing Addendum</h2>
          <p className="text-text-primary/70 font-body mb-6 max-w-2xl mx-auto">
            The current DPA is a draft template for legal review. It is not an executed agreement and does not authorize PHI processing.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="/legal/dpa"
              className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white font-semibold px-5 py-2.5 rounded-lg text-sm"
            >
              <Download className="h-4 w-4" />
              Review draft DPA
            </a>
            <Link
              to="/subprocessors"
              className="inline-flex items-center justify-center gap-2 bg-surface-muted hover:bg-surface-hover text-text-primary font-semibold px-5 py-2.5 rounded-lg text-sm"
            >
              View sub-processors
            </Link>
          </div>
          <p className="text-xs text-text-secondary font-body mt-4">
            Approval pending: legal terms, vendor agreements, deployment controls, and the customer operating boundary must all be verified before production healthcare traffic.
          </p>
        </div>
      </section>

      <section className="py-12 bg-sidebar-bg text-white text-center">
        <div className="max-w-3xl mx-auto px-6 lg:px-8">
          {/* Defensive text-white: the QVO base reset rule targets
              h1-h5, so h3 on dark surfaces also goes invisible without
              an explicit color. */}
          <h3 className="font-display text-white text-xl font-semibold mb-2">Report a security issue</h3>
          <p className="text-white/70 font-body mb-4">
            Use the <Link to="/contact" className="text-primary hover:underline">contact form</Link> for security reports and procurement questions.
          </p>
        </div>
      </section>
    </div>
  );
}
