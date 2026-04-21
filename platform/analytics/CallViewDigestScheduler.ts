import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { sendEmail } from '../email/EmailService';

const logger = createLogger('CALL_VIEW_DIGEST');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const MIN_RESEND_HOURS = 20;
const SAMPLE_LIMIT = 5;

export interface SavedViewRow {
  id: string;
  tenant_id: string;
  name: string;
  filters: Record<string, unknown> | null;
  is_shared: boolean;
  created_by: string | null;
  digest_enabled: boolean;
  digest_subscribers: string[] | null;
  digest_last_run_at: Date | null;
}

interface FilterShape {
  agent_id?: string;
  direction?: string;
  lifecycle_state?: string;
  has_transcript?: string;
  has_events?: string;
  has_tool_executions?: string;
  tool_failures_only?: string;
  q?: string;
  // dateRange is intentionally ignored for digests — we always look at last 24h.
}

function parseBoolFilter(v: string | undefined): boolean | null {
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
}

function buildFilterClause(
  tenantId: string,
  filters: FilterShape,
  sinceIso: string,
  untilIso: string,
): { where: string; values: unknown[] } {
  const conditions: string[] = [
    'cs.tenant_id = $1',
    'cs.start_time >= $2::timestamptz',
    'cs.start_time < $3::timestamptz',
  ];
  const values: unknown[] = [tenantId, sinceIso, untilIso];

  if (filters.agent_id) { values.push(filters.agent_id); conditions.push(`cs.agent_id = $${values.length}`); }
  if (filters.direction) { values.push(filters.direction); conditions.push(`cs.direction = $${values.length}`); }
  if (filters.lifecycle_state) { values.push(filters.lifecycle_state); conditions.push(`cs.lifecycle_state = $${values.length}`); }
  if (filters.q && filters.q.trim()) {
    const term = `%${filters.q.trim()}%`;
    values.push(term);
    const idx = values.length;
    conditions.push(`(cs.caller_number ILIKE $${idx} OR cs.called_number ILIKE $${idx} OR cs.id::text ILIKE $${idx})`);
  }

  const transcriptFilter = parseBoolFilter(filters.has_transcript);
  if (transcriptFilter !== null) {
    const op = transcriptFilter ? 'EXISTS' : 'NOT EXISTS';
    conditions.push(`${op} (SELECT 1 FROM call_transcripts ct WHERE ct.call_session_id = cs.id AND ct.tenant_id = cs.tenant_id)`);
  }
  const eventsFilter = parseBoolFilter(filters.has_events);
  if (eventsFilter !== null) {
    const op = eventsFilter ? 'EXISTS' : 'NOT EXISTS';
    conditions.push(`${op} (SELECT 1 FROM call_events ce WHERE ce.call_session_id = cs.id AND ce.tenant_id = cs.tenant_id)`);
  }
  const toolsFilter = parseBoolFilter(filters.has_tool_executions);
  if (toolsFilter !== null) {
    const op = toolsFilter ? 'EXISTS' : 'NOT EXISTS';
    conditions.push(`${op} (SELECT 1 FROM tool_invocations ti WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id)`);
  }
  if (parseBoolFilter(filters.tool_failures_only) === true) {
    conditions.push(
      `EXISTS (SELECT 1 FROM tool_invocations ti WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id AND ti.status IN ('failed', 'timeout'))`,
    );
  }

  return { where: conditions.join(' AND '), values };
}

interface SampleRow {
  id: string;
  agent_name: string | null;
  direction: string | null;
  lifecycle_state: string | null;
  start_time: Date | null;
  failed_tool_count: number;
}

async function evaluateView(view: SavedViewRow, sinceIso: string, untilIso: string): Promise<{ count: number; samples: SampleRow[] }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, view.tenant_id, async () => {});
    const filters = (view.filters ?? {}) as FilterShape;
    const { where, values } = buildFilterClause(view.tenant_id, filters, sinceIso, untilIso);

    const countRes = await client.query(
      `SELECT COUNT(*)::int AS total FROM call_sessions cs WHERE ${where}`,
      values,
    );
    const total = countRes.rows[0]?.total ?? 0;

    let samples: SampleRow[] = [];
    if (total > 0) {
      const sampleRes = await client.query(
        `SELECT cs.id,
                a.name AS agent_name,
                cs.direction,
                cs.lifecycle_state,
                cs.start_time,
                (
                  SELECT COUNT(*)::int FROM tool_invocations ti
                  WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id
                    AND ti.status IN ('failed', 'timeout')
                ) AS failed_tool_count
         FROM call_sessions cs
         LEFT JOIN agents a ON a.id = cs.agent_id
         WHERE ${where}
         ORDER BY cs.start_time DESC
         LIMIT ${SAMPLE_LIMIT}`,
        values,
      );
      samples = sampleRes.rows as SampleRow[];
    }

    await client.query('COMMIT');
    return { count: total, samples };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function loadEnabledViews(): Promise<SavedViewRow[]> {
  const pool = getPlatformPool();
  const { rows } = await pool.query<SavedViewRow>(
    `SELECT id, tenant_id, name, filters, is_shared, created_by,
            digest_enabled, digest_subscribers, digest_last_run_at
     FROM call_saved_views
     WHERE digest_enabled = true
       AND (digest_last_run_at IS NULL OR digest_last_run_at < NOW() - ($1 || ' hours')::interval)`,
    [String(MIN_RESEND_HOURS)],
  );
  return rows;
}

