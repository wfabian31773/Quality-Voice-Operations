import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { HelpCircle, X, ExternalLink, Mail, Send, Check, Loader2 } from 'lucide-react';
import { DocBlocks } from './DocBlocks';
import { findHelpForPath, getDocBySlug } from '../data/docs';
import { useArticleMetaTranslator } from '../lib/translateDoc';
import { api } from '../lib/api';
import Modal from './Modal';

interface SupportTicketResponse {
  success?: boolean;
  ticket_id?: string;
  routed_to?: string;
}

export function HelpDrawer() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'article' | 'support'>('article');
  const location = useLocation();
  const slug = findHelpForPath(location.pathname);
  const article = getDocBySlug(slug);
  const translateMeta = useArticleMetaTranslator();
  const meta = article ? translateMeta(article) : null;

  // Support form state
  const [topic, setTopic] = useState('question');
  const [message, setMessage] = useState('');
  const [recentErrors, setRecentErrors] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SupportTicketResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // When path changes while open, switch back to article tab and reset
  useEffect(() => {
    setTab('article');
  }, [location.pathname]);

  const submit = async () => {
    if (!message.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const ctx = {
        page: location.pathname,
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        timestamp: new Date().toISOString(),
        referrer: document.referrer || null,
      };
      const res = await api.post<SupportTicketResponse>('/support/tickets', {
        topic,
        message,
        recent_errors: recentErrors || null,
        context: ctx,
      });
      setResult(res);
      setMessage('');
      setRecentErrors('');
    } catch (e) {
      setError((e as Error).message || 'Could not send. Try again or email support@qvo.ai.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Open help"
        className="fixed bottom-6 right-6 z-40 w-12 h-12 rounded-full bg-primary hover:bg-primary-hover text-white shadow-lg shadow-primary/30 flex items-center justify-center transition-colors"
      >
        <HelpCircle className="h-5 w-5" />
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel="Help"
        containerClassName="fixed inset-0 z-50 flex justify-end"
        panelClassName="relative w-full sm:w-[480px] h-full bg-surface shadow-2xl flex flex-col focus:outline-none"
      >
        <aside className="flex flex-col h-full">
            <header className="px-5 py-4 border-b border-border-strong/40 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <HelpCircle className="h-5 w-5 text-primary" />
                <h2 className="font-display text-base font-bold text-text-primary">Help</h2>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-text-primary/50 hover:text-text-primary p-1 rounded-md hover:bg-surface-secondary"
                aria-label="Close help"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="px-5 pt-3 border-b border-border-strong/40">
              <div className="flex gap-1">
                <button
                  onClick={() => setTab('article')}
                  className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                    tab === 'article'
                      ? 'text-primary border-primary'
                      : 'text-text-primary/60 border-transparent hover:text-text-primary'
                  }`}
                >
                  This page
                </button>
                <button
                  onClick={() => setTab('support')}
                  className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                    tab === 'support'
                      ? 'text-primary border-primary'
                      : 'text-text-primary/60 border-transparent hover:text-text-primary'
                  }`}
                >
                  Contact support
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {tab === 'article' && article && meta && (
                <div className="p-5">
                  <p className="text-[10px] uppercase tracking-wider text-primary font-semibold mb-1">
                    {article.category.replace('-', ' ')}
                  </p>
                  <h3 className="font-display text-lg font-bold text-text-primary mb-1">
                    {meta.title}
                  </h3>
                  <p className="text-sm text-text-primary/60 font-body mb-4">{meta.description}</p>
                  <div className="text-sm">
                    <DocBlocks blocks={article.body} dense articleSlug={article.slug} />
                  </div>
                  <div className="mt-6 pt-4 border-t border-border-strong/40 flex flex-col gap-2">
                    <Link
                      to={`/docs/${article.slug}`}
                      target="_blank"
                      onClick={() => setOpen(false)}
                      className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary-hover font-medium"
                    >
                      Open in docs
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                    <Link
                      to="/docs"
                      target="_blank"
                      onClick={() => setOpen(false)}
                      className="inline-flex items-center gap-1.5 text-sm text-text-primary/60 hover:text-primary"
                    >
                      Browse all documentation
                    </Link>
                  </div>
                </div>
              )}
              {tab === 'support' && (
                <div className="p-5">
                  {result?.success ? (
                    <div className="text-center py-8">
                      <div className="w-12 h-12 mx-auto rounded-full bg-emerald-100 dark:bg-emerald-500/20 flex items-center justify-center mb-4">
                        <Check className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <h3 className="font-display text-lg font-bold text-text-primary mb-1">Message sent</h3>
                      <p className="text-sm text-text-primary/70 font-body">
                        We've received your request{result.ticket_id ? ` (ticket ${result.ticket_id})` : ''} and will reply by email within one business day.
                      </p>
                      <button
                        onClick={() => { setResult(null); setOpen(false); }}
                        className="mt-6 text-sm font-medium text-primary hover:text-primary-hover"
                      >
                        Close
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <p className="text-sm text-text-primary/70 font-body">
                        Tell us what's going on. We'll include this page and recent activity automatically to speed things up.
                      </p>
                      <div>
                        <label className="text-xs font-semibold text-text-primary/70 uppercase tracking-wider mb-1.5 block">Topic</label>
                        <select
                          value={topic}
                          onChange={(e) => setTopic(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg border border-border-strong/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 bg-surface"
                        >
                          <option value="question">General question</option>
                          <option value="bug">Something is broken</option>
                          <option value="billing">Billing or plans</option>
                          <option value="integration">Integration help</option>
                          <option value="onboarding">Onboarding / setup</option>
                          <option value="feature">Feature request</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-text-primary/70 uppercase tracking-wider mb-1.5 block">Message</label>
                        <textarea
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          rows={5}
                          required
                          placeholder="Describe what you were doing and what you'd expect to happen..."
                          className="w-full px-3 py-2 rounded-lg border border-border-strong/60 text-sm font-body focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-text-primary/70 uppercase tracking-wider mb-1.5 block">
                          Recent errors <span className="text-text-primary/40 normal-case">(optional)</span>
                        </label>
                        <textarea
                          value={recentErrors}
                          onChange={(e) => setRecentErrors(e.target.value)}
                          rows={2}
                          placeholder="Paste any error message you saw"
                          className="w-full px-3 py-2 rounded-lg border border-border-strong/60 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40"
                        />
                      </div>

                      {error && (
                        <p className="text-xs text-red-600 font-body">{error}</p>
                      )}

                      <div className="flex items-center gap-3">
                        <button
                          onClick={submit}
                          disabled={submitting || !message.trim()}
                          className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
                        >
                          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                          Send message
                        </button>
                        <a
                          href="mailto:support@qvo.ai"
                          className="inline-flex items-center gap-1.5 text-sm text-text-primary/60 hover:text-primary"
                        >
                          <Mail className="h-3.5 w-3.5" />
                          support@qvo.ai
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
      </Modal>
    </>
  );
}
