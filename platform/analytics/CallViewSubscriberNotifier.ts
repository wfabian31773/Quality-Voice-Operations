import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';
import { sendEmail } from '../email/EmailService';

const logger = createLogger('CALL_VIEW_SUBSCRIBER_NOTIFIER');

export interface SubscriberChangeNotification {
  tenantId: string;
  viewId: string;
  viewName: string;
  actorUserId: string | null;
  actorEmail: string | null;
  added: string[];
  removed: string[];
}

interface ActorInfo {
  email: string | null;
  displayName: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildViewPath(viewId: string): string {
  return `/calls?view=${encodeURIComponent(viewId)}`;
}

function buildViewLink(viewId: string): string {
  const baseUrl =
    process.env.APP_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '');
  const path = buildViewPath(viewId);
  return baseUrl ? `${baseUrl}${path}` : path;
}

async function lookupUserIdsByEmail(
  tenantId: string,
  emails: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (emails.length === 0) return map;
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ id: string; email: string }>(
      `SELECT id, LOWER(email) AS email FROM users
        WHERE tenant_id = $1 AND LOWER(email) = ANY($2::text[])`,
      [tenantId, emails],
    );
    for (const row of rows) {
      if (row.email && row.id) map.set(row.email, row.id);
    }
  } catch (err) {
    logger.warn('Failed to look up user ids for in-app subscriber notifications', {
      tenantId,
      error: String(err),
    });
  }
  return map;
}

async function createInAppNotification(params: {
  tenantId: string;
  userId: string;
  viewId: string;
  viewName: string;
  actorName: string;
  kind: 'added' | 'removed';
}): Promise<void> {
  const { tenantId, userId, viewId, viewName, actorName, kind } = params;
  const title =
    kind === 'added'
      ? `Subscribed to "${viewName}" digest`
      : `Removed from "${viewName}" digest`;
  const message =
    kind === 'added'
      ? `${actorName} added you to the daily digest for the saved view "${viewName}".`
      : `${actorName} removed you from the daily digest for the saved view "${viewName}".`;
  const metadata = {
    link: buildViewPath(viewId),
    viewId,
    viewName,
    change: kind,
    actor: actorName,
  };
  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO tenant_notifications (tenant_id, user_id, type, title, message, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, userId, 'call', title, message, JSON.stringify(metadata)],
    );
  } catch (err) {
    logger.warn('Failed to create in-app subscriber notification', {
      tenantId,
      userId,
      viewId,
      kind,
      error: String(err),
    });
  }
}

async function getActorInfo(actorUserId: string | null, actorEmail: string | null): Promise<ActorInfo> {
  let email = actorEmail ? actorEmail.trim().toLowerCase() : null;
  let displayName = '';
  if (actorUserId) {
    try {
      const pool = getPlatformPool();
      const { rows } = await pool.query<{ email: string | null; first_name: string | null; last_name: string | null }>(
        `SELECT email, first_name, last_name FROM users WHERE id = $1`,
        [actorUserId],
      );
      if (rows[0]) {
        if (!email && rows[0].email) email = rows[0].email.trim().toLowerCase();
        const fn = (rows[0].first_name ?? '').trim();
        const ln = (rows[0].last_name ?? '').trim();
        const full = `${fn} ${ln}`.trim();
        displayName = full || rows[0].email || '';
      }
    } catch (err) {
      logger.warn('Failed to look up actor info for subscriber notification', {
        actorUserId,
        error: String(err),
      });
    }
  }
  if (!displayName) displayName = email || 'a teammate';
  return { email, displayName };
}

function renderAdded(viewName: string, displayName: string, viewId: string): { subject: string; html: string; text: string } {
  const link = buildViewLink(viewId);
  const subject = `You were subscribed to "${viewName}" digest`;
  const safeName = escapeHtml(viewName);
  const safeActor = escapeHtml(displayName);
  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:560px">
      <h2 style="margin:0 0 8px">You were added to a daily call digest</h2>
      <p style="margin:0 0 12px;color:#475569">
        <strong>${safeActor}</strong> subscribed you to the daily digest for the saved view
        <strong>"${safeName}"</strong>. You'll start receiving a once-a-day email summary of new calls
        that match this view.
      </p>
      <p style="margin:0 0 16px"><a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Open the view</a></p>
      <p style="margin:24px 0 0;color:#94a3b8;font-size:12px">
        Don't want these? Open the saved view on the Conversations page and remove yourself from the subscriber list.
      </p>
    </div>`;
  const text = [
    `You were added to a daily call digest`,
    '',
    `${displayName} subscribed you to the daily digest for the saved view "${viewName}".`,
    `You'll start receiving a once-a-day email summary of new calls that match this view.`,
    '',
    `Open the view: ${link}`,
    '',
    `To stop receiving these, open the saved view on the Conversations page and remove yourself from the subscriber list.`,
  ].join('\n');
  return { subject, html, text };
}

