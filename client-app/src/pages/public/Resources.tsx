import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, ArrowRight, BookOpen, Clock, Compass } from 'lucide-react';
import RevealSection from '../../components/RevealSection';
import { guides, categories, type GuideCategory } from '../../data/guides';
import { searchMarketingPages } from '../../data/marketingPages';

export default function Resources() {
  const { t } = useTranslation();
  const { t: tm } = useTranslation('marketing');
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

  const marketingMatches = search.trim() ? searchMarketingPages(search) : [];

  return (
    <div>
      <section className="bg-sidebar-bg text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {tm('resources.hero.eyebrow')}
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              {tm('resources.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              {tm('resources.hero.description')}
            </p>
          </div>
          <div className="mt-10 max-w-md relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
            <input
              type="text"
              placeholder={t('resources.search_placeholder')}
              aria-label={t('resources.search_aria')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-11 pr-4 py-3 bg-white/10 border border-white/15 rounded-xl text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50"
            />
          </div>
        </div>
      </section>

      <section className="py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="flex items-center gap-3 mb-8">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <BookOpen className="h-5 w-5 text-primary" />
              </div>
              <h2 className="font-display text-2xl font-bold text-text-primary">{tm('resources.browse_by_category')}</h2>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-16">
              {categories.map((cat) => (
                <button
                  key={cat.name}
                  onClick={() => setActiveCategory(activeCategory === cat.name ? 'All' : cat.name)}
                  className={`text-left p-5 rounded-2xl border transition-all ${
                    activeCategory === cat.name
                      ? 'bg-primary/10 border-primary/30 shadow-sm'
                      : 'bg-white border-border/50 hover:border-primary/30 hover:shadow-sm hover:-translate-y-0.5'
                  }`}
                >
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center mb-3">
                    <cat.icon className="h-4 w-4 text-primary" />
                  </div>
                  <h3 className="font-display text-sm font-semibold text-text-primary mb-1">{cat.name}</h3>
                  <p className="text-xs text-text-primary/50 leading-relaxed font-body">{cat.description}</p>
                </button>
              ))}
            </div>
          </RevealSection>

          {marketingMatches.length > 0 && (
            <RevealSection className="mb-12">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-sidebar-bg/10 flex items-center justify-center">
                  <Compass className="h-5 w-5 text-text-primary" />
                </div>
                <div>
                  <h2 className="font-display text-2xl font-bold text-text-primary">
                    {t('resources.pages_heading')}
                  </h2>
                  <p className="text-sm text-text-primary/60 font-body">
                    {t('resources.pages_match_count', {
                      count: marketingMatches.length,
                      query: search,
                    })}
                  </p>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {marketingMatches.map((page) => {
                  const Icon = page.icon;
                  return (
                    <Link
                      key={page.slug}
                      to={page.path}
                      className="group bg-white rounded-2xl border border-border/50 p-5 hover:border-primary/30 hover:shadow-md hover:-translate-y-0.5 transition-all"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="w-9 h-9 rounded-lg bg-sidebar-bg/10 flex items-center justify-center">
                          <Icon className="h-4 w-4 text-text-primary" />
                        </div>
                        <span className="text-[11px] text-text-primary bg-sidebar-bg/10 px-2 py-0.5 rounded-full font-medium uppercase tracking-wider">
                          {page.category}
                        </span>
                      </div>
                      <h3 className="font-display text-base font-semibold text-text-primary mb-1 group-hover:text-primary transition-colors">
                        {page.title}
                      </h3>
                      <p className="text-xs text-text-primary/60 leading-relaxed font-body line-clamp-2">
                        {page.description}
                      </p>
                    </Link>
                  );
                })}
              </div>
            </RevealSection>
          )}

          <RevealSection>
            <div className="flex items-center justify-between mb-8">
              <h2 className="font-display text-2xl font-bold text-text-primary">
                {activeCategory === 'All' ? tm('resources.all_guides') : activeCategory}
              </h2>
              {activeCategory !== 'All' && (
                <button
                  onClick={() => setActiveCategory('All')}
                  className="text-sm text-primary hover:text-primary-hover font-medium transition-colors"
                >
                  {tm('resources.show_all')}
                </button>
              )}
            </div>

            {filtered.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-text-primary/50 font-body">{tm('resources.no_guides')}</p>
              </div>
            ) : (
              <div className="grid md:grid-cols-2 gap-6">
                {filtered.map((guide) => (
                  <Link
                    key={guide.slug}
                    to={`/resources/${guide.slug}`}
                    className="group bg-white rounded-2xl border border-border/50 p-7 hover:border-primary/30 hover:shadow-lg hover:-translate-y-1 transition-all"
                  >
                    <div className="flex items-start justify-between mb-4">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                        <guide.icon className="h-5 w-5 text-primary" />
                      </div>
                      <span className="text-xs text-primary bg-primary/10 px-2.5 py-1 rounded-full font-medium">
                        {guide.category}
                      </span>
                    </div>
                    <h3 className="font-display text-lg font-semibold text-text-primary mb-2 group-hover:text-primary transition-colors">
                      {guide.title}
                    </h3>
                    <p className="text-sm text-text-primary/60 leading-relaxed font-body mb-4">
                      {guide.description}
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs text-text-primary/40">
                        <Clock className="h-3.5 w-3.5" />
                        {guide.readTime}
                      </span>
                      <span className="flex items-center gap-1 text-sm text-primary font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                        {tm('resources.read_guide')}
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
              <div className="bg-white rounded-2xl border border-border/50 p-8 flex flex-col md:flex-row items-center gap-6">
                <div className="w-14 h-14 rounded-2xl bg-sidebar-bg/10 flex items-center justify-center shrink-0">
                  <BookOpen className="h-7 w-7 text-text-primary" />
                </div>
                <div className="flex-1 text-center md:text-left">
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-1">
                    {tm('resources.api_card.title')}
                  </h3>
                  <p className="text-sm text-text-primary/60 font-body">
                    {tm('resources.api_card.desc')}
                  </p>
                </div>
                <Link
                  to="/docs"
                  className="inline-flex items-center gap-2 bg-sidebar-bg hover:bg-sidebar-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors shrink-0"
                >
                  {tm('resources.api_card.cta')}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </RevealSection>
          )}
        </div>
      </section>

      <section className="bg-sidebar-bg text-white py-16">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold mb-4">
            {tm('resources.bottom_cta.title')}
          </h2>
          <p className="text-white/60 font-body mb-8">
            {tm('resources.bottom_cta.subtitle')}
          </p>
          <Link
            to="/contact"
            className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
          >
            {tm('resources.bottom_cta.cta')}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
