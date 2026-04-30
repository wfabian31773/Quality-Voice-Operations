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
      <section className="bg-sidebar-bg text-white py-16">
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <h1 className="font-display text-4xl font-bold mb-3">Sub-processors</h1>
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
