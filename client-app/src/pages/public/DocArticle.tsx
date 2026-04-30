import { useMemo, useState } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { ChevronRight, Clock, Edit3, ThumbsUp, ThumbsDown, Check } from 'lucide-react';
import SEO from '../../components/SEO';
import { DocBlocks, slugify } from '../../components/DocBlocks';
import { DocsSidebar } from '../../components/DocsSidebar';
import { docCategories, getDocBySlug, getAdjacentDocs } from '../../data/docs';
import {
  useTranslatedArticle,
  useArticleMetaTranslator,
  useDocCategoryTranslator,
} from '../../lib/translateDoc';
import { api } from '../../lib/api';

export default function DocArticle() {
  const { slug } = useParams<{ slug: string }>();
  const rawArticle = slug ? getDocBySlug(slug) : undefined;
  const article = useTranslatedArticle(rawArticle);
  const translateMeta = useArticleMetaTranslator();
  const translateCategory = useDocCategoryTranslator();
  const adjacent = slug ? getAdjacentDocs(slug) : { prev: undefined, next: undefined };
  const [feedback, setFeedback] = useState<'helpful' | 'not_helpful' | null>(null);
  const [comment, setComment] = useState('');
  const [replyEmail, setReplyEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const tocHeadings = useMemo(() => {
    if (!article) return [] as { text: string; id: string; level: 2 | 3 }[];
    return article.body
      .filter((b) => b.type === 'h2' || b.type === 'h3')
      .map((b) => {
        const block = b as { type: 'h2' | 'h3'; text: string };
        return { text: block.text, id: slugify(block.text), level: (block.type === 'h2' ? 2 : 3) as 2 | 3 };
      });
  }, [article]);

  if (!article) return <Navigate to="/docs" replace />;

  const rawCategory = docCategories.find((c) => c.slug === article.category);
  const category = rawCategory
    ? { ...rawCategory, ...translateCategory(rawCategory) }
    : undefined;
  const editUrl = `https://github.com/qvo-ai/docs/edit/main/${article.category}/${article.slug}.md`;

  const submitFeedback = async (vote: 'helpful' | 'not_helpful') => {
    setFeedback(vote);
    try {
      await api.post('/docs/feedback', {
        article_slug: article.slug,
        vote,
        page_path: window.location.pathname,
      });
    } catch {
      // silent — vote is best-effort
    }
    if (vote === 'helpful') {
      setSubmitted(true);
    }
  };

  const submitComment = async () => {
    const trimmedEmail = replyEmail.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    setEmailError(null);
    try {
      await api.post('/docs/feedback', {
        article_slug: article.slug,
        vote: 'not_helpful',
        comment,
        page_path: window.location.pathname,
        reply_email: trimmedEmail || undefined,
      });
    } catch {
      // silent
    } finally {
      setSubmitted(true);
    }
  };

  return (
    <div>
      <SEO
        title={`${article.title} — QVO Docs`}
        description={article.description}
        canonicalPath={`/docs/${article.slug}`}
        ogType="article"
        structuredData={{
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: article.title,
          description: article.description,
          dateModified: article.updated,
          author: { '@type': 'Organization', name: 'QVO' },
          publisher: { '@type': 'Organization', name: 'QVO' },
        }}
      />

      <section className="bg-surface-secondary border-b border-border/50">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-4">
          <nav className="flex items-center gap-2 text-xs text-text-primary/60 font-body">
            <Link to="/docs" className="hover:text-primary transition-colors">Docs</Link>
            <ChevronRight className="h-3 w-3" />
            <Link to={`/docs#${article.category}`} className="hover:text-primary transition-colors">
              {category?.title}
            </Link>
            <ChevronRight className="h-3 w-3" />
            <span className="text-text-primary/80">{article.title}</span>
          </nav>
        </div>
      </section>

      <section className="py-10 lg:py-12">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex flex-col lg:flex-row gap-10">
            <aside className="lg:w-64 shrink-0">
              <div className="lg:sticky lg:top-24 max-h-[calc(100vh-7rem)] overflow-y-auto">
                <DocsSidebar activeSlug={article.slug} />
              </div>
            </aside>

            <article className="flex-1 min-w-0 max-w-3xl">
              <header className="mb-8">
                <span className="text-xs text-primary bg-primary/10 px-2.5 py-1 rounded-full font-medium">
                  {category?.title}
                </span>
                <h1 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mt-3 mb-3 leading-tight">
                  {article.title}
                </h1>
                <p className="text-base text-text-primary/70 font-body leading-relaxed">
                  {article.description}
                </p>
                <div className="flex items-center gap-4 mt-4 text-xs text-text-primary/50 font-body">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    {article.readTime}
                  </span>
                  <span>Updated {new Date(article.updated).toLocaleDateString()}</span>
                  <a
                    href={editUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto hidden sm:flex items-center gap-1.5 hover:text-primary transition-colors"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    Edit this page
                  </a>
                </div>
              </header>

              <DocBlocks blocks={rawArticle!.body} articleSlug={article.slug} />

              <div className="mt-12 border-t border-border/50 pt-8">
                {!feedback || (feedback === 'not_helpful' && !submitted) ? (
                  <div>
                    <p className="text-sm font-semibold text-text-primary mb-3">Was this article helpful?</p>
                    {!feedback ? (
                      <div className="flex gap-3">
                        <button
                          onClick={() => submitFeedback('helpful')}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border/60 hover:border-primary hover:text-primary text-sm font-medium transition-colors"
                        >
                          <ThumbsUp className="h-4 w-4" />
                          Yes
                        </button>
                        <button
                          onClick={() => submitFeedback('not_helpful')}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border/60 hover:border-primary hover:text-primary text-sm font-medium transition-colors"
                        >
                          <ThumbsDown className="h-4 w-4" />
                          No
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-xs text-text-primary/60 font-body">What was missing or unclear? (optional)</p>
                        <textarea
                          value={comment}
                          onChange={(e) => setComment(e.target.value)}
                          rows={3}
                          className="w-full px-3 py-2 rounded-lg border border-border/60 text-sm font-body focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40"
                          placeholder="Tell us how we can improve this article..."
                        />
                        <div>
                          <p className="text-xs text-text-primary/60 font-body mb-1">
                            Email (optional) — so our team can follow up
                          </p>
                          <input
                            type="email"
                            value={replyEmail}
                            onChange={(e) => {
                              setReplyEmail(e.target.value);
                              if (emailError) setEmailError(null);
                            }}
                            placeholder="you@example.com"
                            className="w-full px-3 py-2 rounded-lg border border-border/60 text-sm font-body focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40"
                          />
                          {emailError && (
                            <p className="text-xs text-red-600 mt-1 font-body">{emailError}</p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={submitComment}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
                          >
                            Submit feedback
                          </button>
                          <button
                            onClick={() => setSubmitted(true)}
                            className="text-sm text-text-primary/50 hover:text-text-primary/80 px-3"
                          >
                            Skip
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-emerald-600">
                    <Check className="h-4 w-4" />
                    Thanks for the feedback — it helps us improve.
                  </div>
                )}
              </div>

              <div className="mt-10 grid sm:grid-cols-2 gap-4">
                {adjacent.prev ? (
                  <Link
                    to={`/docs/${adjacent.prev.slug}`}
                    className="group bg-surface border border-border/50 rounded-xl p-4 hover:border-primary/40 hover:shadow-sm transition-all"
                  >
                    <p className="text-xs text-text-primary/50 font-body mb-1">← Previous</p>
                    <p className="text-sm font-semibold text-text-primary group-hover:text-primary transition-colors">{translateMeta(adjacent.prev).title}</p>
                  </Link>
                ) : <div />}
                {adjacent.next ? (
                  <Link
                    to={`/docs/${adjacent.next.slug}`}
                    className="group bg-surface border border-border/50 rounded-xl p-4 hover:border-primary/40 hover:shadow-sm transition-all sm:text-right"
                  >
                    <p className="text-xs text-text-primary/50 font-body mb-1">Next →</p>
                    <p className="text-sm font-semibold text-text-primary group-hover:text-primary transition-colors">{translateMeta(adjacent.next).title}</p>
                  </Link>
                ) : <div />}
              </div>
            </article>

            <aside className="hidden xl:block w-56 shrink-0">
              <div className="sticky top-24">
                <p className="text-xs font-semibold text-text-primary/50 uppercase tracking-wider mb-3">On this page</p>
                <ul className="space-y-1.5">
                  {tocHeadings.map((h) => (
                    <li key={h.id} className={h.level === 3 ? 'pl-3' : ''}>
                      <a
                        href={`#${h.id}`}
                        className="block text-xs text-text-primary/60 hover:text-primary py-1 font-body leading-relaxed"
                      >
                        {h.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </aside>
          </div>
        </div>
      </section>
    </div>
  );
}
