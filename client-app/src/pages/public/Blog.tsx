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

      <section className="bg-harbor text-white py-20">
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
                  ? 'bg-teal text-white'
                  : 'bg-white text-slate-600 hover:bg-gray-100 border border-gray-200'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <p className="text-center text-slate-500 py-12">
            No articles in this category yet.
          </p>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {filtered.map((article) => (
              <Link
                key={article.slug}
                to={`/blog/${article.slug}`}
                className="group bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-lg transition-shadow"
              >
                <div className="p-6 flex flex-col h-full">
                  <span className="text-xs font-semibold text-teal uppercase tracking-wider mb-3">
                    {article.category}
                  </span>
                  <h2 className="font-display text-xl font-bold text-harbor mb-3 group-hover:text-teal transition-colors">
                    {article.title}
                  </h2>
                  <p className="text-sm text-slate-600 leading-relaxed mb-4 flex-1">
                    {article.excerpt}
                  </p>
                  <div className="flex items-center justify-between text-xs text-slate-400 pt-4 border-t border-gray-100">
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
                    <ArrowRight className="h-4 w-4 text-teal opacity-0 group-hover:opacity-100 transition-opacity" />
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
