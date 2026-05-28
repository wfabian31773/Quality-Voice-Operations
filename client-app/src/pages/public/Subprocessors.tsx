import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import SEO from '../../components/SEO';
import { trackPageView } from '../../lib/analytics';

interface Subprocessor {
  id: string;
  name: string;
  purpose: string;
  data_types: string;
  location: string;
  website: string | null;
  added_at: string;
  updated_at: string;
}

export default function Subprocessors() {
  const [subprocessors, setSubprocessors] = useState<Subprocessor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trackPageView('/subprocessors');
    fetch('/api/public/subprocessors')
      .then((r) => r.json())
      .then((data) => setSubprocessors(data.subprocessors ?? []))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="bg-surface">
      <SEO title="Sub-processors — QVO" description="Third-party services QVO uses to deliver the platform." canonicalPath="/subprocessors" />
      {/*
        Subprocessors hero — flat dark band placeholder. Wayne's bespoke
        Higgsfield render slots in here later (drop file at
        /hero/subprocessors-hero.{webp,mp4} and add a <picture>/<video>
        above the gradient layer). Until then:
          - radial-gradient backdrop at 45% 50% (off-center)
          - oversize tracking-tight headline (text-5xl @ lg)
          - explicit text-white on h1 — defensive against the QVO base
            reset h1 color rule that renders headlines invisible on dark
            surfaces (same bug we fixed on /demo, /pricing, /features)
        Padding stayed py-16 — this hero is a short legal-section
        opener, not a tall marketing hero.
      */}
      <section className="relative overflow-hidden bg-sidebar-bg text-white py-16">
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 70% 60% at 45% 50%, rgba(46,140,131,0.20), transparent 70%)',
          }}
        />
        <div className="relative max-w-5xl mx-auto px-6 lg:px-8">
          <h1 className="font-display text-white text-4xl lg:text-5xl font-bold tracking-tight mb-3">Sub-processors</h1>
          <p className="text-white/70 font-body max-w-2xl">
            QVO engages the following sub-processors to deliver the Service. We update this list when sub-processors are added or removed and notify customers in advance of material changes.
          </p>
        </div>
      </section>

      <section className="py-16">
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          {loading ? (
            <div className="text-center py-12 text-text-primary/50 font-body">Loading…</div>
          ) : error ? (
            <div className="bg-danger/10 text-danger px-4 py-3 rounded-lg text-sm">
              Could not load sub-processors. Please try again later.
            </div>
          ) : (
            <div className="bg-surface rounded-xl border border-border/30 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface-secondary/50 border-b border-border/30">
                  <tr>
                    <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">Sub-processor</th>
                    <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">Purpose</th>
                    <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">Data types</th>
                    <th className="text-left px-5 py-3 font-display text-text-primary font-semibold">Location</th>
                  </tr>
                </thead>
                <tbody>
                  {subprocessors.map((s) => (
                    <tr key={s.id} className="border-b border-border/20 last:border-0">
                      <td className="px-5 py-4 font-medium text-text-primary">
                        {s.website ? (
                          <a href={s.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-primary">
                            {s.name}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : s.name}
                      </td>
                      <td className="px-5 py-4 text-text-primary/70 text-xs">{s.purpose}</td>
                      <td className="px-5 py-4 text-text-primary/70 text-xs">{s.data_types}</td>
                      <td className="px-5 py-4 text-text-primary/70 text-xs">{s.location}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-text-primary/50 font-body mt-6">
            To subscribe to sub-processor change notifications, contact privacy@qvo.example.
          </p>
        </div>
      </section>
    </div>
  );
}
