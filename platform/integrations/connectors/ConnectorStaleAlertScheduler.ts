import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import { sendEmail } from '../../email';
import { postToOpsSlackWebhook } from '../../messaging/SlackWebhookNotifier';
import { listConnectorTokenHealth } from './db';
import type { ConnectorTokenHealthRow } from './db';
import { getRefreshableProviders } from './tokenRefresh';
import {
  REFRESH_CYCLE_INTERVAL_MS,
  STALE_CYCLE_THRESHOLD,
  computeStaleEvaluation,
  type StaleEvaluation,
} from './connectorStaleHealth';

const logger = createLogger('CONNECTOR_STALE_ALERT');

/**
 * Cycle cadence. The Connector Health route uses a 15-min sweep yardstick
 * for the stale badge, but ops doesn't need a noisy half-hour digest of
 * connectors that are wedged for days at a time. A daily cycle keeps the
 * inbox sane while still catching new outages well within an SLA day.
 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Wait a few minutes after boot before the first cycle so RLS / migrations are fully up. */
const INITIAL_DELAY_MS = 6 * 60 * 1000;

/**
 * Cooldown between re-alerts for the same (tenant, integration). Ops asked
 * for "permanently broken integration doesn't spam every cycle" — without
 * a cooldown the same wedged Salesforce row would surface in every daily
 * digest until someone reconnects. 7 days matches the docs feedback
 * scheduler's `COOLDOWN_DAYS` and is short enough that ops still gets a
 * reminder if a long-running outage is forgotten about.
 */
const RE_ALERT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const PROVIDER_LABELS: Record<string, string> = {
  salesforce: 'Salesforce',
  hubspot: 'HubSpot',
  quickbooks: 'QuickBooks',
  google: 'Google',
  google_calendar: 'Google Calendar',
  outlook: 'Outlook',
  outlook_calendar: 'Outlook Calendar',
  microsoft: 'Microsoft',
  pipedrive: 'Pipedrive',
  slack: 'Slack',
  zapier: 'Zapier',
  twilio: 'Twilio',
};

function providerLabel(provider: string | null | undefined): string {
  if (!provider) return 'Integration';
  return PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
}

