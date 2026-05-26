import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ThumbsUp, ThumbsDown, MessageSquare, Mail, AlertCircle, RotateCw, Send, MailX, ShieldOff,
} from 'lucide-react';
import { api, getToken } from '../../../../lib/api';
import {
  isHardBounce,
  isPermanentSmtpError,
  describeRetrySkippedReason,
} from '../../../../lib/smtpErrorClass';
import { MarketingSearchEmptyQueriesPanel } from '../../../PlatformAdmin';

/**
 * Docs Feedback admin tab — extracted from PlatformAdmin.tsx in Phase 2.3.
 *
 * This file owns:
 *   - DocsFeedback* types/interfaces (article, comment, reply, reply chain)
 *   - DocsFeedbackStatus / DocsFeedbackSort / DocsFeedbackStatusFilter /
 *     DocsFeedbackReplyStateFilter types
 *   - groupDocsFeedbackReplyChains helper (reply-thread reconstruction)
 *   - DOCS_FEEDBACK_REPLY_AUTO_RETRY_MAX constant (mirror of server's
 *     scheduler MAX_RETRY_ATTEMPTS)
 *   - DocsFeedbackAutoRetryBadge component (pill showing "Auto-retried N/3")
 *   - DocsFeedbackCommentRow component (individual feedback row + reply UI,
 *     ~500 lines, the biggest sub-component of this tab)
 *   - DocsFeedbackTab itself (the route entry point)
 *
 * MarketingSearchEmptyQueriesPanel is rendered at the top of this tab but
 * lives in PlatformAdmin.tsx — it's a marketing-search analytics panel
 * that's unrelated to docs feedback per se. Imported back rather than
 * moved here so that future Phase 2.X can find it a better home.
 */

interface DocsFeedbackArticle {
  article_slug: string;
  total_votes: number;
  helpful_count: number;
  not_helpful_count: number;
  comment_count: number;
  new_comment_count: number;
  resolved_comment_count: number;
  hidden_comment_count: number;
  pending_reply_count: number;
  helpful_ratio: number | null;
  last_vote_at: string | null;
}

type DocsFeedbackStatus = 'new' | 'resolved' | 'hidden';

interface DocsFeedbackComment {
  id: number;
  article_slug: string;
  vote: 'helpful' | 'not_helpful';
  comment: string;
  page_path: string | null;
  created_at: string;
  status: DocsFeedbackStatus;
  status_updated_at: string | null;
  status_updated_by: string | null;
  reply_email: string | null;
  reply_count: number;
  last_reply_at?: string | null;
  last_reply_error?: string | null;
  last_reply_retry_skipped_reason?: string | null;
  last_reply_failed?: boolean | null;
  last_reply_permanent?: boolean | null;
  // Auto-retry counters from `docs_feedback_replies.retry_count` /
  // `last_retry_at` on the most recent reply. Driven by the background
  // DocsFeedbackReplyRetryScheduler so the inbox can show whether the
  // pipeline has already burned all auto-retries (admin should reach out
  // another way) or whether the failure is fresh and a retry hasn't
  // kicked in yet (leave it alone for an hour).
  last_reply_retry_count?: number | null;
  last_reply_last_retry_at?: string | null;
}

interface DocsFeedbackReply {
  id: number;
  feedback_id: number;
  sent_by: string | null;
  to_email: string;
  subject: string;
  body: string;
  email_message_id: string | null;
  email_error: string | null;
  retry_skipped_reason: string | null;
  // Number of background auto-retries the DocsFeedbackReplyRetryScheduler
  // has already burned on this row, plus the timestamp of the most recent
  // attempt. Both are bumped in the same conditional UPDATE the scheduler
  // uses to claim a row, so they always advance together. Surfaced in the
  // reply history so an admin can see at-a-glance whether a Failed row
  // still has retries remaining or whether the scheduler has given up.
  retry_count?: number | null;
  last_retry_at?: string | null;
  retry_of: number | null;
  created_at: string;
}

interface DocsFeedbackReplyChain {
  root: DocsFeedbackReply;
  retries: DocsFeedbackReply[];
}

function groupDocsFeedbackReplyChains(
  replies: DocsFeedbackReply[],
): DocsFeedbackReplyChain[] {
  const ascending = [...replies].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const chainsByRoot = new Map<number, DocsFeedbackReplyChain>();
  for (const r of ascending) {
    if (r.retry_of != null && chainsByRoot.has(r.retry_of)) {
      chainsByRoot.get(r.retry_of)!.retries.push(r);
    } else {
      // Root attempt, or an orphan retry (root row deleted / pre-migration data).
      chainsByRoot.set(r.id, { root: r, retries: [] });
    }
  }
  return Array.from(chainsByRoot.values()).sort(
    (a, b) =>
      new Date(b.root.created_at).getTime() -
      new Date(a.root.created_at).getTime(),
  );
}

