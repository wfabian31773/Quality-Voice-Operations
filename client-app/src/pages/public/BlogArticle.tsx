import { useParams, Link, Navigate } from 'react-router-dom';
import { Calendar, Clock, ArrowLeft, ArrowRight } from 'lucide-react';
import SEO from '../../components/SEO';
import { getArticleBySlug, getRelatedArticles } from '../../data/blogArticles';

function renderMarkdown(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h3 class="text-xl font-bold text-harbor mt-8 mb-3 font-display">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-2xl font-bold text-harbor mt-10 mb-4 font-display">$1</h2>')
    .replace(/^\*\*(.+?)\*\*$/gm, '<p class="font-semibold text-harbor mt-4 mb-1">$1</p>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-slate-600 leading-relaxed">$1</li>')
    .replace(/(<li.*<\/li>\n?)+/g, (match) => `<ul class="space-y-1.5 my-4">${match}</ul>`)
    .replace(/\|(.+)\|/g, (match) => {
      const cells = match.split('|').filter(Boolean).map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) return '';
      const tag = match.includes('---') ? '' : cells.map((c) => `<td class="px-3 py-2 border border-gray-200 text-sm">${c}</td>`).join('');
      return tag ? `<tr>${tag}</tr>` : '';
    })
    .replace(/(<tr>.*<\/tr>\n?)+/g, (match) => `<table class="w-full border-collapse my-6">${match}</table>`)
    .replace(/^(?!<[huptl])((?!\s*$).+)$/gm, '<p class="text-slate-600 leading-relaxed my-3">$1</p>')
    .replace(/\n{2,}/g, '\n');
}

export default function BlogArticle() {
  const { slug } = useParams<{ slug: string }>();
  const article = slug ? getArticleBySlug(slug) : undefined;

  if (!article) return <Navigate to="/blog" replace />;

  const related = getRelatedArticles(article.slug);

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: article.title,
    description: article.excerpt,
    datePublished: article.date,
    author: {
      '@type': 'Person',
      name: article.author,
      jobTitle: article.authorRole,
    },
    publisher: {
      '@type': 'Organization',
      name: 'QVO',
      url: window.location.origin,
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${window.location.origin}/blog/${article.slug}`,
    },
  };

  return (
    <>
      <SEO
        title={article.title}
        description={article.excerpt}
        ogType="article"
        canonicalPath={`/blog/${article.slug}`}
        structuredData={structuredData}
      />

      <article className="max-w-4xl mx-auto px-6 lg:px-8 py-16">
        <Link
          to="/blog"
          className="inline-flex items-center gap-1.5 text-sm text-teal hover:text-teal-hover font-medium mb-8"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Blog
        </Link>

        <header className="mb-10">
          <span className="text-xs font-semibold text-teal uppercase tracking-wider">
            {article.category}
          </span>
          <h1 className="font-display text-3xl md:text-4xl font-bold text-harbor mt-3 mb-4">
            {article.title}
          </h1>
          <div className="flex flex-wrap items-center gap-4 text-sm text-slate-500">
            <span className="font-medium text-harbor">{article.author}</span>
            <span className="text-slate-300">|</span>
            <span>{article.authorRole}</span>
            <span className="text-slate-300">|</span>
            <span className="flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" />
              {new Date(article.date).toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {article.readTime} min read
            </span>
          </div>
        </header>

        <div
          className="prose-custom"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(article.content) }}
        />

        <div className="flex flex-wrap gap-2 mt-10 pt-6 border-t border-gray-200">
          {article.tags.map((tag) => (
            <span
              key={tag}
              className="px-3 py-1 text-xs font-medium bg-gray-100 text-slate-600 rounded-full"
            >
              {tag}
            </span>
          ))}
        </div>
      </article>

      {related.length > 0 && (
        <section className="bg-gray-50 py-16">
          <div className="max-w-7xl mx-auto px-6 lg:px-8">
            <h2 className="font-display text-2xl font-bold text-harbor mb-8">
              Related Articles
            </h2>
            <div className="grid md:grid-cols-3 gap-8">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  to={`/blog/${r.slug}`}
                  className="group bg-white rounded-xl border border-gray-200 p-6 hover:shadow-lg transition-shadow"
                >
                  <span className="text-xs font-semibold text-teal uppercase tracking-wider">
                    {r.category}
                  </span>
                  <h3 className="font-display text-lg font-bold text-harbor mt-2 mb-2 group-hover:text-teal transition-colors">
                    {r.title}
                  </h3>
                  <p className="text-sm text-slate-600 line-clamp-2 mb-3">
                    {r.excerpt}
                  </p>
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-teal">
                    Read more <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
