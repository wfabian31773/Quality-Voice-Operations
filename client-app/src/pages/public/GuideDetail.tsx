import { useParams, Link, Navigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Clock, BookOpen, List } from 'lucide-react';
import { useState } from 'react';
import RevealSection from '../../components/RevealSection';
import { getGuideBySlug, getAdjacentGuides } from '../../data/guides';

export default function GuideDetail() {
  const { slug } = useParams<{ slug: string }>();
  const [tocOpen, setTocOpen] = useState(false);
  const guide = slug ? getGuideBySlug(slug) : undefined;
  const adjacent = slug ? getAdjacentGuides(slug) : { prev: undefined, next: undefined };

  if (!guide) {
    return <Navigate to="/resources" replace />;
  }

  const scrollToSection = (idx: number) => {
    const el = document.getElementById(`section-${idx}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTocOpen(false);
    }
  };

  return (
    <div>
      <section className="bg-harbor text-white py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <Link
            to="/resources"
            className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-white transition-colors mb-8"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Resources
          </Link>
          <div className="max-w-3xl">
            <span className="text-xs text-teal bg-teal/15 px-2.5 py-1 rounded-full font-medium">
              {guide.category}
            </span>
            <h1 className="font-display text-3xl lg:text-4xl font-bold leading-tight mt-4 mb-4">
              {guide.title}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              {guide.description}
            </p>
            <div className="flex items-center gap-4 mt-6 text-sm text-white/50">
              <span className="flex items-center gap-1.5">
                <Clock className="h-4 w-4" />
                {guide.readTime}
              </span>
              <span className="flex items-center gap-1.5">
                <BookOpen className="h-4 w-4" />
                {guide.content.length} sections
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-12 lg:py-16">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex flex-col lg:flex-row gap-12">
            <aside className="lg:w-64 shrink-0">
              <div className="lg:sticky lg:top-24">
                <button
                  className="lg:hidden flex items-center gap-2 text-sm font-medium text-harbor mb-4"
                  onClick={() => setTocOpen(!tocOpen)}
                >
                  <List className="h-4 w-4" />
                  Table of contents
                </button>
                <nav className={`${tocOpen ? 'block' : 'hidden'} lg:block`}>
                  <h3 className="font-display text-xs font-semibold text-slate-ink/40 uppercase tracking-wider mb-4">
                    In this guide
                  </h3>
                  <ul className="space-y-1.5">
                    {guide.content.map((section, idx) => (
                      <li key={idx}>
                        <button
                          onClick={() => scrollToSection(idx)}
                          className="text-left w-full text-sm text-slate-ink/60 hover:text-teal font-body px-3 py-1.5 rounded-lg hover:bg-teal/5 transition-colors"
                        >
                          {section.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
              </div>
            </aside>

            <div className="flex-1 min-w-0 max-w-3xl">
              {guide.content.map((section, idx) => (
                <RevealSection key={idx}>
                  <div id={`section-${idx}`} className="mb-12 scroll-mt-24">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-8 h-8 rounded-lg bg-teal text-white font-display text-sm font-bold flex items-center justify-center">
                        {idx + 1}
                      </div>
                      <h2 className="font-display text-xl font-bold text-harbor">
                        {section.title}
                      </h2>
                    </div>
                    <div className="prose prose-slate max-w-none">
                      {section.body.split('\n\n').map((paragraph, pIdx) => {
                        if (paragraph.startsWith('- **')) {
                          const items = paragraph.split('\n');
                          return (
                            <ul key={pIdx} className="space-y-2 my-4">
                              {items.map((item, iIdx) => {
                                const match = item.match(/^- \*\*(.+?)\*\*:?\s*(.*)/);
                                if (match) {
                                  return (
                                    <li key={iIdx} className="flex gap-2 text-sm text-slate-ink/70 font-body leading-relaxed">
                                      <span className="text-teal mt-0.5">•</span>
                                      <span>
                                        <strong className="text-harbor font-semibold">{match[1]}</strong>
                                        {match[2] ? `: ${match[2]}` : ''}
                                      </span>
                                    </li>
                                  );
                                }
                                return (
                                  <li key={iIdx} className="flex gap-2 text-sm text-slate-ink/70 font-body leading-relaxed">
                                    <span className="text-teal mt-0.5">•</span>
                                    <span>{item.replace(/^- /, '')}</span>
                                  </li>
                                );
                              })}
                            </ul>
                          );
                        }
                        return (
                          <p key={pIdx} className="text-sm text-slate-ink/70 leading-relaxed font-body mb-4">
                            {paragraph}
                          </p>
                        );
                      })}
                    </div>
                    {section.code && (
                      <div className="mt-4 bg-harbor rounded-xl p-5 overflow-x-auto">
                        <pre className="text-sm text-white/80 font-mono leading-relaxed whitespace-pre-wrap">
                          {section.code}
                        </pre>
                      </div>
                    )}
                  </div>
                </RevealSection>
              ))}

              <div className="border-t border-soft-steel/50 pt-8 mt-8">
                <div className="flex flex-col sm:flex-row justify-between gap-4">
                  {adjacent.prev ? (
                    <Link
                      to={`/resources/${adjacent.prev.slug}`}
                      className="group flex items-center gap-3 bg-white rounded-xl border border-soft-steel/50 p-4 hover:border-teal/30 hover:shadow-md transition-all flex-1"
                    >
                      <ArrowLeft className="h-4 w-4 text-slate-ink/40 group-hover:text-teal transition-colors shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs text-slate-ink/40 font-body">Previous</p>
                        <p className="text-sm font-semibold text-harbor truncate">{adjacent.prev.title}</p>
                      </div>
                    </Link>
                  ) : (
                    <div />
                  )}
                  {adjacent.next ? (
                    <Link
                      to={`/resources/${adjacent.next.slug}`}
                      className="group flex items-center justify-end gap-3 bg-white rounded-xl border border-soft-steel/50 p-4 hover:border-teal/30 hover:shadow-md transition-all flex-1 text-right"
                    >
                      <div className="min-w-0">
                        <p className="text-xs text-slate-ink/40 font-body">Next</p>
                        <p className="text-sm font-semibold text-harbor truncate">{adjacent.next.title}</p>
                      </div>
                      <ArrowRight className="h-4 w-4 text-slate-ink/40 group-hover:text-teal transition-colors shrink-0" />
                    </Link>
                  ) : (
                    <div />
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
