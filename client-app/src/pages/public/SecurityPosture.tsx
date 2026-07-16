import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Shield,
  Clock,
  Map,
  Download,
  ExternalLink,
  FileText,
  AlertCircle,
} from 'lucide-react';
import SEO from '../../components/SEO';
import { trackPageView } from '../../lib/analytics';

type FrameworkStatus = 'not_verified';

interface Framework {
  key: string;
  name: string;
  status: FrameworkStatus;
  status_label: string;
  scope: string;
  description: string;
  evidence_url: string | null;
  last_reviewed: string;
}

interface PostureSubprocessor {
  id: string;
  name: string;
  purpose: string;
  data_types: string;
  location: string;
  website: string | null;
}

interface Posture {
  version: 1;
  generated_at: string;
  organization: {
    name: string;
    contact_security: string;
    contact_privacy: string;
  };
  frameworks: Framework[];
  baa: {
    available: boolean;
    plans: string[];
    contact: string;
    notes: string;
  };
  data_residency: {
    verified: false;
    primary_region: string;
    description: string;
  };
  subprocessors: PostureSubprocessor[];
  documents: { name: string; url: string; kind: 'dpa' | 'list' | 'page' }[];
}

function statusBadgeClasses(status: FrameworkStatus): string {
  return status === 'not_verified'
    ? 'bg-border-strong/30 text-text-primary/60'
    : 'bg-border-strong/30 text-text-primary/60';
}

function ContactLink({ value }: { value: string }) {
  return value.startsWith('/') ? (
    <Link className="text-primary hover:underline" to={value}>Contact QVO</Link>
  ) : (
    <a className="text-primary hover:underline" href={`mailto:${value}`}>{value}</a>
  );
}

