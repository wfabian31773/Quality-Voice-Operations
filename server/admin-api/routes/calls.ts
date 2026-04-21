import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { redactPHI } from '../../../platform/core/phi/redact';
import { createLogger } from '../../../platform/core/logger';
import { getConversationCost } from '../../../platform/billing/cost';
import { notifySubscriberChanges, diffSubscribers } from '../../../platform/analytics/CallViewSubscriberNotifier';

const logger = createLogger('ADMIN_CALLS');

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

export const listCallsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const { agent_id, direction, lifecycle_state, since, q, has_transcript, has_events, has_tool_executions, tool_failures_only } = req.query as Record<string, string>;
  const pool = getPlatformPool();
  const client = await pool.connect();

  const parseBoolFilter = (v: string | undefined): boolean | null => {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return null;
  };
  const transcriptFilter = parseBoolFilter(has_transcript);
  const eventsFilter = parseBoolFilter(has_events);
  const toolsFilter = parseBoolFilter(has_tool_executions);
  const toolFailuresOnly = parseBoolFilter(tool_failures_only) === true;

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const conditions: string[] = ['cs.tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (agent_id) { values.push(agent_id); conditions.push(`cs.agent_id = $${values.length}`); }
    if (direction) { values.push(direction); conditions.push(`cs.direction = $${values.length}`); }
    if (lifecycle_state) { values.push(lifecycle_state); conditions.push(`cs.lifecycle_state = $${values.length}`); }
    if (since) { values.push(since); conditions.push(`cs.start_time >= $${values.length}::timestamptz`); }
    if (q && q.trim()) {
      const term = `%${q.trim()}%`;
      values.push(term);
      const idx = values.length;
      conditions.push(
        `(cs.caller_number ILIKE $${idx} OR cs.called_number ILIKE $${idx} OR cs.id::text ILIKE $${idx})`,
      );
    }
    if (transcriptFilter !== null) {
      const op = transcriptFilter ? 'EXISTS' : 'NOT EXISTS';
      conditions.push(`${op} (SELECT 1 FROM call_transcripts ct WHERE ct.call_session_id = cs.id AND ct.tenant_id = cs.tenant_id)`);
    }
    if (eventsFilter !== null) {
      const op = eventsFilter ? 'EXISTS' : 'NOT EXISTS';
      conditions.push(`${op} (SELECT 1 FROM call_events ce WHERE ce.call_session_id = cs.id AND ce.tenant_id = cs.tenant_id)`);
    }
    if (toolsFilter !== null) {
      const op = toolsFilter ? 'EXISTS' : 'NOT EXISTS';
      conditions.push(`${op} (SELECT 1 FROM tool_invocations ti WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id)`);
    }
    if (toolFailuresOnly) {
      conditions.push(
        `EXISTS (SELECT 1 FROM tool_invocations ti WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id AND ti.status IN ('failed', 'timeout'))`,
      );
    }

    const where = conditions.join(' AND ');
    const { rows } = await client.query(
      `SELECT cs.id, cs.caller_number, cs.called_number,
              cs.agent_id, cs.direction, cs.lifecycle_state,
              cs.start_time, cs.end_time, cs.duration_seconds,
              cs.total_cost_cents, cs.environment, cs.created_at,
              a.name AS agent_name,
              EXISTS (
                SELECT 1 FROM call_transcripts ct
                WHERE ct.call_session_id = cs.id AND ct.tenant_id = cs.tenant_id
              ) AS has_transcript,
              EXISTS (
                SELECT 1 FROM call_events ce
                WHERE ce.call_session_id = cs.id AND ce.tenant_id = cs.tenant_id
              ) AS has_events,
              (
                SELECT COUNT(*)::int FROM tool_invocations ti
                WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id
              ) AS tool_count,
              (
                SELECT COUNT(*)::int FROM tool_invocations ti
                WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id
                  AND ti.status IN ('failed', 'timeout')
              ) AS failed_tool_count
       FROM call_sessions cs
       LEFT JOIN agents a ON a.id = cs.agent_id
       WHERE ${where}
       ORDER BY cs.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) AS total FROM call_sessions cs WHERE ${where}`,
      values,
    );
    await client.query('COMMIT');

    const calls = rows.map((r) => {
      const out = { ...r } as Record<string, unknown>;
      if (typeof out.caller_number === 'string') out.caller_number = redactPHI(out.caller_number);
      if (typeof out.called_number === 'string') out.called_number = redactPHI(out.called_number);
      return out;
    });

    return res.json({
      calls,
      total: parseInt(countRows[0].total as string),
      limit,
      offset,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list calls', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list calls' });
  } finally {
    client.release();
  }
};