type DocsFeedbackSort = 'lowest_ratio' | 'highest_ratio' | 'most_votes' | 'recent';
type DocsFeedbackStatusFilter = DocsFeedbackStatus | 'all' | 'pending_reply';

// Mirrors DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD on the server, which
// the DocsFeedbackReplyRetryScheduler uses as MAX_RETRY_ATTEMPTS. We hard-
// code it on the client so the inbox can render "Auto-retried N/3" without
// an extra round-trip; if the server constant ever changes both sides need
// to be updated together (see platform/help/docsFeedbackReplyDeliveryAlert.ts).
const DOCS_FEEDBACK_REPLY_AUTO_RETRY_MAX = 3;

/**
 * Compact pill that renders "Auto-retried N/MAX" alongside a Failed badge
 * for a docs feedback reply. Renders nothing when no auto-retries have
 * happened yet. Painted amber when the auto-retry pool has been exhausted
 * (the row will not be retried again) and red while retries are still
 * remaining — same colour language the inbox uses for the Hard bounce
 * vs. plain Failed badges. Hover title surfaces the timestamp of the
 * last attempt so an admin can tell whether the scheduler just gave up
 * (recent) or gave up an hour ago.
 */
function DocsFeedbackAutoRetryBadge({
  retryCount,
  lastRetryAt,
  size = 'sm',
}: {
  retryCount: number | null | undefined;
  lastRetryAt: string | null | undefined;
  size?: 'xs' | 'sm';
}) {
  const retries = retryCount ?? 0;
  if (retries <= 0) return null;
  const exhausted = retries >= DOCS_FEEDBACK_REPLY_AUTO_RETRY_MAX;
  const lastRetryLabel = lastRetryAt
    ? new Date(lastRetryAt).toLocaleString()
    : null;
  const title = lastRetryLabel
    ? `Last auto-retry attempt at ${lastRetryLabel}${
        exhausted
          ? ' — no further auto-retries; reach out another way.'
          : '. The background scheduler will keep retrying every ~90s.'
      }`
    : exhausted
      ? 'Auto-retries exhausted — reach out another way.'
      : 'Background scheduler has retried this reply.';
  const sizing =
    size === 'xs'
      ? 'px-1 py-0.5 text-[9px]'
      : 'px-1.5 py-0.5 text-[10px]';
  const palette = exhausted
    ? 'border-warning/40 bg-warning-light text-warning'
    : 'border-danger/40 bg-danger-light text-danger';
  return (
    <span
      className={`rounded border uppercase tracking-wide font-medium ${sizing} ${palette}`}
      title={title}
    >
      Auto-retried {retries}/{DOCS_FEEDBACK_REPLY_AUTO_RETRY_MAX}
    </span>
  );
}

type DocsFeedbackReplyStateFilter = 'any' | 'failed' | 'hard_bounce';

