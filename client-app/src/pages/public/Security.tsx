import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Shield, Lock, Key, Eye, FileCheck, Server, Users, AlertTriangle, Download } from 'lucide-react';
import SEO from '../../components/SEO';
import { trackPageView } from '../../lib/analytics';

const controls = [
  { icon: Lock, title: 'Encryption in Transit', body: 'All connections use TLS 1.2 or higher. HSTS enforced on all production endpoints.' },
  { icon: Server, title: 'Encryption at Rest', body: 'Database, backups, and object storage encrypted with AES-256. Per-tenant data encryption keys (DEKs) rotated on demand.' },
  { icon: Users, title: 'Tenant Isolation', body: 'PostgreSQL Row Level Security policies enforced on every tenant-scoped table. Cross-tenant access tests run on every release.' },
  { icon: Key, title: 'Access Controls', body: 'Hierarchical RBAC (Owner / Manager / Operator / Viewer). API keys are scoped, hashed (SHA-256), and never stored in plaintext.' },
  { icon: Eye, title: 'Audit Logging', body: 'Append-only audit trail with database triggers preventing modification or deletion. Exportable to CSV by tenant managers.' },
  { icon: AlertTriangle, title: 'Incident Response', body: '24/7 on-call rotation. Customers notified within 72 hours of confirmed personal data breach. Post-incident reports for material events.' },
  { icon: Shield, title: 'Employee Access', body: 'Least-privilege access reviewed quarterly. Production access requires MFA and is logged. Background checks for personnel with data access.' },
  { icon: FileCheck, title: 'Vulnerability Management', body: 'Dependency scanning on every PR. Annual penetration testing by independent third party. Bug bounty program in pilot.' },
];

const certifications = [
  { name: 'SOC 2 Type II', status: 'In progress', target: 'Q4 2026', description: 'Trust services criteria audit covering Security and Availability.' },
  { name: 'HIPAA', status: 'Available with BAA', target: 'Pro & Enterprise plans', description: 'Business Associate Agreement available for healthcare customers. PHI safeguards in place.' },
  { name: 'GDPR', status: 'Compliant', target: 'EU/UK customers', description: 'Standard Contractual Clauses, DPA, and Data Subject Rights workflows.' },
  { name: 'CCPA / CPRA', status: 'Compliant', target: 'California residents', description: 'Disclosure, deletion, and opt-out rights honored via Settings → Privacy.' },
  { name: 'ISO 27001', status: 'Roadmap', target: '2027', description: 'Information Security Management System certification on roadmap.' },
];

export default function Security() {
  useEffect(() => { trackPageView('/security'); }, []);
  return (
    <div className="bg-surface">
      <SEO title="Security & Compliance — QVO" description="QVO security architecture, certifications, and compliance posture." canonicalPath="/security" />
      <section className="bg-sidebar-bg text-white py-20">
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <div className="inline-flex items-center gap-2 bg-primary/15 border border-primary/25 rounded-full px-4 py-1.5 mb-6">
            <Shield className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-primary">Trust & Security</span>
          </div>
          <h1 className="font-display text-4xl lg:text-5xl font-bold mb-4">Built for regulated industries.</h1>
          <p className="text-lg text-white/70 font-body max-w-3xl">
            QVO handles voice, SMS, and protected health information. Our security program is designed for healthcare, legal,
            financial services, and other regulated workloads.
          </p>
        </div>
      </section>

      <section className="py-16 bg-surface">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          <h2 className="font-display text-2xl font-bold text-text-primary mb-8">Security controls</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
            {controls.map((c) => (
              <div key={c.title} className="bg-surface-secondary rounded-xl p-5 border border-border/30">
                <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-3">
                  <c.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-display text-sm font-semibold text-text-primary mb-1.5">{c.title}</h3>
                <p className="text-xs text-text-primary/65 font-body leading-relaxed">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16 bg-surface-secondary">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          <h2 className="font-display text-2xl font-bold text-text-primary mb-8">Compliance & certifications</h2>
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
                      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded ${
                        c.status === 'Compliant' || c.status.startsWith('Available')
                          ? 'bg-success/15 text-success'
                          : c.status === 'In progress'
                          ? 'bg-accent/15 text-accent'
                          : 'bg-border-strong/30 text-text-primary/60'
                      }`}>{c.status}</span>
                    </td>
                    <td className="px-5 py-4 text-text-primary/70">{c.target}</td>
                    <td className="px-5 py-4 text-text-primary/65 text-xs">{c.description}</td>
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
            Need a DPA for your procurement review? Download our standard template, or contact us for a counter-signed copy.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="/legal/dpa"
              className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white font-semibold px-5 py-2.5 rounded-lg text-sm"
            >
              <Download className="h-4 w-4" />
              Download DPA template
            </a>
            <Link
              to="/subprocessors"
              className="inline-flex items-center justify-center gap-2 bg-surface-muted hover:bg-surface-hover text-text-primary font-semibold px-5 py-2.5 rounded-lg text-sm"
            >
              View sub-processors
            </Link>
          </div>
          <p className="text-xs text-text-primary/50 font-body mt-4">
            Templates marked DRAFT are pending legal review. Final counter-signed copies available on request.
          </p>
        </div>
      </section>

      <section className="py-12 bg-sidebar-bg text-white text-center">
        <div className="max-w-3xl mx-auto px-6 lg:px-8">
          <h3 className="font-display text-xl font-semibold mb-2">Report a security issue</h3>
          <p className="text-white/70 font-body mb-4">
            Found a vulnerability? Disclose responsibly to <a href="mailto:security@qvo.example" className="text-primary hover:underline">security@qvo.example</a>.
          </p>
        </div>
      </section>
    </div>
  );
}
