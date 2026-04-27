import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Shield,
  CheckCircle2,
  Clock,
  Map,
  Download,
  ExternalLink,
  FileText,
  AlertCircle,
} from 'lucide-react';
import SEO from '../../components/SEO';
import { trackPageView } from '../../lib/analytics';

type FrameworkStatus =
  | 'compliant'
  | 'in_progress'
  | 'available'
  | 'roadmap'
  | 'not_applicable';

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
    primary_region: string;
    description: string;
  };
  subprocessors: PostureSubprocessor[];
  documents: { name: string; url: string; kind: 'dpa' | 'list' | 'page' }[];
}

function statusBadgeClasses(status: FrameworkStatus): string {
  switch (status) {
    case 'compliant':
    case 'available':
      return 'bg-calm-green/15 text-calm-green';
    case 'in_progress':
      return 'bg-warm-amber/15 text-warm-amber';
    case 'roadmap':
      return 'bg-soft-steel/30 text-slate-ink/60';
    default:
      return 'bg-soft-steel/30 text-slate-ink/60';
  }
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
    <div className="bg-white">
      <SEO
        title="Security Posture — QVO"
        description="QVO's compliance posture: SOC 2, HIPAA (with BAA), GDPR, CCPA, sub-processors, and data residency."
        canonicalPath="/security/posture"
      />

      <section className="bg-harbor text-white py-16">
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <div className="inline-flex items-center gap-2 bg-teal/15 border border-teal/25 rounded-full px-4 py-1.5 mb-6">
            <Shield className="h-4 w-4 text-teal" />
            <span className="text-sm font-medium text-teal">Security Posture</span>
          </div>
          <h1 className="font-display text-4xl lg:text-5xl font-bold mb-4">
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
              className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg font-medium"
            >
              <Download className="h-4 w-4" />
              View JSON
            </a>
            <Link
              to="/security"
              className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg font-medium"
            >
              Security overview
            </Link>
            <Link
              to="/subprocessors"
              className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg font-medium"
            >
              Sub-processors
            </Link>
          </div>
        </div>
      </section>

      {loading ? (
        <section className="py-20">
          <div className="max-w-5xl mx-auto px-6 lg:px-8 text-center text-slate-ink/50 font-body">
            Loading posture…
          </div>
        </section>
      ) : error || !posture ? (
        <section className="py-20">
          <div className="max-w-3xl mx-auto px-6 lg:px-8">
            <div className="bg-controlled-red/10 border border-controlled-red/30 text-controlled-red px-5 py-4 rounded-lg flex items-start gap-3">
              <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold mb-1">Could not load posture data</p>
                <p className="text-sm">
                  Please try again later, or email{' '}
                  <a className="underline" href="mailto:security@qvo.example">
                    security@qvo.example
                  </a>{' '}
                  for the current posture.
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="py-12 bg-white">
            <div className="max-w-6xl mx-auto px-6 lg:px-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="font-display text-2xl font-bold text-harbor">
                  Compliance frameworks
                </h2>
                <span className="text-xs text-slate-ink/50 font-body">
                  Generated {new Date(posture.generated_at).toLocaleString()}
                </span>
              </div>
              <div className="grid md:grid-cols-2 gap-4">
                {posture.frameworks.map((f) => (
                  <div
                    key={f.key}
                    className="bg-mist rounded-xl border border-soft-steel/30 p-5"
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <h3 className="font-display text-base font-semibold text-harbor">
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
                    <p className="text-xs text-slate-ink/60 font-body mb-2">{f.scope}</p>
                    <p className="text-sm text-slate-ink/75 font-body leading-relaxed mb-3">
                      {f.description}
                    </p>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="inline-flex items-center gap-1 text-slate-ink/50">
                        <Clock className="h-3 w-3" />
                        Reviewed {f.last_reviewed}
                      </span>
                      {f.evidence_url ? (
                        <Link
                          to={f.evidence_url}
                          className="inline-flex items-center gap-1 text-teal hover:underline"
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

          <section className="py-12 bg-mist">
            <div className="max-w-6xl mx-auto px-6 lg:px-8 grid md:grid-cols-2 gap-6">
              <div className="bg-white rounded-xl border border-soft-steel/30 p-6">
                <div className="flex items-center gap-2 mb-3">
                  <CheckCircle2 className="h-5 w-5 text-calm-green" />
                  <h3 className="font-display text-lg font-semibold text-harbor">
                    Business Associate Agreement (BAA)
                  </h3>
                </div>
                <p className="text-sm text-slate-ink/75 font-body mb-3">
                  {posture.baa.notes}
                </p>
                <ul className="text-sm text-slate-ink/70 font-body space-y-1.5">
                  <li>
                    <span className="font-medium text-harbor">Available:</span>{' '}
                    {posture.baa.available ? 'Yes' : 'No'}
                  </li>
                  <li>
                    <span className="font-medium text-harbor">Eligible plans:</span>{' '}
                    {posture.baa.plans.join(', ')}
                  </li>
                  <li>
                    <span className="font-medium text-harbor">Contact:</span>{' '}
                    <a
                      className="text-teal hover:underline"
                      href={`mailto:${posture.baa.contact}`}
                    >
                      {posture.baa.contact}
                    </a>
                  </li>
                </ul>
              </div>

              <div className="bg-white rounded-xl border border-soft-steel/30 p-6">
                <div className="flex items-center gap-2 mb-3">
                  <Map className="h-5 w-5 text-teal" />
                  <h3 className="font-display text-lg font-semibold text-harbor">
                    Data residency
                  </h3>
                </div>
                <p className="text-sm text-slate-ink/75 font-body mb-3">
                  {posture.data_residency.description}
                </p>
                <p className="text-sm text-slate-ink/70 font-body">
                  <span className="font-medium text-harbor">Primary region:</span>{' '}
                  {posture.data_residency.primary_region}
                </p>
              </div>
            </div>
          </section>

          <section className="py-12 bg-white">
            <div className="max-w-6xl mx-auto px-6 lg:px-8">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-display text-2xl font-bold text-harbor">
                  Sub-processors
                </h2>
                <Link
                  to="/subprocessors"
                  className="text-sm text-teal hover:underline inline-flex items-center gap-1"
                >
                  Full list
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
              {posture.subprocessors.length === 0 ? (
                <p className="text-sm text-slate-ink/60 font-body">
                  No active sub-processors are currently published.
                </p>
              ) : (
                <div className="bg-white rounded-xl border border-soft-steel/30 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-mist/50 border-b border-soft-steel/30">
                      <tr>
                        <th className="text-left px-5 py-3 font-display text-harbor font-semibold">
                          Name
                        </th>
                        <th className="text-left px-5 py-3 font-display text-harbor font-semibold">
                          Purpose
                        </th>
                        <th className="text-left px-5 py-3 font-display text-harbor font-semibold">
                          Data types
                        </th>
                        <th className="text-left px-5 py-3 font-display text-harbor font-semibold">
                          Location
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {posture.subprocessors.map((s) => (
                        <tr
                          key={s.id}
                          className="border-b border-soft-steel/20 last:border-0"
                        >
                          <td className="px-5 py-4 font-medium text-harbor">
                            {s.website ? (
                              <a
                                href={s.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 hover:text-teal"
                              >
                                {s.name}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              s.name
                            )}
                          </td>
                          <td className="px-5 py-4 text-slate-ink/70 text-xs">
                            {s.purpose}
                          </td>
                          <td className="px-5 py-4 text-slate-ink/70 text-xs">
                            {s.data_types}
                          </td>
                          <td className="px-5 py-4 text-slate-ink/70 text-xs">
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

          <section className="py-12 bg-mist">
            <div className="max-w-6xl mx-auto px-6 lg:px-8">
              <h2 className="font-display text-2xl font-bold text-harbor mb-6">
                Documents
              </h2>
              <div className="grid sm:grid-cols-2 gap-3">
                {posture.documents.map((d) => (
                  <Link
                    key={d.url}
                    to={d.url}
                    className="bg-white border border-soft-steel/30 hover:border-teal/40 rounded-lg p-4 flex items-center gap-3 transition-colors"
                  >
                    <FileText className="h-5 w-5 text-teal flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-harbor truncate">
                        {d.name}
                      </p>
                      <p className="text-xs text-slate-ink/55 font-body uppercase tracking-wide">
                        {d.kind}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </section>

          <section className="py-12 bg-harbor text-white">
            <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
              <h3 className="font-display text-xl font-semibold mb-2">
                Need something more specific?
              </h3>
              <p className="text-white/70 font-body mb-4">
                Procurement reviews, security questionnaires, and BAA requests
                go to{' '}
                <a
                  href={`mailto:${posture.organization.contact_security}`}
                  className="text-teal hover:underline"
                >
                  {posture.organization.contact_security}
                </a>
                .
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