export const getCallHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT cs.*, a.name AS agent_name
       FROM call_sessions cs
       LEFT JOIN agents a ON a.id = cs.agent_id
       WHERE cs.id = $1 AND cs.tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    if (rows.length === 0) return res.status(404).json({ error: 'Call not found' });

    const call = rows[0] as Record<string, unknown>;
    if (call.caller_number) call.caller_number = redactPHI(call.caller_number as string);
    if (call.called_number) call.called_number = redactPHI(call.called_number as string);
    if (call.escalation_target) call.escalation_target = redactPHI(call.escalation_target as string);

    let costBreakdown = null;
    try {
      costBreakdown = await getConversationCost(tenantId, id);
    } catch {}

    return res.json({ call, costBreakdown });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Failed to retrieve call' });
  } finally {
    client.release();
  }
};

const getTranscriptHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: sessionRows } = await client.query(
      `SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (sessionRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Call not found' });
    }

    const { rows: lines } = await client.query(
      `SELECT id, role, content, sequence_number, occurred_at
       FROM call_transcripts
       WHERE call_session_id = $1 AND tenant_id = $2
       ORDER BY sequence_number ASC, occurred_at ASC`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    return res.json({ callId: id, transcript: lines });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get transcript', { tenantId, callId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve transcript' });
  } finally {
    client.release();
  }
};

const getCallEventsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: sessionRows } = await client.query(
      `SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (sessionRows.length === 0) {
      await client.query('COMMIT');
      return res.status(404).json({ error: 'Call not found' });
    }

    const { rows: events } = await client.query(
      `SELECT id, event_type, from_state, to_state, payload, occurred_at
       FROM call_events
       WHERE call_session_id = $1 AND tenant_id = $2
       ORDER BY occurred_at ASC`,
      [id, tenantId],
    );
    await client.query('COMMIT');

    return res.json({ callId: id, events });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get call events', { tenantId, callId: id, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve call events' });
  } finally {
    client.release();
  }
};

const listSavedViewsHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT id, name, filters, is_shared, is_pinned, created_by, created_at, updated_at,
              digest_enabled, digest_subscribers, digest_last_run_at, digest_last_match_count
       FROM call_saved_views
       WHERE tenant_id = $1 AND (created_by = $2 OR is_shared = true)
       ORDER BY name ASC`,
      [tenantId, userId],
    );
    await client.query('COMMIT');
    return res.json({ views: rows });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list call saved views', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list saved views' });
  } finally {
    client.release();
  }
};

function sanitizeSubscribers(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const cleaned: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) continue;
    if (e.length > 320) continue;
    if (!cleaned.includes(e)) cleaned.push(e);
    if (cleaned.length >= 50) break;
  }
  return cleaned;
}

// Restrict subscriber emails to active members of the same tenant. This prevents
// a saved-view owner from exfiltrating tenant call data to arbitrary external addresses.
async function filterToTenantMembers(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ email: string }> }> },
  tenantId: string,
  candidates: string[],
): Promise<{ allowed: string[]; rejected: string[] }> {
  if (candidates.length === 0) return { allowed: [], rejected: [] };
  const { rows } = await client.query(
    `SELECT LOWER(email) AS email FROM users WHERE tenant_id = $1 AND is_active = TRUE AND LOWER(email) = ANY($2::text[])`,
    [tenantId, candidates],
  );
  const allowedSet = new Set(rows.map((r) => r.email));
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const e of candidates) {
    if (allowedSet.has(e)) allowed.push(e);
    else rejected.push(e);
  }
  return { allowed, rejected };
}

function buildSavedViewCallConditions(filters: Record<string, unknown>): { conditions: string[]; values: unknown[] } {
  const conditions: string[] = ['cs.tenant_id = $1'];
  const values: unknown[] = [];
  const get = (k: string): string => {
    const v = filters[k];
    return typeof v === 'string' ? v : '';
  };
  const agent_id = get('agent_id');
  const direction = get('direction');
  const lifecycle_state = get('lifecycle_state');
  const dateRange = get('dateRange');
  const has_transcript = get('has_transcript');
  const has_events = get('has_events');
  const has_tool_executions = get('has_tool_executions');
  const tool_failures_only = get('tool_failures_only');
  const q = get('q');

  if (agent_id) { values.push(agent_id); conditions.push(`cs.agent_id = $${values.length + 1}`); }
  if (direction) { values.push(direction); conditions.push(`cs.direction = $${values.length + 1}`); }
  if (lifecycle_state) { values.push(lifecycle_state); conditions.push(`cs.lifecycle_state = $${values.length + 1}`); }
  if (dateRange) {
    const now = Date.now();
    let sinceMs: number | null = null;
    if (dateRange === 'today') {
      const d = new Date();
      sinceMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    } else if (dateRange === '7d') sinceMs = now - 7 * 86_400_000;
    else if (dateRange === '30d') sinceMs = now - 30 * 86_400_000;
    if (sinceMs !== null) {
      values.push(new Date(sinceMs).toISOString());
      conditions.push(`cs.start_time >= $${values.length + 1}::timestamptz`);
    }
  }
  if (q && q.trim()) {
    values.push(`%${q.trim()}%`);
    const idx = values.length + 1;
    conditions.push(`(cs.caller_number ILIKE $${idx} OR cs.called_number ILIKE $${idx} OR cs.id::text ILIKE $${idx})`);
  }
  const parseBool = (v: string): boolean | null => (v === 'true' || v === '1') ? true : (v === 'false' || v === '0') ? false : null;
  const tf = parseBool(has_transcript);
  if (tf !== null) {
    const op = tf ? 'EXISTS' : 'NOT EXISTS';
    conditions.push(`${op} (SELECT 1 FROM call_transcripts ct WHERE ct.call_session_id = cs.id AND ct.tenant_id = cs.tenant_id)`);
  }
  const ef = parseBool(has_events);
  if (ef !== null) {
    const op = ef ? 'EXISTS' : 'NOT EXISTS';
    conditions.push(`${op} (SELECT 1 FROM call_events ce WHERE ce.call_session_id = cs.id AND ce.tenant_id = cs.tenant_id)`);
  }
  const xf = parseBool(has_tool_executions);
  if (xf !== null) {
    const op = xf ? 'EXISTS' : 'NOT EXISTS';
    conditions.push(`${op} (SELECT 1 FROM tool_invocations ti WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id)`);
  }
  if (parseBool(tool_failures_only) === true) {
    conditions.push(`EXISTS (SELECT 1 FROM tool_invocations ti WHERE ti.call_session_id = cs.id AND ti.tenant_id = cs.tenant_id AND ti.status IN ('failed', 'timeout'))`);
  }
  return { conditions, values };
}

const listPinnedSavedViewsHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows: views } = await client.query(
      `SELECT id, name, filters, is_shared, is_pinned, created_by
       FROM call_saved_views
       WHERE tenant_id = $1 AND is_pinned = true AND (created_by = $2 OR is_shared = true)
       ORDER BY name ASC`,
      [tenantId, userId],
    );
    const enriched = await Promise.all(
      views.map(async (v: { id: string; name: string; filters: Record<string, unknown> | null; is_shared: boolean; is_pinned: boolean; created_by: string | null }) => {
        const filters = (v.filters && typeof v.filters === 'object') ? v.filters : {};
        const { conditions, values } = buildSavedViewCallConditions(filters);
        const where = conditions.join(' AND ');
        try {
          const { rows: countRows } = await client.query(
            `SELECT COUNT(*)::int AS count FROM call_sessions cs WHERE ${where}`,
            [tenantId, ...values],
          );
          return { ...v, count: countRows[0]?.count ?? 0 };
        } catch (err) {
          logger.warn('Failed to count pinned view matches', { tenantId, viewId: v.id, error: String(err) });
          return { ...v, count: null };
        }
      }),
    );
    await client.query('COMMIT');
    return res.json({ views: enriched });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to list pinned call saved views', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list pinned saved views' });
  } finally {
    client.release();
  }
};

const createSavedViewHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId, email: requesterEmail } = req.user!;
  const { name, filters, is_shared, is_pinned, digest_enabled, digest_subscribers } = req.body as {
    name?: string;
    filters?: Record<string, unknown>;
    is_shared?: boolean;
    is_pinned?: boolean;
    digest_enabled?: boolean;
    digest_subscribers?: unknown;
  };
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return res.status(400).json({ error: 'name is required' });
  if (trimmed.length > 255) return res.status(400).json({ error: 'name too long' });
  if (filters && typeof filters !== 'object') return res.status(400).json({ error: 'filters must be an object' });
  const subs = digest_subscribers !== undefined ? sanitizeSubscribers(digest_subscribers) : [];
  if (digest_subscribers !== undefined && subs === null) {
    return res.status(400).json({ error: 'digest_subscribers must be an array of emails' });
  }
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    let allowedSubs: string[] = [];
    if (subs && subs.length > 0) {
      const { allowed, rejected } = await filterToTenantMembers(client, tenantId, subs);
      if (rejected.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'digest_subscribers may only contain emails of active users in your workspace',
          rejected,
        });
      }
      allowedSubs = allowed;
    }
    const { rows } = await client.query(
      `INSERT INTO call_saved_views (tenant_id, name, filters, is_shared, is_pinned, created_by, digest_enabled, digest_subscribers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, filters, is_shared, is_pinned, created_by, created_at, updated_at,
                 digest_enabled, digest_subscribers, digest_last_run_at, digest_last_match_count`,
      [tenantId, trimmed, JSON.stringify(filters || {}), Boolean(is_shared), Boolean(is_pinned), userId, Boolean(digest_enabled), allowedSubs],
    );
    await client.query('COMMIT');
    if (allowedSubs.length > 0) {
      void notifySubscriberChanges({
        tenantId,
        viewId: rows[0].id,
        viewName: trimmed,
        actorUserId: userId,
        actorEmail: requesterEmail ?? null,
        added: allowedSubs,
        removed: [],
      }).catch((err) => logger.error('Subscriber notification failed (create)', { error: String(err) }));
    }
    return res.status(201).json({ view: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to create call saved view', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create saved view' });
  } finally {
    client.release();
  }
};

const updateSavedViewHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId, email: requesterEmail } = req.user!;
  const { id } = req.params;
  const { name, filters, is_shared, is_pinned, digest_enabled, digest_subscribers } = req.body as {
    name?: string;
    filters?: Record<string, unknown>;
    is_shared?: boolean;
    is_pinned?: boolean;
    digest_enabled?: boolean;
    digest_subscribers?: unknown;
  };
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows: existing } = await client.query(
      `SELECT created_by, is_shared, digest_subscribers FROM call_saved_views WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (existing.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Saved view not found' });
    }
    const isOwner = existing[0].created_by === userId;
    const isShared = existing[0].is_shared === true;
    let effectiveDigestSubscribers: unknown = digest_subscribers;
    const currentSubs: string[] = Array.isArray(existing[0].digest_subscribers)
      ? (existing[0].digest_subscribers as string[]).map((e) => String(e).toLowerCase())
      : [];
    // Allow non-owners to edit only their own digest_subscribers entry on a shared view.
    const onlyDigestSubsChange =
      name === undefined && filters === undefined && is_shared === undefined && is_pinned === undefined &&
      digest_enabled === undefined && digest_subscribers !== undefined;
    if (!isOwner) {
      if (!(isShared && onlyDigestSubsChange)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the owner can edit this view' });
      }
      // Non-owner subscriber edits are constrained to add/remove only the requester's own
      // verified account email, against the existing subscriber list. They cannot replace
      // the list, add other people, or invite arbitrary external addresses.
      const requested = sanitizeSubscribers(digest_subscribers);
      const myEmail = (requesterEmail ?? '').trim().toLowerCase();
      if (!myEmail) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Your account has no email on file' });
      }
      if (requested === null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'digest_subscribers must be an array of emails' });
      }
      const currentSet = new Set(currentSubs);
      const requestedSet = new Set(requested);
      const wantsAdd = requestedSet.has(myEmail);
      const wantsRemove = !wantsAdd;
      // Diff what changed; the only delta allowed is the requester's own email being toggled.
      const added = [...requestedSet].filter((e) => !currentSet.has(e));
      const removed = [...currentSet].filter((e) => !requestedSet.has(e));
      const allowed =
        (added.length === 0 && removed.length === 0) ||
        (wantsAdd && added.length === 1 && added[0] === myEmail && removed.length === 0) ||
        (wantsRemove && removed.length === 1 && removed[0] === myEmail && added.length === 0);
      if (!allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'You can only subscribe or unsubscribe yourself' });
      }
      // Replace the requested array with the safely diffed result so we never write attacker input.
      const safe = wantsAdd
        ? Array.from(new Set([...currentSubs, myEmail]))
        : currentSubs.filter((e) => e !== myEmail);
      effectiveDigestSubscribers = safe;
    }
    const updates: string[] = [];
    const values: unknown[] = [];
    if (typeof name === 'string') {
      const trimmed = name.trim();
      if (!trimmed) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'name cannot be empty' }); }
      if (trimmed.length > 255) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'name too long' }); }
      values.push(trimmed); updates.push(`name = $${values.length}`);
    }
    if (filters !== undefined) {
      if (filters && typeof filters !== 'object') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'filters must be an object' }); }
      values.push(JSON.stringify(filters || {})); updates.push(`filters = $${values.length}`);
    }
    if (typeof is_shared === 'boolean') {
      values.push(is_shared); updates.push(`is_shared = $${values.length}`);
    }
    if (typeof is_pinned === 'boolean') {
      values.push(is_pinned); updates.push(`is_pinned = $${values.length}`);
    }
    if (typeof digest_enabled === 'boolean') {
      values.push(digest_enabled); updates.push(`digest_enabled = $${values.length}`);
    }
    let finalSubsForNotify: string[] | null = null;
    if (digest_subscribers !== undefined) {
      let subs: string[] | null;
      if (effectiveDigestSubscribers !== digest_subscribers && Array.isArray(effectiveDigestSubscribers)) {
        // Already validated/diffed in the non-owner branch above (and constrained to
        // the requester's own verified email, which is by definition a tenant member).
        subs = effectiveDigestSubscribers as string[];
      } else {
        subs = sanitizeSubscribers(digest_subscribers);
        if (subs === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'digest_subscribers must be an array of emails' }); }
        if (subs.length > 0) {
          // Owners may only subscribe active members of their own tenant.
          const { allowed, rejected } = await filterToTenantMembers(client, tenantId, subs);
          if (rejected.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: 'digest_subscribers may only contain emails of active users in your workspace',
              rejected,
            });
          }
          subs = allowed;
        }
      }
      if (subs === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'digest_subscribers must be an array of emails' }); }
      finalSubsForNotify = subs;
      values.push(subs); updates.push(`digest_subscribers = $${values.length}`);
    }
    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No fields to update' });
    }
    updates.push(`updated_at = NOW()`);
    values.push(id, tenantId);
    const { rows } = await client.query(
      `UPDATE call_saved_views SET ${updates.join(', ')}
       WHERE id = $${values.length - 1} AND tenant_id = $${values.length}
       RETURNING id, name, filters, is_shared, is_pinned, created_by, created_at, updated_at,
                 digest_enabled, digest_subscribers, digest_last_run_at, digest_last_match_count`,
      values,
    );
    await client.query('COMMIT');
    if (finalSubsForNotify !== null) {
      const { added, removed } = diffSubscribers(currentSubs, finalSubsForNotify);
      if (added.length > 0 || removed.length > 0) {
        const updatedView = rows[0] as { id: string; name: string };
        void notifySubscriberChanges({
          tenantId,
          viewId: updatedView.id,
          viewName: String(updatedView.name ?? ''),
          actorUserId: userId,
          actorEmail: requesterEmail ?? null,
          added,
          removed,
        }).catch((err) => logger.error('Subscriber notification failed (update)', { error: String(err) }));
      }
    }
    return res.json({ view: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update call saved view', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update saved view' });
  } finally {
    client.release();
  }
};

const deleteSavedViewHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows: existing } = await client.query(
      `SELECT created_by FROM call_saved_views WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (existing.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Saved view not found' });
    }
    if (existing[0].created_by !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the owner can delete this view' });
    }
    await client.query(
      `DELETE FROM call_saved_views WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to delete call saved view', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete saved view' });
  } finally {
    client.release();
  }
};

const router = Router();
router.get('/calls', requireAuth, listCallsHandler);
router.get('/call-saved-views', requireAuth, listSavedViewsHandler);
router.get('/call-saved-views/pinned', requireAuth, listPinnedSavedViewsHandler);
router.post('/call-saved-views', requireAuth, createSavedViewHandler);
router.patch('/call-saved-views/:id', requireAuth, updateSavedViewHandler);
router.delete('/call-saved-views/:id', requireAuth, deleteSavedViewHandler);
router.get('/calls/:id', requireAuth, getCallHandler);
router.get('/calls/:id/transcript', requireAuth, getTranscriptHandler);
router.get('/calls/:id/events', requireAuth, getCallEventsHandler);

export default router;