export function DocsFeedbackTab() {
  const { t: adminT } = useTranslation('admin');
  const [sort, setSort] = useState<DocsFeedbackSort>('lowest_ratio');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<DocsFeedbackStatusFilter>('new');
  const [replyStateFilter, setReplyStateFilter] = useState<DocsFeedbackReplyStateFilter>('any');
  const queryClient = useQueryClient();

  const replyFilterActive = replyStateFilter !== 'any';

  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: ['docs-feedback-summary', sort],
    queryFn: () => api.get<{ articles: DocsFeedbackArticle[] }>(`/docs/feedback/summary?sort=${sort}&limit=200`),
    refetchInterval: 60_000,
  });

  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ['docs-feedback-comments', selectedSlug, statusFilter, replyStateFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', selectedSlug ? '100' : '50');
      params.set('status', replyFilterActive ? 'all' : statusFilter);
      if (replyFilterActive) params.set('reply_state', replyStateFilter);
      if (selectedSlug) params.set('article_slug', selectedSlug);
      return api.get<{ comments: DocsFeedbackComment[] }>(`/docs/feedback/comments?${params.toString()}`);
    },
    refetchInterval: 60_000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: DocsFeedbackStatus }) =>
      api.patch<{ comment: DocsFeedbackComment }>(`/docs/feedback/comments/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-comments'] });
    },
  });

  const articles = summaryData?.articles ?? [];
  const comments = commentsData?.comments ?? [];

  return (
    <div className="space-y-6">
      <MarketingSearchEmptyQueriesPanel />

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-semibold">{adminT('platform_admin.docs_feedback.articles_title')}</h2>
            <p className="text-xs text-text-muted mt-0.5">{adminT('platform_admin.docs_feedback.articles_subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-muted">{adminT('platform_admin.docs_feedback.sort_label')}</label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as DocsFeedbackSort)}
              className="text-sm px-2 py-1.5 rounded border border-border bg-surface"
            >
              <option value="lowest_ratio">{adminT('platform_admin.docs_feedback.sort_lowest')}</option>
              <option value="highest_ratio">{adminT('platform_admin.docs_feedback.sort_highest')}</option>
              <option value="most_votes">{adminT('platform_admin.docs_feedback.sort_most_votes')}</option>
              <option value="recent">{adminT('platform_admin.docs_feedback.sort_recent')}</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_article')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_helpfulness')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_helpful')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_not_helpful')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_comments')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_last_vote')}</th>
                <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.docs_feedback.header_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {summaryLoading ? (
                <tr><td colSpan={7} className="text-center py-12 text-text-muted">{adminT('platform_admin.docs_feedback.loading_articles')}</td></tr>
              ) : articles.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12 text-text-muted">{adminT('platform_admin.docs_feedback.no_articles')}</td></tr>
              ) : (
                articles.map((a) => {
                  const ratio = a.helpful_ratio;
                  const ratioColor =
                    ratio === null ? 'text-text-muted'
                      : ratio >= 75 ? 'text-success'
                      : ratio >= 50 ? 'text-warning'
                      : 'text-danger';
                  return (
                    <tr key={a.article_slug} className={`border-b border-border last:border-0 hover:bg-surface-secondary/50 ${selectedSlug === a.article_slug ? 'bg-surface-secondary/40' : ''}`}>
                      <td className="px-4 py-3 font-mono text-xs">{a.article_slug}</td>
                      <td className={`px-4 py-3 font-semibold ${ratioColor}`}>
                        {ratio === null ? adminT('platform_admin.common.em_dash') : `${ratio}%`}
                        <span className="text-text-muted font-normal ml-1">({a.total_votes})</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-success">
                          <ThumbsUp className="h-3.5 w-3.5" /> {a.helpful_count}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-danger">
                          <ThumbsDown className="h-3.5 w-3.5" /> {a.not_helpful_count}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <span className="inline-flex items-center gap-1 text-text-muted">
                            <MessageSquare className="h-3.5 w-3.5" /> {a.comment_count}
                          </span>
                          {a.comment_count > 0 && (
                            <span className="text-xs text-text-muted">
                              {adminT('platform_admin.docs_feedback.breakdown_counts', { new: a.new_comment_count, resolved: a.resolved_comment_count, hidden: a.hidden_comment_count })}
                            </span>
                          )}
                          {a.pending_reply_count > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedSlug(a.article_slug);
                                setStatusFilter('pending_reply');
                              }}
                              className="inline-flex items-center gap-1 self-start px-1.5 py-0.5 rounded border border-warning/30 bg-warning-light text-warning text-[10px] font-medium hover:bg-warning/20"
                              title={adminT('platform_admin.docs_feedback.pending_reply_title')}
                            >
                              <Mail className="h-3 w-3" />
                              {adminT('platform_admin.docs_feedback.pending_reply', { count: a.pending_reply_count })}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-text-muted whitespace-nowrap">
                        {a.last_vote_at ? new Date(a.last_vote_at).toLocaleDateString() : adminT('platform_admin.common.em_dash')}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setSelectedSlug(selectedSlug === a.article_slug ? null : a.article_slug)}
                          className="text-xs px-2 py-1 rounded border border-border hover:bg-surface-secondary"
                        >
                          {selectedSlug === a.article_slug ? adminT('platform_admin.docs_feedback.clear_filter') : adminT('platform_admin.docs_feedback.view_comments')}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-semibold">
              {selectedSlug ? adminT('platform_admin.docs_feedback.comments_title_for', { slug: selectedSlug }) : adminT('platform_admin.docs_feedback.comments_title_recent')}
            </h2>
            <p className="text-xs text-text-muted mt-0.5">
              {selectedSlug
                ? adminT('platform_admin.docs_feedback.comments_subtitle_for')
                : adminT('platform_admin.docs_feedback.comments_subtitle_recent')}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-text-muted">{adminT('platform_admin.docs_feedback.reply_state_label')}</label>
            <select
              value={replyStateFilter}
              onChange={(e) => setReplyStateFilter(e.target.value as DocsFeedbackReplyStateFilter)}
              className={`text-sm px-2 py-1.5 rounded border border-border bg-surface ${
                replyStateFilter === 'hard_bounce'
                  ? 'text-warning font-medium'
                  : replyStateFilter === 'failed'
                    ? 'text-danger font-medium'
                    : ''
              }`}
              title={adminT('platform_admin.docs_feedback.reply_state_title')}
            >
              <option value="any">{adminT('platform_admin.docs_feedback.reply_state_any')}</option>
              <option value="failed">{adminT('platform_admin.docs_feedback.reply_state_failed')}</option>
              <option value="hard_bounce">{adminT('platform_admin.docs_feedback.reply_state_hard_bounce')}</option>
            </select>
            <label className="text-xs text-text-muted">{adminT('platform_admin.docs_feedback.status_label')}</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as DocsFeedbackStatusFilter)}
              disabled={replyFilterActive}
              className="text-sm px-2 py-1.5 rounded border border-border bg-surface disabled:opacity-50"
            >
              <option value="new">{adminT('platform_admin.docs_feedback.status_new')}</option>
              <option value="pending_reply">{adminT('platform_admin.docs_feedback.status_pending_reply')}</option>
              <option value="resolved">{adminT('platform_admin.docs_feedback.status_resolved')}</option>
              <option value="hidden">{adminT('platform_admin.docs_feedback.status_hidden')}</option>
              <option value="all">{adminT('platform_admin.docs_feedback.status_all')}</option>
            </select>
          </div>
        </div>
        <div className="divide-y divide-border">
          {commentsLoading ? (
            <div className="text-center py-12 text-text-muted">{adminT('platform_admin.docs_feedback.loading_comments')}</div>
          ) : comments.length === 0 ? (
            <div className="text-center py-12 text-text-muted">{adminT('platform_admin.docs_feedback.no_comments')}</div>
          ) : (
            comments.map((c) => (
              <DocsFeedbackCommentRow
                key={c.id}
                comment={c}
                onUpdateStatus={(status) => updateStatus.mutate({ id: c.id, status })}
                isStatusPending={updateStatus.isPending && updateStatus.variables?.id === c.id}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function DocsFeedbackCommentRow({
  comment: c,
  onUpdateStatus,
  isStatusPending,
}: {
  comment: DocsFeedbackComment;
  onUpdateStatus: (status: DocsFeedbackStatus) => void;
  isStatusPending: boolean;
}) {
  const { t: adminT } = useTranslation('admin');
  const queryClient = useQueryClient();
  const [showReply, setShowReply] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [markResolved, setMarkResolved] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: repliesData, isLoading: repliesLoading } = useQuery({
    queryKey: ['docs-feedback-replies', c.id],
    queryFn: () =>
      api.get<{ replies: DocsFeedbackReply[] }>(`/docs/feedback/comments/${c.id}/replies`),
    enabled: showHistory,
  });

  const sendReply = useMutation({
    mutationFn: () =>
      api.post<{ success: boolean; message_id?: string }>(
        `/docs/feedback/comments/${c.id}/reply`,
        {
          body: replyBody,
          subject: replySubject || undefined,
          mark_resolved: markResolved,
        },
      ),
    onSuccess: () => {
      setSuccess(adminT('platform_admin.docs_feedback.reply_sent'));
      setError(null);
      setReplyBody('');
      setReplySubject('');
      setShowReply(false);
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-comments'] });
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-replies', c.id] });
    },
    onError: (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      setError(detail || adminT('platform_admin.docs_feedback.reply_send_failed'));
      setSuccess(null);
    },
  });

  // Cooldown timestamp (ms) until the Retry button is allowed to fire again.
  // Set from `retry_after_seconds` on a 429 (so admins don't have to click
  // to discover they're locked out) and from `retry_cooldown_seconds` on a
  // successful retry (to mirror the server-side per-feedback debounce).
  const [retryCooldownUntil, setRetryCooldownUntil] = useState(0);

  const retryReply = useMutation({
    mutationFn: () =>
      api.post<{
        success: boolean;
        message_id?: string;
        subject?: string;
        retry_cooldown_seconds?: number;
      }>(
        `/docs/feedback/comments/${c.id}/reply/retry`,
        {},
      ),
    onSuccess: (data) => {
      setSuccess(adminT('platform_admin.docs_feedback.reply_resent'));
      setError(null);
      const cooldown = readPositiveSeconds(data, 'retry_cooldown_seconds');
      if (cooldown !== null) {
        setRetryCooldownUntil(Date.now() + cooldown * 1000);
      }
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-comments'] });
      queryClient.invalidateQueries({ queryKey: ['docs-feedback-replies', c.id] });
    },
    onError: (err: unknown) => {
      const status = (err as { status?: number } | null)?.status;
      const body = (err as { body?: unknown } | null)?.body;
      if (status === 429) {
        const wait = readPositiveSeconds(body, 'retry_after_seconds');
        if (wait !== null) {
          setRetryCooldownUntil(Date.now() + wait * 1000);
        }
      }
      const detail = err instanceof Error ? err.message : String(err);
      setError(detail || adminT('platform_admin.docs_feedback.reply_resend_failed'));
      setSuccess(null);
    },
  });

  const now = useCountdownTick([retryCooldownUntil]);
  const retrySecondsLeft = Math.max(0, Math.ceil((retryCooldownUntil - now) / 1000));
  const retryDisabled = retryReply.isPending || retrySecondsLeft > 0;
  const retryLabel = retryReply.isPending
    ? adminT('platform_admin.docs_feedback.retrying')
    : retrySecondsLeft > 0
      ? adminT('platform_admin.docs_feedback.retry_available_in', { seconds: retrySecondsLeft })
      : adminT('platform_admin.docs_feedback.retry_send');

  const statusBadge =
    c.status === 'resolved' ? 'bg-success-light text-success border-success/30'
      : c.status === 'hidden' ? 'bg-surface-secondary text-text-muted border-border'
      : 'bg-info-light text-info border-info/30';

  const replies = repliesData?.replies ?? [];
  const lastReplyFailed = c.last_reply_failed === true;
  // Prefer the server-computed `last_reply_permanent` field (which uses the
  // same isPermanentSmtpError classifier that gates the auto-retry digest)
  // and fall back to the client mirror only if the field is missing — e.g.
  // an old API response cached before this rolled out. Either way, the
  // background scheduler will refuse to retry, so the inbox UI must too.
  const lastReplyPermanent =
    c.last_reply_permanent === true ||
    isHardBounce({
      retry_skipped_reason: c.last_reply_retry_skipped_reason,
      email_error: c.last_reply_error,
    }) ||
    (c.last_reply_permanent == null && isPermanentSmtpError(c.last_reply_error));

  return (
    <div
      className={`px-4 py-3 ${
        lastReplyPermanent
          ? 'border-l-4 border-l-warning bg-warning-light/40'
          : lastReplyFailed
            ? 'border-l-4 border-l-danger bg-danger-light/40'
            : ''
      }`}
    >
      {lastReplyFailed && (
        <div
          className={`mb-2 flex items-start gap-2 text-xs rounded px-2 py-1.5 border ${
            lastReplyPermanent
              ? 'text-warning bg-warning-light/60 border-warning/40'
              : 'text-danger bg-danger-light/60 border-danger/30'
          }`}
        >
          <Mail className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <div className="font-semibold flex items-center gap-2 flex-wrap">
              {lastReplyPermanent ? adminT('platform_admin.docs_feedback.hard_bounce_will_not_retry') : adminT('platform_admin.docs_feedback.last_reply_failed')}
              {lastReplyPermanent ? (
                <span
                  className="px-1.5 py-0.5 rounded border border-warning/50 bg-warning-light text-warning text-[10px] uppercase tracking-wide font-semibold"
                  title={adminT('platform_admin.docs_feedback.hard_bounce_title')}
                >
                  {adminT('platform_admin.docs_feedback.hard_bounce_label')}
                </span>
              ) : (
                <span
                  className="px-1.5 py-0.5 rounded border border-danger/40 bg-danger-light text-danger text-[10px] uppercase tracking-wide font-medium"
                  title={adminT('platform_admin.docs_feedback.transient_failed_title')}
                >
                  {adminT('platform_admin.docs_feedback.failed_label_short')}
                </span>
              )}
              {/* If the reply was skipped for a non-hard-bounce reason
                  (suppression, manual cancel, unsubscribe, …) show that
                  alongside the Failed pill so ops sees *why* further auto-
                  retries won't happen, even when the SMTP error itself wasn't
                  a 5xx hard bounce. Hidden on hard bounces because the badge
                  above already explains it. */}
              {!lastReplyPermanent &&
                c.last_reply_retry_skipped_reason &&
                !isHardBounce({
                  retry_skipped_reason: c.last_reply_retry_skipped_reason,
                  email_error: c.last_reply_error,
                }) && (
                  <RetrySkippedBadge reason={c.last_reply_retry_skipped_reason} />
                )}
              {/* Auto-retry counter: shown whenever the background
                  DocsFeedbackReplyRetryScheduler has touched this reply at
                  least once. The hover title surfaces the timestamp of the
                  last attempt so an admin can tell whether the scheduler
                  just gave up (recent) or gave up an hour ago — and the
                  pill turns amber once the auto-retry cap is exhausted so
                  it matches the "auto-retries exhausted" treatment of the
                  hard-bounce badge above. */}
              <DocsFeedbackAutoRetryBadge
                retryCount={c.last_reply_retry_count}
                lastRetryAt={c.last_reply_last_retry_at}
              />
            </div>
            {c.last_reply_error && (
              <div className={lastReplyPermanent ? 'text-warning' : 'text-danger'}>
                {c.last_reply_error}
              </div>
            )}
            <div className={lastReplyPermanent ? 'text-warning/90' : 'text-danger/80'}>
              {lastReplyPermanent ? (
                <>
                  {adminT('platform_admin.docs_feedback.hard_bounce_explainer_prefix')}{' '}
                  {c.reply_email ? (
                    <a
                      href={`mailto:${c.reply_email}`}
                      title={adminT('platform_admin.docs_feedback.contact_email_title', { email: c.reply_email })}
                      className="underline font-medium text-warning hover:text-warning/80"
                    >
                      {adminT('platform_admin.docs_feedback.contact_email', { email: c.reply_email })}
                    </a>
                  ) : (
                    adminT('platform_admin.docs_feedback.no_reply_email')
                  )}
                </>
              ) : (
                adminT('platform_admin.docs_feedback.retry_or_open_form')
              )}
              {c.last_reply_at && (
                <> {adminT('platform_admin.docs_feedback.reply_attempted_at', { time: new Date(c.last_reply_at).toLocaleString() })}</>
              )}
            </div>
          </div>
          {lastReplyPermanent ? (
            <span
              className="ml-2 self-start px-2 py-1 rounded border border-warning/40 bg-warning-light text-warning text-[11px] whitespace-nowrap cursor-not-allowed"
              title={adminT('platform_admin.docs_feedback.retry_disabled_title')}
            >
              {adminT('platform_admin.docs_feedback.retry_disabled')}
            </span>
          ) : (
            <button
              type="button"
              disabled={retryDisabled}
              onClick={() => {
                setError(null);
                setSuccess(null);
                retryReply.mutate();
              }}
              title={
                retrySecondsLeft > 0
                  ? adminT('platform_admin.docs_feedback.retry_cooldown_title', { seconds: retrySecondsLeft })
                  : undefined
              }
              className="ml-2 self-start px-2 py-1 rounded border border-danger/40 bg-surface text-danger hover:bg-danger-light disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {retryLabel}
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 text-xs text-text-muted mb-1 flex-wrap">
        {c.vote === 'helpful' ? (
          <span className="inline-flex items-center gap-1 text-success"><ThumbsUp className="h-3 w-3" /> {adminT('platform_admin.docs_feedback.vote_helpful')}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-danger"><ThumbsDown className="h-3 w-3" /> {adminT('platform_admin.docs_feedback.vote_not_helpful')}</span>
        )}
        <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide font-medium ${statusBadge}`}>
          {c.status}
        </span>
        <span className="font-mono">{c.article_slug}</span>
        {c.page_path && <span className="text-text-muted">· {c.page_path}</span>}
        {c.reply_count > 0 && (
          <span className="inline-flex items-center gap-1 text-primary">
            <Mail className="h-3 w-3" /> {adminT('platform_admin.docs_feedback.replies', { count: c.reply_count })}
          </span>
        )}
        <span className="ml-auto">{new Date(c.created_at).toLocaleString()}</span>
      </div>
      <div className="text-sm whitespace-pre-wrap">{c.comment}</div>
      {c.reply_email && (
        <div className="mt-1 text-xs text-text-muted inline-flex items-center gap-1">
          <Mail className="h-3 w-3" />
          <a href={`mailto:${c.reply_email}`} className="text-primary hover:underline">{c.reply_email}</a>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 text-xs flex-wrap">
        {c.reply_email && (
          <button
            type="button"
            onClick={() => {
              setShowReply((v) => !v);
              setError(null);
              setSuccess(null);
            }}
            className="px-2 py-1 rounded border border-primary/30 text-primary hover:bg-primary-light"
          >
            {showReply ? adminT('platform_admin.docs_feedback.cancel_reply') : adminT('platform_admin.docs_feedback.reply_by_email')}
          </button>
        )}
        {c.reply_email && (
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary"
          >
            {showHistory
              ? adminT('platform_admin.docs_feedback.hide_replies')
              : c.reply_count > 0
                ? adminT('platform_admin.docs_feedback.show_n_replies', { count: c.reply_count })
                : adminT('platform_admin.docs_feedback.show_reply_history')}
          </button>
        )}
        {c.status !== 'resolved' && (
          <button
            type="button"
            disabled={isStatusPending}
            onClick={() => onUpdateStatus('resolved')}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
          >
            {adminT('platform_admin.docs_feedback.mark_resolved')}
          </button>
        )}
        {c.status !== 'hidden' && (
          <button
            type="button"
            disabled={isStatusPending}
            onClick={() => onUpdateStatus('hidden')}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
          >
            {adminT('platform_admin.docs_feedback.hide')}
          </button>
        )}
        {c.status !== 'new' && (
          <button
            type="button"
            disabled={isStatusPending}
            onClick={() => onUpdateStatus('new')}
            className="px-2 py-1 rounded border border-border hover:bg-surface-secondary disabled:opacity-50"
          >
            {adminT('platform_admin.docs_feedback.reopen')}
          </button>
        )}
        {c.status_updated_by && c.status_updated_at && (
          <span className="text-text-muted ml-auto">
            {adminT('platform_admin.docs_feedback.status_updated_by', { status: c.status, user: c.status_updated_by, time: new Date(c.status_updated_at).toLocaleString() })}
          </span>
        )}
      </div>

      {success && <div className="mt-2 text-xs text-success">{success}</div>}

      {showReply && c.reply_email && (
        <div className="mt-3 border border-primary/30 rounded-lg bg-primary-light/30 p-3 space-y-2">
          <div className="text-xs text-text-muted">
            {adminT('platform_admin.docs_feedback.reply_will_be_sent_prefix')} <span className="font-mono">{c.reply_email}</span>.
          </div>
          <input
            type="text"
            value={replySubject}
            onChange={(e) => setReplySubject(e.target.value)}
            placeholder={adminT('platform_admin.docs_feedback.reply_subject_placeholder', { slug: c.article_slug })}
            className="w-full px-2 py-1.5 rounded border border-border text-sm bg-surface"
          />
          <textarea
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            rows={5}
            placeholder={adminT('platform_admin.docs_feedback.reply_body_placeholder')}
            className="w-full px-2 py-1.5 rounded border border-border text-sm bg-surface"
          />
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={markResolved}
              onChange={(e) => setMarkResolved(e.target.checked)}
            />
            {adminT('platform_admin.docs_feedback.mark_after_send')}
          </label>
          {error && <div className="text-xs text-danger">{error}</div>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={sendReply.isPending || replyBody.trim().length === 0}
              onClick={() => {
                setError(null);
                sendReply.mutate();
              }}
              className="px-3 py-1.5 text-sm rounded bg-primary text-on-primary hover:bg-primary-hover disabled:opacity-50"
            >
              {sendReply.isPending ? adminT('platform_admin.docs_feedback.sending') : adminT('platform_admin.docs_feedback.send_reply')}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowReply(false);
                setError(null);
              }}
              className="px-3 py-1.5 text-sm rounded border border-border hover:bg-surface-secondary"
            >
              {adminT('platform_admin.common.cancel')}
            </button>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="mt-3 border border-border rounded-lg bg-surface-secondary/30 p-3 space-y-2">
          {repliesLoading ? (
            <div className="text-xs text-text-muted">{adminT('platform_admin.docs_feedback.loading_replies')}</div>
          ) : replies.length === 0 ? (
            <div className="text-xs text-text-muted">{adminT('platform_admin.docs_feedback.no_replies')}</div>
          ) : (
            groupDocsFeedbackReplyChains(replies).map((chain) => {
              const r = chain.root;
              const totalAttempts = 1 + chain.retries.length;
              return (
                <div
                  key={r.id}
                  className="text-xs border border-border rounded p-2 bg-surface"
                >
                  <div className="flex items-center gap-2 text-text-muted mb-1 flex-wrap">
                    <span>{new Date(r.created_at).toLocaleString()}</span>
                    <span>· {adminT('platform_admin.docs_feedback.from_admin_label', { user: r.sent_by ?? 'admin' })}</span>
                    <span>· {adminT('platform_admin.docs_feedback.to_label', { email: r.to_email })}</span>
                    {r.email_error
                      ? (
                        <span className="text-danger inline-flex items-center gap-1">
                          · {adminT('platform_admin.docs_feedback.failed_label', { error: r.email_error })}
                          {isHardBounce(r) && (
                            <span
                              className="px-1 py-0.5 rounded border border-warning/40 bg-warning-light text-warning text-[9px] uppercase tracking-wide font-medium"
                              title={adminT('platform_admin.docs_feedback.hard_bounce_title_short')}
                            >
                              {adminT('platform_admin.docs_feedback.hard_bounce_label')}
                            </span>
                          )}
                          {/* Render a distinct badge for any *non-hard-bounce*
                              skip reason (suppression, manual cancel, recipient
                              unsubscribed, …). Unknown future reasons fall
                              through to the generic "Auto-retry skipped" pill
                              from describeRetrySkippedReason so the row never
                              breaks if the server starts writing a new value
                              before the client knows about it. */}
                          {!isHardBounce(r) && r.retry_skipped_reason && (
                            <RetrySkippedBadge reason={r.retry_skipped_reason} size="xs" />
                          )}
                          {/* Inline auto-retry counter from the background
                              scheduler (not the same as the manual chain
                              "{N} attempts" pill below — that one counts
                              chain.retries rows, this one counts in-place
                              auto-retries on this exact row). */}
                          <DocsFeedbackAutoRetryBadge
                            retryCount={r.retry_count}
                            lastRetryAt={r.last_retry_at}
                            size="xs"
                          />
                        </span>
                      )
                      : <span className="text-success">· {adminT('platform_admin.docs_feedback.delivered')}</span>}
                    {chain.retries.length > 0 && (
                      <span
                        className="px-1.5 py-0.5 rounded border border-warning/30 bg-warning-light text-warning text-[10px] uppercase tracking-wide"
                        title={adminT('platform_admin.docs_feedback.attempts_chain_title', { count: chain.retries.length })}
                      >
                        {adminT('platform_admin.docs_feedback.attempts', { count: totalAttempts })}
                      </span>
                    )}
                  </div>
                  <div className="text-sm font-medium mb-1">{r.subject}</div>
                  <div className="text-sm whitespace-pre-wrap">{r.body}</div>
                  {chain.retries.length > 0 && (
                    <div className="mt-2 pl-3 border-l-2 border-warning/30 space-y-1">
                      <div className="text-[10px] uppercase tracking-wide text-warning font-semibold">
                        {adminT('platform_admin.docs_feedback.retries_section')}
                      </div>
                      {chain.retries.map((retry, idx) => (
                        <div
                          key={retry.id}
                          className="flex items-center gap-2 text-text-muted flex-wrap"
                        >
                          <span
                            className="px-1.5 py-0.5 rounded border border-warning/30 bg-warning-light text-warning text-[10px] uppercase tracking-wide"
                            title={adminT('platform_admin.docs_feedback.retry_title', { time: new Date(r.created_at).toLocaleString() })}
                          >
                            {adminT('platform_admin.docs_feedback.retry_n', { n: idx + 1 })}
                          </span>
                          <span>{new Date(retry.created_at).toLocaleString()}</span>
                          <span>· {adminT('platform_admin.docs_feedback.from_admin_label', { user: retry.sent_by ?? 'admin' })}</span>
                          {retry.email_error
                            ? (
                              <span className="text-danger inline-flex items-center gap-1">
                                · {adminT('platform_admin.docs_feedback.failed_label', { error: retry.email_error })}
                                {isHardBounce(retry) && (
                                  <span
                                    className="px-1 py-0.5 rounded border border-warning/40 bg-warning-light text-warning text-[9px] uppercase tracking-wide font-medium"
                                    title={adminT('platform_admin.docs_feedback.hard_bounce_title_short')}
                                  >
                                    {adminT('platform_admin.docs_feedback.hard_bounce_label')}
                                  </span>
                                )}
                                {!isHardBounce(retry) && retry.retry_skipped_reason && (
                                  <RetrySkippedBadge reason={retry.retry_skipped_reason} size="xs" />
                                )}
                                <DocsFeedbackAutoRetryBadge
                                  retryCount={retry.retry_count}
                                  lastRetryAt={retry.last_retry_at}
                                  size="xs"
                                />
                              </span>
                            )
                            : <span className="text-success">· {adminT('platform_admin.docs_feedback.delivered')}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export default DocsFeedbackTab;