async function getRecipients(view: SavedViewRow): Promise<{ ownerEmail: string | null; subscribers: string[]; tenantName: string | null }> {
  const pool = getPlatformPool();
  let ownerEmail: string | null = null;
  if (view.created_by) {
    const { rows } = await pool.query<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1 AND COALESCE(is_active, TRUE) = TRUE`,
      [view.created_by],
    );
    ownerEmail = rows[0]?.email ?? null;
  }
  const subscribers = view.is_shared ? Array.from(new Set((view.digest_subscribers ?? []).map((e) => e.toLowerCase()))) : [];
  const filtered = subscribers.filter((e) => !!e && (!ownerEmail || e !== ownerEmail.toLowerCase()));

  let tenantName: string | null = null;
  try {
    const { rows } = await pool.query<{ name: string | null }>(
      `SELECT name FROM tenants WHERE id = $1`,
      [view.tenant_id],
    );
    tenantName = rows[0]?.name ?? null;
  } catch { /* ignore */ }

  return { ownerEmail, subscribers: filtered, tenantName };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildViewLink(viewId: string): string {
  const baseUrl =
    process.env.APP_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '');
  const path = `/calls?view=${encodeURIComponent(viewId)}`;
  return baseUrl ? `${baseUrl}${path}` : path;
}

function renderDigest(view: SavedViewRow, count: number, samples: SampleRow[], tenantName: string | null): { subject: string; html: string; text: string } {
  const link = buildViewLink(view.id);
  const orgLine = tenantName ? ` for <strong>${escapeHtml(tenantName)}</strong>` : '';
  const subject = count === 1
    ? `[QVO] 1 new call matches "${view.name}" since your last digest`
    : `[QVO] ${count} new calls match "${view.name}" since your last digest`;

  const sampleRows = samples
    .map((s) => {
      const when = s.start_time ? new Date(s.start_time).toISOString() : '';
      const failedBadge = s.failed_tool_count > 0
        ? `<span style="color:#b91c1c;font-weight:600">${s.failed_tool_count} failed tool${s.failed_tool_count === 1 ? '' : 's'}</span>`
        : '';
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(s.agent_name ?? '—')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(s.direction ?? '—')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(s.lifecycle_state ?? '—')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#475569">${escapeHtml(when)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${failedBadge}</td>
      </tr>`;
    })
    .join('');

  const moreLine = count > samples.length
    ? `<p style="margin:12px 0 0;color:#64748b;font-size:13px">…and ${count - samples.length} more.</p>`
    : '';

  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:720px">
      <h2 style="margin:0 0 8px">Daily call digest${orgLine}</h2>
      <p style="margin:0 0 12px;color:#475569">
        Your saved view <strong>"${escapeHtml(view.name)}"</strong> picked up
        <strong>${count}</strong> new matching call${count === 1 ? '' : 's'} in the last 24 hours.
      </p>
      <p style="margin:0 0 16px"><a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Open the view</a></p>
      ${samples.length > 0 ? `
      <table style="border-collapse:collapse;font-size:13px;width:100%">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:8px 10px">Agent</th>
            <th style="padding:8px 10px">Direction</th>
            <th style="padding:8px 10px">Status</th>
            <th style="padding:8px 10px">Started</th>
            <th style="padding:8px 10px">Tools</th>
          </tr>
        </thead>
        <tbody>${sampleRows}</tbody>
      </table>` : ''}
      ${moreLine}
      <p style="margin:24px 0 0;color:#94a3b8;font-size:12px">
        You're receiving this because the daily digest is enabled on this saved view.
        Turn it off from the saved view settings on the Conversations page.
      </p>
    </div>`;

  const textSamples = samples
    .map((s) => `- ${s.agent_name ?? '—'} | ${s.direction ?? '—'} | ${s.lifecycle_state ?? '—'} | ${s.start_time ? new Date(s.start_time).toISOString() : ''}${s.failed_tool_count > 0 ? ` | ${s.failed_tool_count} failed tools` : ''}`)
    .join('\n');

  const text = [
    `Daily call digest${tenantName ? ` for ${tenantName}` : ''}`,
    '',
    `Your saved view "${view.name}" picked up ${count} new matching call${count === 1 ? '' : 's'} in the last 24 hours.`,
    `Open the view: ${link}`,
    '',
    samples.length > 0 ? 'Most recent matches:' : '',
    textSamples,
    count > samples.length ? `…and ${count - samples.length} more.` : '',
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

async function markRan(viewId: string, count: number): Promise<void> {
  const pool = getPlatformPool();
  await pool.query(
    `UPDATE call_saved_views
     SET digest_last_run_at = NOW(), digest_last_match_count = $2
     WHERE id = $1`,
    [viewId, count],
  );
}

export interface DigestCycleResult {
  viewsChecked: number;
  emailsSent: number;
  emptyViews: number;
}

export async function runCallViewDigestCycle(): Promise<DigestCycleResult> {
  let views: SavedViewRow[];
  try {
    views = await loadEnabledViews();
  } catch (err) {
    logger.error('Failed to load enabled saved views', { error: String(err) });
    return { viewsChecked: 0, emailsSent: 0, emptyViews: 0 };
  }
  if (views.length === 0) {
    logger.debug('No saved views with digest enabled (or all recently sent)');
    return { viewsChecked: 0, emailsSent: 0, emptyViews: 0 };
  }

  const now = Date.now();
  const untilIso = new Date(now).toISOString();
  // Hard cap the lookback window at 24h even if the view hasn't been digested in a long time.
  const maxLookbackIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  let emailsSent = 0;
  let emptyViews = 0;

  for (const view of views) {
    try {
      // Per-view watermark: only count calls that are *new since the last digest run*.
      // Falls back to the 24h cap if this view has never run, or if the prior run was
      // older than 24h (we don't want to send "new today" with calls older than a day).
      const lastRunIso = view.digest_last_run_at
        ? new Date(view.digest_last_run_at).toISOString()
        : null;
      const sinceIso = lastRunIso && lastRunIso > maxLookbackIso ? lastRunIso : maxLookbackIso;
      const { count, samples } = await evaluateView(view, sinceIso, untilIso);
      if (count === 0) {
        emptyViews += 1;
        await markRan(view.id, 0);
        continue;
      }

      const { ownerEmail, subscribers, tenantName } = await getRecipients(view);
      const recipients: string[] = [];
      if (ownerEmail) recipients.push(ownerEmail);
      for (const s of subscribers) if (!recipients.includes(s)) recipients.push(s);

      if (recipients.length === 0) {
        logger.warn('Saved view has digest enabled but no resolvable recipients', { viewId: view.id, tenantId: view.tenant_id });
        await markRan(view.id, count);
        continue;
      }

      const tpl = renderDigest(view, count, samples, tenantName);
      const result = await sendEmail({
        to: recipients.join(', '),
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      if (result.success) {
        emailsSent += 1;
        // Only advance the watermark on a successful send. On failure we leave
        // digest_last_run_at unchanged so the next cycle retries the same matches.
        await markRan(view.id, count);
      } else {
        logger.error('Failed to send call view digest — watermark NOT advanced; will retry next cycle', {
          viewId: view.id,
          tenantId: view.tenant_id,
          recipients: recipients.length,
          matchCount: count,
          error: result.error,
        });
      }
    } catch (err) {
      logger.error('Saved view digest evaluation failed', { viewId: view.id, tenantId: view.tenant_id, error: String(err) });
    }
  }

  logger.info('Call view digest cycle complete', {
    viewsChecked: views.length,
    emailsSent,
    emptyViews,
  });

  return { viewsChecked: views.length, emailsSent, emptyViews };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startCallViewDigestScheduler(intervalMs: number = CHECK_INTERVAL_MS): void {
  if (timer) return;
  initialTimer = setTimeout(() => {
    runCallViewDigestCycle().catch((err) => {
      logger.error('Initial call view digest cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);
  timer = setInterval(() => {
    runCallViewDigestCycle().catch((err) => {
      logger.error('Call view digest cycle failed', { error: String(err) });
    });
  }, intervalMs);
  logger.info('Call view digest scheduler started', { intervalMs });
}

export function stopCallViewDigestScheduler(): void {
  if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
  if (timer) { clearInterval(timer); timer = null; logger.info('Call view digest scheduler stopped'); }
}
