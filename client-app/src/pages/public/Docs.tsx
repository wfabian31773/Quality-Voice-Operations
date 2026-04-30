import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Search, ArrowRight, Sparkles } from 'lucide-react';
import SEO from '../../components/SEO';
import { DocsSidebar } from '../../components/DocsSidebar';
import { docCategories, docArticles } from '../../data/docs';
import {
  useArticleMetaTranslator,
  useDocCategoryTranslator,
  useSearchDocs,
} from '../../lib/translateDoc';

export default function Docs() {
  const [query, setQuery] = useState('');
  const searchDocs = useSearchDocs();
  const results = useMemo(
    () => (query ? searchDocs(query).slice(0, 12) : []),
    [query, searchDocs],
  );
  const translateMeta = useArticleMetaTranslator();
  const translateCategory = useDocCategoryTranslator();

  return (
    <div>
      <SEO
        title="Documentation — QVO"
        description="Get started with QVO: setup guides, agent builder, workflows, integrations, API reference, and troubleshooting."
        canonicalPath="/docs"
        structuredData={{
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'QVO Docs',
          url: 'https://qvo.ai/docs',
          potentialAction: {
            '@type': 'SearchAction',
            target: 'https://qvo.ai/docs?q={search_term_string}',
            'query-input': 'required name=search_term_string',
          },
        }}
      />

      <section className="bg-sidebar-bg text-white py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
              Documentation
            </p>
            <h1 className="font-display text-3xl lg:text-5xl font-bold leading-tight mb-4">
              Build, ship, and scale on QVO.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              Setup guides, the agent builder, workflows, integrations, API reference, and troubleshooting — everything you need in one place.
            </p>
          </div>
          <div className="mt-8 max-w-xl relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
            <input
              type="search"
              placeholder="Search the docs..."
              aria-label="Search the docs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-11 pr-4 py-3 bg-white/10 border border-white/15 rounded-xl text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50"
            />
            {query && (
              <div className="absolute top-full mt-2 left-0 right-0 bg-white rounded-xl border border-border/50 shadow-2xl max-h-96 overflow-y-auto z-30">
                {results.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-text-primary/50 font-body">No matches for "{query}".</p>
                ) : (
                  <ul>
                    {results.map((r) => {
                      const meta = translateMeta(r);
                      return (
                        <li key={r.slug}>
                          <Link
                            to={`/docs/${r.slug}`}
                            onClick={() => setQuery('')}
                            className="block px-4 py-3 hover:bg-primary/5 transition-colors border-b border-border/30 last:border-b-0"
                          >
                            <p className="text-sm font-semibold text-text-primary">{meta.title}</p>
                            <p className="text-xs text-text-primary/60 font-body line-clamp-1 mt-0.5">{meta.description}</p>
                            <p className="text-[10px] text-primary uppercase tracking-wider mt-1 font-semibold">{r.category.replace('-', ' ')}</p>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="py-12 lg:py-16">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex flex-col lg:flex-row gap-10">
            <aside className="lg:w-64 shrink-0">
              <div className="lg:sticky lg:top-24">
                <DocsSidebar />
              </div>
            </aside>

            <div className="flex-1 min-w-0">
              <div className="bg-gradient-to-br from-primary/10 to-sidebar-bg/5 border border-primary/20 rounded-2xl p-6 mb-10 flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
                  <Sparkles className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1">
                  <h2 className="font-display text-lg font-bold text-text-primary mb-1">New to QVO?</h2>
                  <p className="text-sm text-text-primary/70 font-body mb-3">
                    Start with the quickstart — sign up, create an agent, and answer your first call in under 10 minutes.
                  </p>
                  <Link
                    to="/docs/quickstart"
                    className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary-hover"
                  >
                    Read the quickstart
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>

              <div className="space-y-10">
                {docCategories.map((cat) => {
                  const articles = docArticles.filter((a) => a.category === cat.slug);
                  if (articles.length === 0) return null;
                  const Icon = cat.icon;
                  const catText = translateCategory(cat);
                  return (
                    <section key={cat.slug} id={cat.slug} className="scroll-mt-24">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                          <Icon className="h-4.5 w-4.5 text-primary" />
                        </div>
                        <h2 className="font-display text-xl font-bold text-text-primary">{catText.title}</h2>
                      </div>
                      <p className="text-sm text-text-primary/60 font-body mb-4 ml-12">{catText.description}</p>
                      <div className="grid sm:grid-cols-2 gap-3">
                        {articles.map((a) => {
                          const meta = translateMeta(a);
                          return (
                            <Link
                              key={a.slug}
                              to={`/docs/${a.slug}`}
                              className="group bg-white rounded-xl border border-border/50 p-4 hover:border-primary/40 hover:shadow-sm transition-all"
                            >
                              <p className="font-display text-sm font-semibold text-text-primary group-hover:text-primary transition-colors">
                                {meta.title}
                              </p>
                              <p className="text-xs text-text-primary/60 font-body mt-1 leading-relaxed line-clamp-2">
                                {meta.description}
                              </p>
                              <p className="text-[10px] text-text-primary/40 mt-2 uppercase tracking-wider">{a.readTime}</p>
                            </Link>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-sidebar-bg text-white py-12">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-xl font-bold mb-3">Still need help?</h2>
          <p className="text-white/70 font-body mb-6 text-sm">
            Our support team replies within one business day. Enterprise customers get prioritized routing.
          </p>
          <Link
            to="/contact"
            className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
          >
            Contact support
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
