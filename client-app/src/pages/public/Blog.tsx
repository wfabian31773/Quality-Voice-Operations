import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, Clock, ArrowRight } from 'lucide-react';
import SEO from '../../components/SEO';
import { blogArticles, blogCategories } from '../../data/blogArticles';

export default function Blog() {
  const [activeCategory, setActiveCategory] = useState('All');

  const filtered =
    activeCategory === 'All'
      ? blogArticles
      : blogArticles.filter((a) => a.category === activeCategory);

  return (
    <>
      <SEO
        title="Blog — AI Voice Agent Insights & Guides"
        description="Expert articles on AI voice agents, call center automation, and voice AI best practices for small businesses. Tips, guides, and industry insights from the QVO team."
        canonicalPath="/blog"
      />

      <section className="bg-sidebar-bg text-white py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 text-center">
          <h1 className="font-display text-4xl md:text-5xl font-bold mb-4">
            The QVO Blog
          </h1>
          <p className="text-lg text-white/70 max-w-2xl mx-auto">
            Insights, guides, and best practices for AI-powered voice operations.
          </p>
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-6 lg:px-8 py-16">
        <div className="flex flex-wrap gap-2 mb-10">
          {blogCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                activeCategory === cat
                  ? 'bg-primary text-white'
                  : 'bg-surface text-text-secondary hover:bg-surface-hover border border-border'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <p className="text-center text-text-muted py-12">
            No articles in this category yet.
          </p>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {filtered.map((article) => (
              <Link
                key={article.slug}
                to={`/blog/${article.slug}`}
                className="group bg-surface rounded-xl border border-border overflow-hidden hover:shadow-lg transition-shadow"
              >
                {article.headerImage && (
                  <div className="aspect-[16/9] overflow-hidden">
                    <img
                      src={article.headerImage}
                      alt={`${article.title} header image`}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
                    />
                  </div>
                )}
                <div className="p-6 flex flex-col h-full">
                  <span className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">
                    {article.category}
                  </span>
                  <h2 className="font-display text-xl font-bold text-text-primary mb-3 group-hover:text-primary transition-colors">
                    {article.title}
                  </h2>
                  <p className="text-sm text-text-secondary leading-relaxed mb-4 flex-1">
                    {article.excerpt}
                  </p>
                  <div className="flex items-center justify-between text-xs text-text-muted pt-4 border-t border-border">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5" />
                        {new Date(article.date).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        {article.readTime} min read
                      </span>
                    </div>
                    <ArrowRight className="h-4 w-4 text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