function renderRemoved(viewName: string, displayName: string): { subject: string; html: string; text: string } {
  const subject = `You were unsubscribed from "${viewName}" digest`;
  const safeName = escapeHtml(viewName);
  const safeActor = escapeHtml(displayName);
  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:560px">
      <h2 style="margin:0 0 8px">You were removed from a daily call digest</h2>
      <p style="margin:0 0 12px;color:#475569">
        <strong>${safeActor}</strong> removed you from the daily digest for the saved view
        <strong>"${safeName}"</strong>. You won't receive further daily emails for this view.
      </p>
      <p style="margin:24px 0 0;color:#94a3b8;font-size:12px">
        If you think this was a mistake, reach out to the view's owner to be re-added.
      </p>
    </div>`;
  const text = [
    `You were removed from a daily call digest`,
    '',
    `${displayName} removed you from the daily digest for the saved view "${viewName}".`,
    `You won't receive further daily emails for this view.`,
    '',
    `If you think this was a mistake, reach out to the view's owner to be re-added.`,
  ].join('\n');
  return { subject, html, text };
}

function dedupeLower(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of emails) {
    if (typeof e !== 'string') continue;
    const v = e.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function diffSubscribers(oldSubs: string[], newSubs: string[]): { added: string[]; removed: string[] } {
  const oldSet = new Set(dedupeLower(oldSubs));
  const newSet = new Set(dedupeLower(newSubs));
  const added: string[] = [];
  const removed: string[] = [];
  for (const e of newSet) if (!oldSet.has(e)) added.push(e);
  for (const e of oldSet) if (!newSet.has(e)) removed.push(e);
  return { added, removed };
}

export async function notifySubscriberChanges(params: SubscriberChangeNotification): Promise<void> {
  const added = dedupeLower(params.added);
  const removed = dedupeLower(params.removed);
  if (added.length === 0 && removed.length === 0) return;

  const actor = await getActorInfo(params.actorUserId, params.actorEmail);
  const actorEmail = actor.email;

  // Skip self-subscribe / self-unsubscribe — never notify the actor about their own change.
  const addedTargets = actorEmail ? added.filter((e) => e !== actorEmail) : added;
  const removedTargets = actorEmail ? removed.filter((e) => e !== actorEmail) : removed;
  if (addedTargets.length === 0 && removedTargets.length === 0) return;

  // Look up matching user ids within this tenant so we can also drop a row in the
  // per-user in-app inbox. Recipients without a matching user row simply get the
  // email (e.g. external collaborators).
  const userIdMap = await lookupUserIdsByEmail(
    params.tenantId,
    Array.from(new Set([...addedTargets, ...removedTargets])),
  );
  if (params.actorUserId) {
    for (const [email, uid] of userIdMap.entries()) {
      if (uid === params.actorUserId) userIdMap.delete(email);
    }
  }

  for (const recipient of addedTargets) {
    const uid = userIdMap.get(recipient);
    if (uid) {
      await createInAppNotification({
        tenantId: params.tenantId,
        userId: uid,
        viewId: params.viewId,
        viewName: params.viewName,
        actorName: actor.displayName,
        kind: 'added',
      });
    }
  }
  for (const recipient of removedTargets) {
    const uid = userIdMap.get(recipient);
    if (uid) {
      await createInAppNotification({
        tenantId: params.tenantId,
        userId: uid,
        viewId: params.viewId,
        viewName: params.viewName,
        actorName: actor.displayName,
        kind: 'removed',
      });
    }
  }

  for (const recipient of addedTargets) {
    try {
      const tpl = renderAdded(params.viewName, actor.displayName, params.viewId);
      const result = await sendEmail({
        to: recipient,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      if (!result.success) {
        logger.warn('Failed to send subscribe notification email', {
          tenantId: params.tenantId,
          viewId: params.viewId,
          recipient,
          error: result.error,
        });
      }
    } catch (err) {
      logger.error('Error sending subscribe notification email', {
        tenantId: params.tenantId,
        viewId: params.viewId,
        recipient,
        error: String(err),
      });
    }
  }

  for (const recipient of removedTargets) {
    try {
      const tpl = renderRemoved(params.viewName, actor.displayName);
      const result = await sendEmail({
        to: recipient,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      if (!result.success) {
        logger.warn('Failed to send unsubscribe notification email', {
          tenantId: params.tenantId,
          viewId: params.viewId,
          recipient,
          error: result.error,
        });
      }
    } catch (err) {
      logger.error('Error sending unsubscribe notification email', {
        tenantId: params.tenantId,
        viewId: params.viewId,
        recipient,
        error: String(err),
      });
    }
  }

  logger.info('Saved view subscriber change notifications sent', {
    tenantId: params.tenantId,
    viewId: params.viewId,
    added: addedTargets.length,
    removed: removedTargets.length,
  });
}