function appBaseUrl(): string {
  return (
    process.env.APP_URL ??
    `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface StaleConnectorEntry {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string;
  integrationType: string;
  provider: string;
  providerLabel: string;
  name: string | null;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastSyncErrorAt: string | null;
  status: StaleEvaluation['status'];
  cyclesSinceRefresh: number | null;
  expiresInMs: number | null;
}

interface StaleAlertLedgerRow {
  tenant_id: string;
  integration_id: string;
  last_alerted_at: Date | string;
  resolved_at: Date | string | null;
  alert_count: number;
}

/**
 * Pull every currently-stale row from the same data source the Connector
 * Health route uses, applying the shared `computeStaleEvaluation` predicate
 * so the badge in the admin UI and this digest never disagree.
 *
 * Any failure to load the snapshot is *propagated*, not swallowed. Returning
 * `[]` on error would be indistinguishable from "no stale connectors", which
 * causes `runConnectorStaleAlertCycle` to mark every unresolved ledger row
 * as recovered — and on the next successful cycle re-page ops for every
 * still-broken connector. The caller catches and aborts the cycle without
 * touching the ledger.
 */
export async function findStaleConnectors(
  nowMs: number = Date.now(),
): Promise<StaleConnectorEntry[]> {
  // Strict mode: any per-tenant failure during the snapshot fan-out
  // bubbles up so the cycle aborts cleanly instead of silently treating a
  // partial snapshot as authoritative (which would mass-resolve every
  // ledger row whose tenant happened to fail this cycle).
  const snapshots = await listConnectorTokenHealth(getRefreshableProviders(), {
    onTenantError: 'throw',
  });

  const stale: StaleConnectorEntry[] = [];
  for (const s of snapshots) {
    const evaluation = computeStaleEvaluation(s, nowMs);
    if (!evaluation.stale) continue;
    stale.push({
      tenantId: s.tenantId,
      tenantName: s.tenantName,
      tenantSlug: s.tenantSlug,
      integrationId: s.integrationId,
      integrationType: s.integrationType,
      provider: s.provider,
      providerLabel: providerLabel(s.provider),
      name: s.name,
      lastSyncStatus: s.lastSyncStatus,
      lastSyncAt: s.lastSyncAt,
      lastSyncErrorAt: s.lastSyncErrorAt,
      status: evaluation.status,
      cyclesSinceRefresh: evaluation.cyclesSinceRefresh,
      expiresInMs: evaluation.expiresInMs,
    });
  }

  // Group by tenant for stable digest ordering, then by integration name so
  // the email reads consistently across cycles.
  stale.sort((a, b) => {
    const at = (a.tenantName ?? a.tenantId).localeCompare(b.tenantName ?? b.tenantId);
    if (at !== 0) return at;
    return (a.name ?? a.providerLabel).localeCompare(b.name ?? b.providerLabel);
  });
  return stale;
}

export interface StaleAlertDecision {
  /** Entries that need an alert this cycle (new outages or past cooldown). */
  toAlert: StaleConnectorEntry[];
  /** Entries currently stale but inside the cooldown window — counted, not paged. */
  suppressed: StaleConnectorEntry[];
  /**
   * Ledger keys that previously fired but are no longer stale. Their
   * `resolved_at` should be stamped so the next time they re-stale we
   * surface them as a fresh outage instead of treating it as a continuing
   * one.
   */
  recovered: Array<{ tenantId: string; integrationId: string }>;
}

/**
 * Decide which currently-stale connectors deserve a notification this cycle
 * given the existing dedup ledger. Pulled out so tests can pin the cooldown
 * behavior without mocking SMTP / Slack.
 */
export function decideStaleAlerts(
  stale: StaleConnectorEntry[],
  ledger: StaleAlertLedgerRow[],
  nowMs: number,
  cooldownMs: number = RE_ALERT_COOLDOWN_MS,
): StaleAlertDecision {
  const ledgerByKey = new Map<string, StaleAlertLedgerRow>();
  for (const row of ledger) {
    ledgerByKey.set(`${row.tenant_id}:${row.integration_id}`, row);
  }
  const currentKeys = new Set<string>();

  const toAlert: StaleConnectorEntry[] = [];
  const suppressed: StaleConnectorEntry[] = [];

  for (const entry of stale) {
    const key = `${entry.tenantId}:${entry.integrationId}`;
    currentKeys.add(key);
    const existing = ledgerByKey.get(key);
    if (!existing) {
      // Brand new outage — always alert.
      toAlert.push(entry);
      continue;
    }
    if (existing.resolved_at) {
      // Recovered then re-stale → page again. Caller clears resolved_at
      // when stamping the new alert.
      toAlert.push(entry);
      continue;
    }
    const lastAlertedMs = new Date(existing.last_alerted_at as string | Date).getTime();
    if (!Number.isFinite(lastAlertedMs) || nowMs - lastAlertedMs >= cooldownMs) {
      // Long-running outage — past the cooldown, send a reminder.
      toAlert.push(entry);
    } else {
      suppressed.push(entry);
    }
  }

  // Anything in the ledger we didn't touch this cycle (still un-resolved)
  // has either recovered organically or been disabled. Stamp recovery so a
  // future re-stale fires fresh.
  const recovered: StaleAlertDecision['recovered'] = [];
  for (const row of ledger) {
    if (row.resolved_at) continue;
    const key = `${row.tenant_id}:${row.integration_id}`;
    if (!currentKeys.has(key)) {
      recovered.push({ tenantId: row.tenant_id, integrationId: row.integration_id });
    }
  }

  return { toAlert, suppressed, recovered };
}

async function loadAlertLedger(): Promise<StaleAlertLedgerRow[]> {
  const pool = getPlatformPool();
  const { rows } = await pool.query<StaleAlertLedgerRow>(
    `SELECT tenant_id, integration_id, last_alerted_at, resolved_at, alert_count
       FROM connector_stale_alerts`,
  );
  return rows;
}

async function stampAlerted(entries: StaleConnectorEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const pool = getPlatformPool();
  // One row per entry rather than a single bulk INSERT … VALUES (…) so the
  // dedup logic stays trivially correct: each upsert recomputes
  // `alert_count + 1` against its own existing row, and a single failure
  // doesn't poison the whole batch.
  for (const entry of entries) {
    try {
      await pool.query(
        `INSERT INTO connector_stale_alerts
            (tenant_id, integration_id, last_provider, last_status,
             first_alerted_at, last_alerted_at, alert_count, resolved_at)
          VALUES ($1, $2, $3, $4, NOW(), NOW(), 1, NULL)
          ON CONFLICT (tenant_id, integration_id) DO UPDATE SET
            last_alerted_at = NOW(),
            last_provider = EXCLUDED.last_provider,
            last_status = EXCLUDED.last_status,
            alert_count = connector_stale_alerts.alert_count + 1,
            resolved_at = NULL`,
        [entry.tenantId, entry.integrationId, entry.provider, entry.status],
      );
    } catch (err) {
      logger.warn('Failed to stamp connector stale alert', {
        tenantId: entry.tenantId,
        integrationId: entry.integrationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function stampResolved(
  recovered: Array<{ tenantId: string; integrationId: string }>,
): Promise<void> {
  if (recovered.length === 0) return;
  const pool = getPlatformPool();
  for (const r of recovered) {
    try {
      await pool.query(
        `UPDATE connector_stale_alerts
            SET resolved_at = NOW()
          WHERE tenant_id = $1
            AND integration_id = $2
            AND resolved_at IS NULL`,
        [r.tenantId, r.integrationId],
      );
    } catch (err) {
      logger.warn('Failed to stamp connector stale recovery', {
        tenantId: r.tenantId,
        integrationId: r.integrationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function getPlatformAdminEmails(): Promise<string[]> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query<{ email: string }>(
      `SELECT email FROM users
        WHERE is_platform_admin = TRUE
          AND COALESCE(is_active, TRUE) = TRUE
          AND email IS NOT NULL`,
    );
    const emails = rows.map((r) => r.email).filter((e) => !!e && e.includes('@'));
    return Array.from(new Set(emails));
  } catch (err) {
    logger.warn('Failed to load platform admin emails', { error: String(err) });
    return [];
  }
}

function describeWedgeDuration(entry: StaleConnectorEntry): string {
  // Prefer "X cycles since refresh" because that's the same yardstick the
  // admin UI uses. Fall back to "needs reconnect" for rows that lack any
  // token timing metadata at all.
  if (entry.cyclesSinceRefresh !== null) {
    const minutes = entry.cyclesSinceRefresh * (REFRESH_CYCLE_INTERVAL_MS / 60_000);
    if (minutes >= 60 * 24) {
      const days = Math.round(minutes / (60 * 24));
      return `~${days}d wedged (${entry.cyclesSinceRefresh} cycles missed)`;
    }
    if (minutes >= 60) {
      const hours = Math.round(minutes / 60);
      return `~${hours}h wedged (${entry.cyclesSinceRefresh} cycles missed)`;
    }
    return `~${Math.round(minutes)}m wedged (${entry.cyclesSinceRefresh} cycles missed)`;
  }
  return entry.status === 'needs_reconnect' ? 'awaiting reconnect' : 'wedged';
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

export function renderStaleConnectorDigest(
  entries: StaleConnectorEntry[],
  appUrl: string = appBaseUrl(),
): RenderedDigest {
  const dashboardLink = `${appUrl.replace(/\/$/, '')}/admin/integrations#connector-health`;

  const subject =
    entries.length === 1
      ? `[QVO Ops] 1 connector wedged (${entries[0].providerLabel})`
      : `[QVO Ops] ${entries.length} connectors wedged`;

  const rows = entries
    .map((e) => {
      const tenantLabel = e.tenantName ?? e.tenantSlug ?? e.tenantId;
      const integrationLabel = e.name ?? e.providerLabel;
      const wedge = describeWedgeDuration(e);
      const statusLabel =
        e.status === 'needs_reconnect'
          ? 'needs_reconnect'
          : e.status === 'expired'
            ? 'token expired'
            : e.status;
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(tenantLabel)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(integrationLabel)} <span style="color:#64748b">(${escapeHtml(e.providerLabel)})</span></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#b91c1c">${escapeHtml(statusLabel)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(wedge)}</td>
      </tr>`;
    })
    .join('');

  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:760px">
      <h2 style="margin:0 0 8px">Connectors stuck past auto-refresh</h2>
      <p style="margin:0 0 12px;color:#475569">
        The OAuth refresh worker has missed at least ${STALE_CYCLE_THRESHOLD} sweep
        cycles for the integrations below — ops needs to reach out so the
        affected tenants can reconnect.
      </p>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:8px 10px">Tenant</th>
            <th style="padding:8px 10px">Integration</th>
            <th style="padding:8px 10px">Status</th>
            <th style="padding:8px 10px">Wedged</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:16px 0 0;color:#475569">
        Open the <a href="${dashboardLink}">Platform Admin → Connector Health</a> panel
        to triage. Each connector is muted for ${Math.round(RE_ALERT_COOLDOWN_MS / (24 * 60 * 60 * 1000))} days after this alert
        unless it recovers and re-fails.
      </p>
    </div>`;

  const textLines = [
    'Connectors stuck past auto-refresh',
    '',
    ...entries.map((e) => {
      const tenantLabel = e.tenantName ?? e.tenantSlug ?? e.tenantId;
      const integrationLabel = e.name ?? e.providerLabel;
      return `- [${tenantLabel}] ${integrationLabel} (${e.providerLabel}) — ${e.status}, ${describeWedgeDuration(e)}`;
    }),
    '',
    `Triage: ${dashboardLink}`,
  ];

  return { subject, html, text: textLines.join('\n') };
}

function renderSlackBlocks(entries: StaleConnectorEntry[], appUrl: string): unknown[] {
  const dashboardLink = `${appUrl.replace(/\/$/, '')}/admin/integrations#connector-health`;
  const headerText =
    entries.length === 1
      ? '1 connector wedged past auto-refresh'
      : `${entries.length} connectors wedged past auto-refresh`;

  const previewLimit = 10;
  const preview = entries.slice(0, previewLimit);
  const moreCount = entries.length - preview.length;

  const lines = preview.map((e) => {
    const tenantLabel = e.tenantName ?? e.tenantSlug ?? e.tenantId;
    const integrationLabel = e.name ?? e.providerLabel;
    return `• *${tenantLabel}* — ${integrationLabel} (${e.providerLabel}): ${e.status}, ${describeWedgeDuration(e)}`;
  });
  if (moreCount > 0) {
    lines.push(`…and ${moreCount} more.`);
  }

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':warning: Connector Health: stale connectors', emoji: true },
    },
    { type: 'section', text: { type: 'mrkdwn', text: headerText } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${dashboardLink}|Open Connector Health panel>` }],
    },
  ];
}

export interface StaleAlertCycleResult {
  staleCount: number;
  alertedCount: number;
  suppressedCount: number;
  recoveredCount: number;
  emailDelivered: boolean;
  slackDelivered: boolean;
  recipients: number;
  /**
   * True when we couldn't load the connector token-health snapshot. The
   * cycle exits early without touching the ledger so a transient DB blip
   * doesn't mass-resolve every stale alert and re-page everything next
   * cycle.
   */
  snapshotLoadFailed?: boolean;
}

export async function runConnectorStaleAlertCycle(
  options: { nowMs?: number; cooldownMs?: number } = {},
): Promise<StaleAlertCycleResult> {
  const nowMs = options.nowMs ?? Date.now();
  const cooldownMs = options.cooldownMs ?? RE_ALERT_COOLDOWN_MS;

  let stale: StaleConnectorEntry[];
  try {
    stale = await findStaleConnectors(nowMs);
  } catch (err) {
    // Critical: if the snapshot fetch fails we cannot tell "no stale
    // connectors" from "DB unreachable", and any auto-resolution path
    // would corrupt dedup state. Bail without writing to the ledger.
    logger.error('Skipping connector stale alert cycle — snapshot load failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      staleCount: 0,
      alertedCount: 0,
      suppressedCount: 0,
      recoveredCount: 0,
      emailDelivered: false,
      slackDelivered: false,
      recipients: 0,
      snapshotLoadFailed: true,
    };
  }

  let ledger: StaleAlertLedgerRow[];
  try {
    ledger = await loadAlertLedger();
  } catch (err) {
    logger.error('Failed to load connector stale alert ledger', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      staleCount: stale.length,
      alertedCount: 0,
      suppressedCount: 0,
      recoveredCount: 0,
      emailDelivered: false,
      slackDelivered: false,
      recipients: 0,
    };
  }

  const decision = decideStaleAlerts(stale, ledger, nowMs, cooldownMs);

  // Always stamp recoveries — even if there's nothing new to alert about,
  // we want the ledger to reflect that previously-broken integrations are
  // now healthy so the next regression fires fresh.
  await stampResolved(decision.recovered);

  if (decision.toAlert.length === 0) {
    logger.debug('No new stale connectors to alert on', {
      staleCount: stale.length,
      suppressed: decision.suppressed.length,
      recovered: decision.recovered.length,
    });
    return {
      staleCount: stale.length,
      alertedCount: 0,
      suppressedCount: decision.suppressed.length,
      recoveredCount: decision.recovered.length,
      emailDelivered: false,
      slackDelivered: false,
      recipients: 0,
    };
  }

  const digest = renderStaleConnectorDigest(decision.toAlert);
  const slackBlocks = renderSlackBlocks(decision.toAlert, appBaseUrl());

  // Slack is best-effort and decoupled from the email path — same pattern
  // the docs feedback alerts use. A failure on either side still stamps
  // the ledger so we don't re-page on the next cycle inside the cooldown.
  let slackDelivered = false;
  try {
    const slackResult = await postToOpsSlackWebhook({
      text: digest.subject,
      blocks: slackBlocks,
    });
    slackDelivered = slackResult.success;
    if (!slackResult.success && !slackResult.skipped) {
      logger.warn('Failed to deliver connector stale alert to Slack', {
        error: slackResult.error,
      });
    }
  } catch (err) {
    logger.warn('Slack notification threw while alerting stale connectors', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const recipients = await getPlatformAdminEmails();
  let emailDelivered = false;

  if (recipients.length === 0) {
    logger.warn(
      'No platform admin recipients for stale connector digest; stamping ledger anyway',
      { toAlert: decision.toAlert.length },
    );
  } else {
    try {
      const sendResult = await sendEmail({
        to: recipients.join(', '),
        subject: digest.subject,
        html: digest.html,
        text: digest.text,
      });
      emailDelivered = sendResult.success;
      if (!sendResult.success) {
        logger.error('Failed to deliver connector stale alert email', {
          error: sendResult.error,
        });
      }
    } catch (err) {
      logger.error('connector stale alert email threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Stamp the ledger when *any* delivery channel landed, OR when there were
  // no recipients to mail in the first place. If both Slack and email
  // failed and we DO have admins on file, leave the ledger untouched so
  // tomorrow's cycle retries instead of going silent for a week.
  const shouldStamp =
    emailDelivered || slackDelivered || recipients.length === 0;
  if (shouldStamp) {
    await stampAlerted(decision.toAlert);
  }

  logger.info('Connector stale alert cycle complete', {
    staleCount: stale.length,
    alertedCount: decision.toAlert.length,
    suppressedCount: decision.suppressed.length,
    recoveredCount: decision.recovered.length,
    recipients: recipients.length,
    emailDelivered,
    slackDelivered,
    stamped: shouldStamp,
  });

  return {
    staleCount: stale.length,
    alertedCount: shouldStamp ? decision.toAlert.length : 0,
    suppressedCount: decision.suppressed.length,
    recoveredCount: decision.recovered.length,
    emailDelivered,
    slackDelivered,
    recipients: recipients.length,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startConnectorStaleAlertScheduler(
  intervalMs: number = CHECK_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runConnectorStaleAlertCycle().catch((err) => {
      logger.error('Initial connector stale alert cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runConnectorStaleAlertCycle().catch((err) => {
      logger.error('Connector stale alert cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  logger.info('Connector stale alert scheduler started', {
    intervalMs,
    cooldownMs: RE_ALERT_COOLDOWN_MS,
  });
}

export function stopConnectorStaleAlertScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Connector stale alert scheduler stopped');
  }
}
