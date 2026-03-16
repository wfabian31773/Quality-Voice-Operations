import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, ArrowRight, BookOpen, Clock } from 'lucide-react';
import RevealSection from '../../components/RevealSection';
import { guides, categories, type GuideCategory } from '../../data/guides';

export default function Resources() {
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<GuideCategory | 'All'>('All');

  const filtered = guides.filter((g) => {
    const matchesCategory = activeCategory === 'All' || g.category === activeCategory;
    const matchesSearch =
      !search ||
      g.title.toLowerCase().includes(search.toLowerCase()) ||
      g.description.toLowerCase().includes(search.toLowerCase()) ||
      g.category.toLowerCase().includes(search.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <div>
      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Resources
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Guides &amp; documentation.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              Step-by-step guides, integration tutorials, and best practices to help you get the most from QVO.
            </p>
          </div>
          <div className="mt-10 max-w-md relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
            <input
              type="text"
              placeholder="Search guides..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-11 pr-4 py-3 bg-white/10 border border-white/15 rounded-xl text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-teal/50 focus:border-teal/50"
            />
          </div>
        </div>
      </section>

      <section className="py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="flex items-center gap-3 mb-8">
              <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center">
                <BookOpen className="h-5 w-5 text-teal" />
              </div>
              <h2 className="font-display text-2xl font-bold text-harbor">Browse by category</h2>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-16">
              {categories.map((cat) => (
                <button
                  key={cat.name}
                  onClick={() => setActiveCategory(activeCategory === cat.name ? 'All' : cat.name)}
                  className={`text-left p-5 rounded-2xl border transition-all ${
                    activeCategory === cat.name
                      ? 'bg-teal/10 border-teal/30 shadow-sm'
                      : 'bg-white border-soft-steel/50 hover:border-teal/30 hover:shadow-sm hover:-translate-y-0.5'
                  }`}
                >
                  <div className="w-9 h-9 rounded-lg bg-teal/10 flex items-center justify-center mb-3">
                    <cat.icon className="h-4 w-4 text-teal" />
                  </div>
                  <h3 className="font-display text-sm font-semibold text-harbor mb-1">{cat.name}</h3>
                  <p className="text-xs text-slate-ink/50 leading-relaxed font-body">{cat.description}</p>
                </button>
              ))}
            </div>
          </RevealSection>

          <RevealSection>
            <div className="flex items-center justify-between mb-8">
              <h2 className="font-display text-2xl font-bold text-harbor">
                {activeCategory === 'All' ? 'All guides' : activeCategory}
              </h2>
              {activeCategory !== 'All' && (
                <button
                  onClick={() => setActiveCategory('All')}
                  className="text-sm text-teal hover:text-teal-hover font-medium transition-colors"
                >
                  Show all
                </button>
              )}
            </div>

            {filtered.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-slate-ink/50 font-body">No guides match your search. Try a different term.</p>
              </div>
            ) : (
              <div className="grid md:grid-cols-2 gap-6">
                {filtered.map((guide) => (
                  <Link
                    key={guide.slug}
                    to={`/resources/${guide.slug}`}
                    className="group bg-white rounded-2xl border border-soft-steel/50 p-7 hover:border-teal/30 hover:shadow-lg hover:-translate-y-1 transition-all"
                  >
                    <div className="flex items-start justify-between mb-4">
                      <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center">
                        <guide.icon className="h-5 w-5 text-teal" />
                      </div>
                      <span className="text-xs text-teal bg-teal/10 px-2.5 py-1 rounded-full font-medium">
                        {guide.category}
                      </span>
                    </div>
                    <h3 className="font-display text-lg font-semibold text-harbor mb-2 group-hover:text-teal transition-colors">
                      {guide.title}
                    </h3>
                    <p className="text-sm text-slate-ink/60 leading-relaxed font-body mb-4">
                      {guide.description}
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs text-slate-ink/40">
                        <Clock className="h-3.5 w-3.5" />
                        {guide.readTime}
                      </span>
                      <span className="flex items-center gap-1 text-sm text-teal font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                        Read guide
                        <ArrowRight className="h-3.5 w-3.5" />
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </RevealSection>

          {activeCategory === 'All' && !search && (
            <RevealSection className="mt-16">
              <div className="bg-white rounded-2xl border border-soft-steel/50 p-8 flex flex-col md:flex-row items-center gap-6">
                <div className="w-14 h-14 rounded-2xl bg-harbor/10 flex items-center justify-center shrink-0">
                  <BookOpen className="h-7 w-7 text-harbor" />
                </div>
                <div className="flex-1 text-center md:text-left">
                  <h3 className="font-display text-lg font-semibold text-harbor mb-1">
                    Looking for API reference?
                  </h3>
                  <p className="text-sm text-slate-ink/60 font-body">
                    Full API documentation with endpoints, authentication, and code examples.
                  </p>
                </div>
                <Link
                  to="/docs"
                  className="inline-flex items-center gap-2 bg-harbor hover:bg-harbor-light text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors shrink-0"
                >
                  View API docs
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </RevealSection>
          )}
        </div>
      </section>

      <section className="bg-harbor text-white py-16">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold mb-4">
            Can't find what you're looking for?
          </h2>
          <p className="text-white/60 font-body mb-8">
            Our team is here to help you with setup, integration, and best practices.
          </p>
          <Link
            to="/contact"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
          >
            Contact us
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