export default function SecurityPosture() {
  const [posture, setPosture] = useState<Posture | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trackPageView('/security/posture');
    fetch('/api/public/posture')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Posture) => setPosture(data))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="bg-surface">
      <SEO
        title="Security Posture — QVO"
        description="QVO's evidence-state register for security frameworks, healthcare pilot approval, vendor review, and data residency."
        canonicalPath="/security/posture"
      />

      {/*
        SecurityPosture hero — flat dark band placeholder. Wayne's
        bespoke Higgsfield render slots in here later (drop file at
        /hero/security-posture-hero.{webp,mp4} and add a
        <picture>/<video> above the gradient layer). Until then:
          - radial-gradient backdrop at 75% 50% (off-center, distinct
            from /security 25% 50% so the two trust-section heroes feel
            mirrored)
          - oversize tracking-tight headline (text-6xl @ lg)
          - explicit text-white on h1 — defensive against the QVO base
            reset h1 color rule that renders headlines invisible on dark
            surfaces (same bug we fixed on /demo, /pricing, /features)
        Padding stayed py-16 — this hero already had the tighter size.
      */}
      <section className="relative overflow-hidden bg-sidebar-bg text-white py-16">
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 70% 60% at 75% 50%, rgba(46,140,131,0.20), transparent 70%)',
          }}
        />
        <div className="relative max-w-5xl mx-auto px-6 lg:px-8">
          <div className="inline-flex items-center gap-2 bg-primary/15 border border-primary/25 rounded-full px-4 py-1.5 mb-6">
            <Shield className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-primary">Security Posture</span>
          </div>
          <h1 className="font-display text-white text-4xl lg:text-6xl font-bold tracking-tight mb-4">
            Compliance posture, at a glance.
          </h1>
          <p className="text-lg text-white/70 font-body max-w-3xl">
            A single, machine-readable view of where QVO stands on the frameworks
            our customers care about. Updated as we ship — pulled live from the
            same source as our internal compliance program.
          </p>
          <div className="mt-6 flex flex-wrap gap-3 text-sm">
            <a
              href="/api/public/posture"
              className="inline-flex items-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/20 dark:hover:bg-white/20 px-4 py-2 rounded-lg font-medium"
            >
              <Download className="h-4 w-4" />
              View JSON
            </a>
            <Link
              to="/security"
              className="inline-flex items-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/20 dark:hover:bg-white/20 px-4 py-2 rounded-lg font-medium"
            >
              Security overview
            </Link>
            <Link
              to="/subprocessors"
              className="inline-flex items-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/20 dark:hover:bg-white/20 px-4 py-2 rounded-lg font-medium"
            >
              Sub-processors
            </Link>
          </div>
        </div>
      </section>

      {loading ? (
        <section className="py-20">
          <div className="max-w-5xl mx-auto px-6 lg:px-8 text-center text-text-primary/50 font-body">
            Loading posture…
          </div>
        </section>
      ) : error || !posture ? (
        <section className="py-20">
          <div className="max-w-3xl mx-auto px-6 lg:px-8">
            <div className="bg-danger/10 border border-danger/30 text-danger px-5 py-4 rounded-lg flex items-start gap-3">
              <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold mb-1">Could not load posture data</p>
                <p className="text-sm">
                  Please try again later or use the <Link className="underline" to="/contact">contact form</Link> for the current posture.
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="py-12 bg-surface">
            <div className="max-w-6xl mx-auto px-6 lg:px-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="font-display text-2xl font-bold text-text-primary">
                  Compliance frameworks
                </h2>
                <span className="text-xs text-text-primary/50 font-body">
                  Generated {new Date(posture.generated_at).toLocaleString()}
                </span>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                {posture.frameworks.map((f) => (
                  <div
                    key={f.key}
                    className="bg-surface-secondary rounded-xl border border-border/30 p-5"
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <h3 className="font-display text-base font-semibold text-text-primary">
                        {f.name}
                      </h3>
                      <span
                        className={`inline-block text-xs font-medium px-2 py-0.5 rounded ${statusBadgeClasses(
                          f.status,
                        )}`}
                      >
                        {f.status_label}
                      </span>
                    </div>
                    <p className="text-xs text-text-primary/60 font-body mb-2">{f.scope}</p>
                    <p className="text-sm text-text-primary/75 font-body leading-relaxed mb-3">
                      {f.description}
                    </p>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="inline-flex items-center gap-1 text-text-primary/50">
                        <Clock className="h-3 w-3" />
                        Reviewed {f.last_reviewed}
                      </span>
                      {f.evidence_url ? (
                        <Link
                          to={f.evidence_url}
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          <FileText className="h-3 w-3" />
                          Evidence
                        </Link>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="py-12 bg-surface-secondary">
            <div className="max-w-6xl mx-auto px-6 lg:px-8 grid md:grid-cols-2 gap-6">
              <div className="bg-surface rounded-xl border border-border/30 p-6">
                <div className="flex items-center gap-2 mb-3">
                  <AlertCircle className="h-5 w-5 text-accent" />
                  <h3 className="font-display text-lg font-semibold text-text-primary">
                    Business Associate Agreement (BAA)
                  </h3>
                </div>
                <p className="text-sm text-text-primary/75 font-body mb-3">
                  {posture.baa.notes}
                </p>
                <ul className="text-sm text-text-primary/70 font-body space-y-1.5">
                  <li>
                    <span className="font-medium text-text-primary">Available:</span>{' '}
                    {posture.baa.available ? 'Yes' : 'No'}
                  </li>
                  <li>
                    <span className="font-medium text-text-primary">Eligible plans:</span>{' '}
                    {posture.baa.plans.length > 0 ? posture.baa.plans.join(', ') : 'None approved'}
                  </li>
                  <li>
                    <span className="font-medium text-text-primary">Contact:</span>{' '}
                    <ContactLink value={posture.baa.contact} />
                  </li>
                </ul>
              </div>

              <div className="bg-surface rounded-xl border border-border/30 p-6">
                <div className="flex items-center gap-2 mb-3">
                  <Map className="h-5 w-5 text-primary" />
                  <h3 className="font-display text-lg font-semibold text-text-primary">
                    Data residency
                  </h3>
                </div>
                <p className="text-sm text-text-primary/75 font-body mb-3">
                  {posture.data_residency.description}
                </p>
                <p className="text-sm text-text-primary/70 font-body">
                  <span className="font-medium text-text-primary">Primary region:</span>{' '}
                  {posture.data_residency.primary_region}
                </p>
              </div>
            </div>
          </section>

          <section className="py-12 bg-surface">
            <div className="max-w-6xl mx-auto px-6 lg:px-8">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-display text-2xl font-bold text-text-primary">
                  Sub-processors
                </h2>
                <Link
                  to="/subprocessors"
                  className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                >
                  Full list
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
              {posture.subprocessors.length === 0 ? (
                <p className="text-sm text-text-primary/60 font-body">
                  No active sub-processors are currently published.
                </p>
              ) : (
                <div className="bg-surface rounded-xl border border-border/30 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-secondary/50 border-b border-border/30">
                      <tr>
                        <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">
                          Name
                        </th>
                        <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">
                          Purpose
                        </th>
                        <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">
                          Data types
                        </th>
                        <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">
                          Location
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {posture.subprocessors.map((s) => (
                        <tr
                          key={s.id}
                          className="border-b border-border/20 last:border-0"
                        >
                          <td className="px-5 py-4 font-medium text-text-primary">
                            {s.website ? (
                              <a
                                href={s.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 hover:text-primary"
                              >
                                {s.name}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              s.name
                            )}
                          </td>
                          <td className="px-5 py-4 text-text-primary/70 text-xs">
                            {s.purpose}
                          </td>
                          <td className="px-5 py-4 text-text-primary/70 text-xs">
                            {s.data_types}
                          </td>
                          <td className="px-5 py-4 text-text-primary/70 text-xs">
                            {s.location}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="py-12 bg-surface-secondary">
            <div className="max-w-6xl mx-auto px-6 lg:px-8">
              <h2 className="font-display text-2xl font-bold text-text-primary mb-6">
                Documents
              </h2>
              <div className="grid sm:grid-cols-2 gap-3">
                {posture.documents.map((d) => (
                  <Link
                    key={d.url}
                    to={d.url}
                    className="bg-surface border border-border/30 hover:border-primary/40 rounded-lg p-4 flex items-center gap-3 transition-colors"
                  >
                    <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary truncate">
                        {d.name}
                      </p>
                      <p className="text-xs text-text-primary/55 font-body uppercase tracking-wide">
                        {d.kind}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </section>

          <section className="py-12 bg-sidebar-bg text-white">
            <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
              {/* Defensive text-white: QVO base reset targets h1-h5. */}
              <h3 className="font-display text-white text-xl font-semibold mb-2">
                Need something more specific?
              </h3>
              <p className="text-white/70 font-body mb-4">
                Procurement reviews, security questionnaires, and healthcare agreement requests use the{' '}
                <ContactLink value={posture.organization.contact_security} />.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
