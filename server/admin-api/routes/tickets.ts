import { Router } from 'express';
import type { RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireMiniSystemWrite } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { sendEmail } from '../../../platform/email';
import {
  TICKET_TEMPLATE_TOKENS,
  findUnknownTicketTemplateTokens,
} from '../../../shared/tickets/templateTokens';

const router = Router();
const logger = createLogger('ADMIN_TICKETS');

async function runAutomatedSlaBreachCheck() {
  const pool = getPlatformPool();
  try {
    const { rows: tenants } = await pool.query(`SELECT DISTINCT tenant_id FROM ticket_sla_instances WHERE paused_at IS NULL`);
    for (const { tenant_id: tenantId } of tenants) {
      const { rows: breached } = await pool.query(
        `SELECT si.id, si.ticket_id, si.response_due_at, si.resolution_due_at,
                si.response_met, si.resolution_met, t.assignee_user_id, t.ticket_number
         FROM ticket_sla_instances si
         JOIN tickets t ON t.id = si.ticket_id AND t.tenant_id = si.tenant_id
         WHERE si.tenant_id = $1 AND si.paused_at IS NULL
           AND t.status NOT IN ('closed', 'resolved')
           AND (
             (si.response_due_at < NOW() AND si.response_met IS NULL)
             OR (si.resolution_due_at < NOW() AND si.resolution_met IS NULL)
           )`,
        [tenantId],
      );
      for (const sla of breached) {
        if (sla.response_due_at && new Date(sla.response_due_at) < new Date() && sla.response_met === null) {
          await pool.query(`UPDATE ticket_sla_instances SET response_met = false WHERE id = $1 AND tenant_id = $2`, [sla.id, tenantId]);
          await pool.query(
            `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
             VALUES ($1, $2, NULL, 'sla_breached', 'SLA first response time breached (auto-detected)')`,
            [tenantId, sla.ticket_id],
          );
        }
        if (sla.resolution_due_at && new Date(sla.resolution_due_at) < new Date() && sla.resolution_met === null) {
          await pool.query(`UPDATE ticket_sla_instances SET resolution_met = false WHERE id = $1 AND tenant_id = $2`, [sla.id, tenantId]);
          await pool.query(
            `UPDATE tickets SET status = 'escalated', updated_at = NOW() WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('closed', 'resolved', 'escalated')`,
            [sla.ticket_id, tenantId],
          );
          await pool.query(
            `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
             VALUES ($1, $2, NULL, 'sla_breached', 'SLA resolution time breached - auto-escalated')`,
            [tenantId, sla.ticket_id],
          );
        }
        if (sla.assignee_user_id) {
          dispatchTicketNotification(pool, tenantId, sla.ticket_id, sla.assignee_user_id, 'sla_breach',
            `SLA breach on ticket #${sla.ticket_number || ''}`,
            `A ticket assigned to you has breached its SLA policy and requires immediate attention.`);
        }
      }
      if (breached.length > 0) {
        logger.info('Automated SLA breach check completed', { tenantId, breachesProcessed: breached.length });
      }
    }
  } catch (err) {
    logger.error('Automated SLA breach check failed', { error: String(err) });
  }
}

const SLA_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let slaCheckInterval: ReturnType<typeof setInterval> | null = null;
if (!slaCheckInterval) {
  slaCheckInterval = setInterval(runAutomatedSlaBreachCheck, SLA_CHECK_INTERVAL_MS);
  logger.info('SLA breach background worker started', { intervalMs: SLA_CHECK_INTERVAL_MS });
}

async function dispatchTicketNotification(
  pool: ReturnType<typeof getPlatformPool>,
  tenantId: string,
  ticketId: string,
  userId: string,
  notificationType: 'assignment' | 'escalation' | 'sla_breach' | 'mention' | 'status_change' | 'comment',
  subject: string,
  body: string,
) {
  try {
    await pool.query(
      `INSERT INTO ticket_notifications (tenant_id, ticket_id, user_id, notification_type, channel, subject, body)
       VALUES ($1, $2, $3, $4, 'in_app', $5, $6)`,
      [tenantId, ticketId, userId, notificationType, subject, body],
    );

    const { rows: userRows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
    if (userRows.length > 0 && userRows[0].email) {
      await sendEmail({
        to: userRows[0].email,
        subject,
        text: body,
        html: `<div style="font-family:sans-serif;padding:16px"><h3>${subject}</h3><p>${body}</p></div>`,
      }).catch(err => logger.warn('Email dispatch failed (non-blocking)', { userId, error: String(err) }));
    }
  } catch (err) {
    logger.error('Failed to dispatch ticket notification', { tenantId, ticketId, userId, notificationType, error: String(err) });
  }
}

async function executeWorkflowRules(pool: ReturnType<typeof getPlatformPool>, tenantId: string, ticketId: string, eventType: string, ticketData: Record<string, unknown>) {
  try {
    const { rows: rules } = await pool.query(
      `SELECT * FROM ticket_workflow_rules WHERE tenant_id = $1 AND is_active = true AND trigger_event = $2 ORDER BY sort_order`,
      [tenantId, eventType],
    );

    for (const rule of rules) {
      const rawConditions = rule.conditions;
      const conditions: Array<{ field: string; operator: string; value: string }> = Array.isArray(rawConditions) ? rawConditions : [];
      const rawActions = rule.actions;
      const actions: Array<{ type: string; field?: string; value?: string; content?: string; user_id?: string }> = Array.isArray(rawActions) ? rawActions : [];

      if (actions.length === 0) continue;

      const matches = conditions.length === 0 || conditions.every((c: { field: string; operator: string; value: string }) => {
        const fieldVal = String(ticketData[c.field] ?? '');
        switch (c.operator) {
          case 'equals': return fieldVal === c.value;
          case 'not_equals': return fieldVal !== c.value;
          case 'contains': return fieldVal.toLowerCase().includes(c.value.toLowerCase());
          case 'in': return c.value.split(',').map((v: string) => v.trim()).includes(fieldVal);
          default: return false;
        }
      });

      if (!matches) continue;

      for (const action of actions) {
        if (action.type === 'set_field' && action.field && action.value !== undefined) {
          const allowed = ['status', 'priority', 'department', 'assignee_user_id', 'category_id'];
          if (allowed.includes(action.field)) {
            await pool.query(
              `UPDATE tickets SET ${action.field} = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
              [action.value, ticketId, tenantId],
            );
          }
        }
        if (action.type === 'add_note' && action.content) {
          await pool.query(
            `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content, metadata)
             VALUES ($1, $2, NULL, 'note', $3, '{"source": "automation"}')`,
            [tenantId, ticketId, action.content],
          );
        }
        if (action.type === 'add_watcher' && action.user_id) {
          await pool.query(
            `INSERT INTO ticket_watchers (tenant_id, ticket_id, user_id) VALUES ($1, $2, $3) ON CONFLICT (ticket_id, user_id) DO NOTHING`,
            [tenantId, ticketId, action.user_id],
          );
        }
        if (action.type === 'escalate') {
          await pool.query(
            `UPDATE tickets SET status = 'escalated', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
            [ticketId, tenantId],
          );
          await pool.query(
            `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content, metadata)
             VALUES ($1, $2, NULL, 'escalated', 'Auto-escalated by workflow rule', $3)`,
            [tenantId, ticketId, JSON.stringify({ rule_id: rule.id, rule_name: rule.name })],
          );
        }
      }

      await pool.query(
        `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content, metadata)
         VALUES ($1, $2, NULL, 'field_change', $3, $4)`,
        [tenantId, ticketId, `Workflow rule triggered: ${rule.name}`, JSON.stringify({ rule_id: rule.id })],
      );
    }
  } catch (err) {
    logger.error('Failed to execute workflow rules', { tenantId, ticketId, eventType, error: String(err) });
  }
}

async function parseMentionsAndNotify(pool: ReturnType<typeof getPlatformPool>, tenantId: string, ticketId: string, content: string, authorUserId: string) {
  try {
    const mentionRegex = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1]);
    }
    if (mentions.length === 0) return;

    for (const email of mentions) {
      const { rows: users } = await pool.query(
        `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = $1 WHERE u.email = $2 LIMIT 1`,
        [tenantId, email],
      );
      if (users.length === 0) continue;

      await pool.query(
        `INSERT INTO ticket_watchers (tenant_id, ticket_id, user_id) VALUES ($1, $2, $3) ON CONFLICT (ticket_id, user_id) DO NOTHING`,
        [tenantId, ticketId, users[0].id],
      );

      await pool.query(
        `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content, metadata)
         VALUES ($1, $2, $3, 'field_change', $4, '{"type": "mention_notification"}')`,
        [tenantId, ticketId, authorUserId, `Mentioned @${email}`],
      );

      dispatchTicketNotification(pool, tenantId, ticketId, users[0].id, 'mention',
        `You were mentioned in a ticket`,
        `You were @mentioned in a ticket comment.`);
    }
  } catch (err) {
    logger.error('Failed to parse mentions', { tenantId, ticketId, error: String(err) });
  }
}

function paginate(req: { query: Record<string, unknown> }): { limit: number; offset: number } {
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
  const page = Math.max(parseInt(String(req.query.page ?? '1'), 10), 1);
  return { limit, offset: (page - 1) * limit };
}

export const listTicketsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { limit, offset } = paginate(req);
  const { status, assignee, priority, category_id, department, search, queue, sla_risk, sort_by, sort_order } = req.query as Record<string, string>;
  const pool = getPlatformPool();

  try {
    const conditions: string[] = ['t.tenant_id = $1'];
    const values: unknown[] = [tenantId];

    if (status) { values.push(status); conditions.push(`t.status = $${values.length}`); }
    if (assignee) { values.push(assignee); conditions.push(`t.assignee_user_id = $${values.length}`); }
    if (priority) { values.push(priority); conditions.push(`t.priority = $${values.length}`); }
    if (category_id) { values.push(category_id); conditions.push(`t.category_id = $${values.length}`); }
    if (department) { values.push(department); conditions.push(`t.department = $${values.length}`); }
    if (search) { values.push(`%${search}%`); conditions.push(`(t.subject ILIKE $${values.length} OR t.description ILIKE $${values.length})`); }

    if (queue === 'unassigned') conditions.push('t.assignee_user_id IS NULL');
    if (queue === 'my_tickets') { values.push(req.user!.userId); conditions.push(`t.assignee_user_id = $${values.length}`); }
    if (queue === 'overdue') conditions.push(`EXISTS (SELECT 1 FROM ticket_sla_instances si WHERE si.ticket_id = t.id AND si.resolution_due_at < NOW() AND si.resolution_met IS NULL AND si.paused_at IS NULL)`);
    if (queue === 'escalated') conditions.push(`t.status = 'escalated'`);
    if (queue === 'pending') conditions.push(`t.status = 'pending'`);
    if (queue === 'high_priority') conditions.push(`t.priority IN ('high', 'urgent')`);
    if (queue === 'aging') conditions.push(`t.created_at < NOW() - INTERVAL '7 days' AND t.status NOT IN ('closed', 'resolved')`);

    if (sla_risk === 'at_risk') {
      conditions.push(`EXISTS (SELECT 1 FROM ticket_sla_instances si WHERE si.ticket_id = t.id AND si.resolution_due_at < NOW() + INTERVAL '2 hours' AND si.resolution_due_at > NOW() AND si.resolution_met IS NULL)`);
    }

    const where = conditions.join(' AND ');
    const orderCol = ['created_at', 'updated_at', 'priority', 'status', 'subject'].includes(sort_by) ? sort_by : 'created_at';
    const orderDir = sort_order === 'asc' ? 'ASC' : 'DESC';

    const { rows } = await pool.query(
      `SELECT t.*, u.email AS assignee_email, c.name AS category_name,
              sla.sla_instance,
              COUNT(*) OVER() AS _total_count
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_user_id
       LEFT JOIN ticket_categories c ON c.id = t.category_id
       LEFT JOIN LATERAL (
         SELECT row_to_json(si.*) AS sla_instance
         FROM ticket_sla_instances si
         WHERE si.ticket_id = t.id
         ORDER BY si.created_at DESC
         LIMIT 1
       ) sla ON true
       WHERE ${where}
       ORDER BY t.${orderCol} ${orderDir}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    );

    let total = 0;
    if (rows.length > 0) {
      total = parseInt(rows[0]._total_count as string, 10) || 0;
      for (const r of rows) delete (r as Record<string, unknown>)._total_count;
    } else if (offset > 0) {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM tickets t WHERE ${where}`,
        values,
      );
      total = (countRows[0]?.total as number) ?? 0;
    }

    return res.json({ tickets: rows, total, limit, offset });
  } catch (err) {
    logger.error('Failed to list tickets', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list tickets' });
  }
};

const getTicketHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT t.*, u.email AS assignee_email, c.name AS category_name,
        cu.email AS created_by_email
       FROM tickets t
       LEFT JOIN users u ON u.id = t.assignee_user_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = t.tenant_id
       LEFT JOIN ticket_categories c ON c.id = t.category_id
       LEFT JOIN users cu ON cu.id = t.created_by_user_id
       WHERE t.id = $1 AND t.tenant_id = $2`,
      [id, tenantId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const { rows: watchers } = await pool.query(
      `SELECT tw.*, u.email FROM ticket_watchers tw JOIN users u ON u.id = tw.user_id WHERE tw.ticket_id = $1 AND tw.tenant_id = $2`,
      [id, tenantId],
    );

    const { rows: slaInstances } = await pool.query(
      `SELECT si.*, sp.name AS policy_name FROM ticket_sla_instances si LEFT JOIN ticket_sla_policies sp ON sp.id = si.policy_id WHERE si.ticket_id = $1 AND si.tenant_id = $2 ORDER BY si.created_at DESC LIMIT 1`,
      [id, tenantId],
    );

    const { rows: linkedTickets } = await pool.query(
      `SELECT tl.*, ts.subject AS source_subject, tt.subject AS target_subject
       FROM ticket_links tl
       LEFT JOIN tickets ts ON ts.id = tl.source_ticket_id AND ts.tenant_id = $2
       LEFT JOIN tickets tt ON tt.id = tl.target_ticket_id AND tt.tenant_id = $2
       WHERE (tl.source_ticket_id = $1 OR tl.target_ticket_id = $1) AND tl.tenant_id = $2`,
      [id, tenantId],
    );

    const { rows: attachments } = await pool.query(
      `SELECT * FROM ticket_attachments WHERE ticket_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [id, tenantId],
    );

    return res.json({
      ticket: rows[0],
      watchers,
      sla: slaInstances[0] || null,
      linkedTickets,
      attachments,
    });
  } catch (err) {
    logger.error('Failed to get ticket', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get ticket' });
  }
};

const createTicketHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { subject, description, status, priority, assignee_user_id, call_id, notes, category_id, department, tags, source, contact_name, contact_email, contact_phone } = req.body;

  if (!subject) {
    return res.status(400).json({ error: 'subject is required' });
  }

  const pool = getPlatformPool();

  try {
    if (assignee_user_id) {
      const { rows: memberCheck } = await pool.query(
        `SELECT user_id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
        [assignee_user_id, tenantId],
      );
      if (memberCheck.length === 0) {
        return res.status(400).json({ error: 'Assignee is not a member of this tenant' });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO tickets (tenant_id, call_id, subject, description, status, priority, assignee_user_id, notes, category_id, department, tags, source, contact_name, contact_email, contact_phone, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [tenantId, call_id || null, subject, description || '', status || 'open', priority || 'medium', assignee_user_id || null, notes || '', category_id || null, department || '', tags || [], source || 'manual', contact_name || '', contact_email || '', contact_phone || '', userId],
    );

    const ticket = rows[0];

    await pool.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content) VALUES ($1, $2, $3, 'created', $4)`,
      [tenantId, ticket.id, userId, `Ticket created: ${subject}`],
    );

    if (assignee_user_id) {
      await pool.query(
        `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content, new_value) VALUES ($1, $2, $3, 'assigned', 'Ticket assigned', $4)`,
        [tenantId, ticket.id, userId, assignee_user_id],
      );
    }

    const { rows: policies } = await pool.query(
      `SELECT * FROM ticket_sla_policies WHERE tenant_id = $1 AND is_active = true AND priority = $2 ORDER BY created_at ASC LIMIT 1`,
      [tenantId, priority || 'medium'],
    );

    if (policies.length > 0) {
      const policy = policies[0];
      await pool.query(
        `INSERT INTO ticket_sla_instances (tenant_id, ticket_id, policy_id, response_due_at, resolution_due_at)
         VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval, NOW() + ($5 || ' minutes')::interval)`,
        [tenantId, ticket.id, policy.id, String(policy.first_response_minutes), String(policy.resolution_minutes)],
      );
    }

    await executeWorkflowRules(pool, tenantId, ticket.id, 'ticket_created', ticket);

    if (description) {
      await parseMentionsAndNotify(pool, tenantId, ticket.id, description, userId);
    }

    return res.status(201).json({ ticket });
  } catch (err) {
    logger.error('Failed to create ticket', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create ticket' });
  }
};

const updateTicketHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { subject, description, status, priority, assignee_user_id, notes, category_id, department, tags, contact_name, contact_email, contact_phone } = req.body;
  const pool = getPlatformPool();

  try {
    if (assignee_user_id) {
      const { rows: memberCheck } = await pool.query(
        `SELECT user_id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
        [assignee_user_id, tenantId],
      );
      if (memberCheck.length === 0) {
        return res.status(400).json({ error: 'Assignee is not a member of this tenant' });
      }
    }

    const { rows: existing } = await pool.query(
      `SELECT * FROM tickets WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const old = existing[0];

    const auditFieldChange = async (fieldName: string, activityType: string, oldVal: string, newVal: string) => {
      await pool.query(
        `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, field_name, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, id, userId, activityType, fieldName, oldVal, newVal],
      );
    };

    if (status && status !== old.status) {
      await auditFieldChange('status', 'status_change', old.status, status);
      if (status === 'reopened') {
        await pool.query(`UPDATE tickets SET reopened_count = COALESCE(reopened_count, 0) + 1 WHERE id = $1`, [id]);
      }
    }

    if (priority && priority !== old.priority) {
      await auditFieldChange('priority', 'priority_change', old.priority, priority);
    }

    if (assignee_user_id !== undefined && assignee_user_id !== old.assignee_user_id) {
      const actType = assignee_user_id ? 'assigned' : 'unassigned';
      await pool.query(
        `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, id, userId, actType, old.assignee_user_id || '', assignee_user_id || ''],
      );

      if (!old.first_response_at && assignee_user_id) {
        await pool.query(`UPDATE tickets SET first_response_at = NOW() WHERE id = $1 AND first_response_at IS NULL`, [id]);
        await pool.query(
          `UPDATE ticket_sla_instances SET response_met = (response_due_at >= NOW()) WHERE ticket_id = $1 AND response_met IS NULL`,
          [id],
        );
      }
    }

    if (category_id !== undefined && category_id !== old.category_id) {
      await auditFieldChange('category_id', 'field_change', old.category_id || '', category_id || '');
    }

    if (subject !== undefined && subject !== old.subject) {
      await auditFieldChange('subject', 'field_change', old.subject || '', subject || '');
    }
    if (description !== undefined && description !== old.description) {
      await auditFieldChange('description', 'field_change', (old.description || '').substring(0, 200), (description || '').substring(0, 200));
    }
    if (department !== undefined && department !== old.department) {
      await auditFieldChange('department', 'field_change', old.department || '', department || '');
    }
    if (tags !== undefined && JSON.stringify(tags) !== JSON.stringify(old.tags)) {
      await auditFieldChange('tags', 'field_change', (old.tags || []).join(', '), (tags || []).join(', '));
    }
    if (contact_name !== undefined && contact_name !== old.contact_name) {
      await auditFieldChange('contact_name', 'field_change', old.contact_name || '', contact_name || '');
    }
    if (contact_email !== undefined && contact_email !== old.contact_email) {
      await auditFieldChange('contact_email', 'field_change', old.contact_email || '', contact_email || '');
    }
    if (contact_phone !== undefined && contact_phone !== old.contact_phone) {
      await auditFieldChange('contact_phone', 'field_change', old.contact_phone || '', contact_phone || '');
    }
    if (notes !== undefined && notes !== old.notes) {
      await auditFieldChange('notes', 'field_change', (old.notes || '').substring(0, 200), (notes || '').substring(0, 200));
    }

    let resolvedAt = undefined;
    let closedAt = undefined;
    if (status === 'resolved' && old.status !== 'resolved') {
      resolvedAt = new Date();
      await pool.query(
        `UPDATE ticket_sla_instances SET resolution_met = (resolution_due_at >= NOW()) WHERE ticket_id = $1 AND resolution_met IS NULL`,
        [id],
      );
    }
    if (status === 'closed' && old.status !== 'closed') {
      closedAt = new Date();
    }

    if (status === 'pending') {
      await pool.query(
        `UPDATE ticket_sla_instances SET paused_at = NOW() WHERE ticket_id = $1 AND paused_at IS NULL`,
        [id],
      );
    }
    if (old.status === 'pending' && status && status !== 'pending') {
      await pool.query(
        `UPDATE ticket_sla_instances SET
          total_paused_minutes = total_paused_minutes + EXTRACT(EPOCH FROM (NOW() - COALESCE(paused_at, NOW())))::int / 60,
          paused_at = NULL,
          response_due_at = response_due_at + (NOW() - COALESCE(paused_at, NOW())),
          resolution_due_at = resolution_due_at + (NOW() - COALESCE(paused_at, NOW()))
         WHERE ticket_id = $1 AND paused_at IS NOT NULL`,
        [id],
      );
    }

    const setClauses: string[] = ['updated_at = NOW()'];
    const updateValues: unknown[] = [id, tenantId];
    let paramIdx = 3;

    const addField = (field: string, value: unknown, provided: boolean) => {
      if (provided) { setClauses.push(`${field} = $${paramIdx}`); updateValues.push(value); paramIdx++; }
    };

    addField('subject', subject, subject !== undefined);
    addField('description', description, description !== undefined);
    addField('status', status, status !== undefined);
    addField('priority', priority, priority !== undefined);
    addField('assignee_user_id', assignee_user_id ?? null, assignee_user_id !== undefined);
    addField('notes', notes, notes !== undefined);
    addField('category_id', category_id ?? null, category_id !== undefined);
    addField('department', department, department !== undefined);
    addField('tags', tags, tags !== undefined);
    addField('contact_name', contact_name, contact_name !== undefined);
    addField('contact_email', contact_email, contact_email !== undefined);
    addField('contact_phone', contact_phone, contact_phone !== undefined);
    addField('resolved_at', resolvedAt, resolvedAt !== undefined);
    addField('closed_at', closedAt, closedAt !== undefined);

    const { rows } = await pool.query(
      `UPDATE tickets SET ${setClauses.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      updateValues,
    );

    const updated = rows[0];

    if (status) {
      await executeWorkflowRules(pool, tenantId, id, 'status_change', { ...updated, old_status: status });
    }
    if (assignee_user_id !== undefined) {
      await executeWorkflowRules(pool, tenantId, id, 'assigned', updated);
    }
    if (priority) {
      await executeWorkflowRules(pool, tenantId, id, 'priority_change', updated);
    }

    if (assignee_user_id && assignee_user_id !== old.assignee_user_id) {
      dispatchTicketNotification(pool, tenantId, id, assignee_user_id, 'assignment',
        `Ticket #${updated.ticket_number} assigned to you`,
        `You have been assigned ticket "${updated.subject}" (priority: ${updated.priority}).`);
    }
    if (status === 'escalated' && old.status !== 'escalated') {
      const { rows: watchers } = await pool.query(
        `SELECT user_id FROM ticket_watchers WHERE ticket_id = $1 AND tenant_id = $2`, [id, tenantId]);
      for (const w of watchers) {
        dispatchTicketNotification(pool, tenantId, id, w.user_id, 'escalation',
          `Ticket #${updated.ticket_number} escalated`,
          `Ticket "${updated.subject}" has been escalated and requires attention.`);
      }
      if (updated.assignee_user_id) {
        dispatchTicketNotification(pool, tenantId, id, updated.assignee_user_id, 'escalation',
          `Ticket #${updated.ticket_number} escalated`,
          `Ticket "${updated.subject}" assigned to you has been escalated.`);
      }
    }

    return res.json({ ticket: updated });
  } catch (err) {
    logger.error('Failed to update ticket', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update ticket' });
  }
};

const deleteTicketHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM tickets WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete ticket', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete ticket' });
  }
};

const getTicketActivityHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT a.*, u.email AS user_email
       FROM ticket_activity_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.ticket_id = $1 AND a.tenant_id = $2
       ORDER BY a.created_at ASC`,
      [id, tenantId],
    );

    return res.json({ activities: rows });
  } catch (err) {
    logger.error('Failed to get ticket activity', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get ticket activity' });
  }
};

const addTicketNoteHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { content, is_internal } = req.body;

  if (!content) return res.status(400).json({ error: 'content is required' });

  const pool = getPlatformPool();

  try {
    const { rows: ticketCheck } = await pool.query(
      `SELECT id FROM tickets WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (ticketCheck.length === 0) return res.status(404).json({ error: 'Ticket not found' });

    const activityType = is_internal ? 'internal_note' : 'note';
    const { rows } = await pool.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content, is_internal)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tenantId, id, userId, activityType, content, is_internal || false],
    );

    if (!is_internal) {
      await pool.query(
        `UPDATE tickets SET first_response_at = NOW() WHERE id = $1 AND first_response_at IS NULL`,
        [id],
      );
      await pool.query(
        `UPDATE ticket_sla_instances SET response_met = (response_due_at >= NOW()) WHERE ticket_id = $1 AND response_met IS NULL`,
        [id],
      );
    }

    await pool.query(`UPDATE tickets SET updated_at = NOW() WHERE id = $1`, [id]);

    await parseMentionsAndNotify(pool, tenantId, id, content, userId);

    return res.status(201).json({ activity: rows[0] });
  } catch (err) {
    logger.error('Failed to add ticket note', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to add ticket note' });
  }
};

const addWatcherHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { user_id } = req.body;
  const pool = getPlatformPool();

  try {
    const { rows: ticketCheck } = await pool.query(
      `SELECT id FROM tickets WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (ticketCheck.length === 0) return res.status(404).json({ error: 'Ticket not found' });

    const { rows: userCheck } = await pool.query(
      `SELECT user_id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`, [user_id, tenantId],
    );
    if (userCheck.length === 0) return res.status(400).json({ error: 'User is not a member of this tenant' });

    await pool.query(
      `INSERT INTO ticket_watchers (tenant_id, ticket_id, user_id) VALUES ($1, $2, $3) ON CONFLICT (ticket_id, user_id) DO NOTHING`,
      [tenantId, id, user_id],
    );

    await pool.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, new_value) VALUES ($1, $2, $3, 'watcher_added', $4)`,
      [tenantId, id, req.user!.userId, user_id],
    );

    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to add watcher', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to add watcher' });
  }
};

const removeWatcherHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id, userId } = req.params;
  const pool = getPlatformPool();

  try {
    await pool.query(
      `DELETE FROM ticket_watchers WHERE ticket_id = $1 AND user_id = $2 AND tenant_id = $3`,
      [id, userId, tenantId],
    );

    await pool.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, old_value) VALUES ($1, $2, $3, 'watcher_removed', $4)`,
      [tenantId, id, req.user!.userId, userId],
    );

    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to remove watcher', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to remove watcher' });
  }
};

const getTicketStatsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();

  try {
    const { rows: statusCounts } = await pool.query(
      `SELECT status, COUNT(*) AS count FROM tickets WHERE tenant_id = $1 GROUP BY status`,
      [tenantId],
    );

    const { rows: priorityCounts } = await pool.query(
      `SELECT priority, COUNT(*) AS count FROM tickets WHERE tenant_id = $1 AND status NOT IN ('closed', 'resolved') GROUP BY priority`,
      [tenantId],
    );

    const { rows: unassigned } = await pool.query(
      `SELECT COUNT(*) AS count FROM tickets WHERE tenant_id = $1 AND assignee_user_id IS NULL AND status NOT IN ('closed', 'resolved')`,
      [tenantId],
    );

    const { rows: slaAtRisk } = await pool.query(
      `SELECT COUNT(*) AS count FROM ticket_sla_instances si
       JOIN tickets t ON t.id = si.ticket_id
       WHERE si.tenant_id = $1 AND si.resolution_due_at < NOW() + INTERVAL '2 hours' AND si.resolution_met IS NULL AND t.status NOT IN ('closed', 'resolved')`,
      [tenantId],
    );

    const { rows: slaBreached } = await pool.query(
      `SELECT COUNT(*) AS count FROM ticket_sla_instances si
       JOIN tickets t ON t.id = si.ticket_id
       WHERE si.tenant_id = $1 AND si.resolution_due_at < NOW() AND si.resolution_met IS NULL AND t.status NOT IN ('closed', 'resolved')`,
      [tenantId],
    );

    const { rows: avgResolution } = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600)::numeric(10,1) AS avg_hours
       FROM tickets WHERE tenant_id = $1 AND resolved_at IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'`,
      [tenantId],
    );

    const { rows: avgFirstResponse } = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 3600)::numeric(10,1) AS avg_hours
       FROM tickets WHERE tenant_id = $1 AND first_response_at IS NOT NULL AND created_at > NOW() - INTERVAL '30 days'`,
      [tenantId],
    );

    const { rows: overdueCount } = await pool.query(
      `SELECT COUNT(*) AS count FROM ticket_sla_instances si
       JOIN tickets t ON t.id = si.ticket_id AND t.tenant_id = si.tenant_id
       WHERE si.tenant_id = $1 AND si.resolution_due_at < NOW() AND si.resolution_met IS NULL AND si.paused_at IS NULL AND t.status NOT IN ('closed', 'resolved')`,
      [tenantId],
    );

    const { rows: highPriorityCount } = await pool.query(
      `SELECT COUNT(*) AS count FROM tickets WHERE tenant_id = $1 AND priority IN ('high', 'urgent') AND status NOT IN ('closed', 'resolved')`,
      [tenantId],
    );

    const { rows: agingCount } = await pool.query(
      `SELECT COUNT(*) AS count FROM tickets WHERE tenant_id = $1 AND created_at < NOW() - INTERVAL '7 days' AND status NOT IN ('closed', 'resolved')`,
      [tenantId],
    );

    const { rows: myTicketsCount } = await pool.query(
      `SELECT COUNT(*) AS count FROM tickets WHERE tenant_id = $1 AND assignee_user_id = $2 AND status NOT IN ('closed', 'resolved')`,
      [tenantId, req.user!.userId],
    );

    return res.json({
      statusCounts: statusCounts.reduce((acc: Record<string, number>, r: { status: string; count: string }) => { acc[r.status] = parseInt(r.count); return acc; }, {}),
      priorityCounts: priorityCounts.reduce((acc: Record<string, number>, r: { priority: string; count: string }) => { acc[r.priority] = parseInt(r.count); return acc; }, {}),
      unassignedCount: parseInt(unassigned[0].count as string),
      slaAtRisk: parseInt(slaAtRisk[0].count as string),
      slaBreached: parseInt(slaBreached[0].count as string),
      avgResolutionHours: parseFloat(avgResolution[0]?.avg_hours) || 0,
      avgFirstResponseHours: parseFloat(avgFirstResponse[0]?.avg_hours) || 0,
      queueCounts: {
        my_tickets: parseInt(myTicketsCount[0].count as string),
        unassigned: parseInt(unassigned[0].count as string),
        overdue: parseInt(overdueCount[0].count as string),
        high_priority: parseInt(highPriorityCount[0].count as string),
        aging: parseInt(agingCount[0].count as string),
      },
    });
  } catch (err) {
    logger.error('Failed to get ticket stats', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get ticket stats' });
  }
};

const getReportingHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { days, assignee, department, priority: filterPriority, date_from, date_to } = req.query as Record<string, string>;
  const daysBack = parseInt(days || '30', 10);
  const pool = getPlatformPool();

  const filterClauses: string[] = [];
  const filterValues: unknown[] = [tenantId];
  let paramIdx = 2;

  if (date_from && date_to) {
    filterClauses.push(`t.created_at >= $${paramIdx} AND t.created_at <= $${paramIdx + 1}`);
    filterValues.push(date_from, date_to);
    paramIdx += 2;
  } else {
    filterClauses.push(`t.created_at > NOW() - ($${paramIdx} || ' days')::interval`);
    filterValues.push(String(daysBack));
    paramIdx += 1;
  }
  if (assignee) {
    filterClauses.push(`t.assignee_user_id = $${paramIdx}`);
    filterValues.push(assignee);
    paramIdx += 1;
  }
  if (department) {
    filterClauses.push(`t.department = $${paramIdx}`);
    filterValues.push(department);
    paramIdx += 1;
  }
  if (filterPriority) {
    filterClauses.push(`t.priority = $${paramIdx}`);
    filterValues.push(filterPriority);
    paramIdx += 1;
  }

  const whereBase = `t.tenant_id = $1 AND ${filterClauses.join(' AND ')}`;

  try {
    const { rows: dailyCreated } = await pool.query(
      `SELECT DATE(t.created_at) AS date, COUNT(*) AS count
       FROM tickets t WHERE ${whereBase}
       GROUP BY DATE(t.created_at) ORDER BY date`,
      filterValues,
    );

    const { rows: dailyResolved } = await pool.query(
      `SELECT DATE(t.resolved_at) AS date, COUNT(*) AS count
       FROM tickets t WHERE ${whereBase} AND t.resolved_at IS NOT NULL
       GROUP BY DATE(t.resolved_at) ORDER BY date`,
      filterValues,
    );

    const { rows: byPriority } = await pool.query(
      `SELECT t.priority, COUNT(*) AS count FROM tickets t WHERE ${whereBase} GROUP BY t.priority`,
      filterValues,
    );

    const { rows: byCategory } = await pool.query(
      `SELECT COALESCE(c.name, 'Uncategorized') AS category, COUNT(*) AS count
       FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id
       WHERE ${whereBase}
       GROUP BY c.name ORDER BY count DESC LIMIT 10`,
      filterValues,
    );

    const { rows: agentWorkload } = await pool.query(
      `SELECT u.email, COUNT(*) AS open_count,
        COUNT(*) FILTER (WHERE t.status = 'resolved') AS resolved_count
       FROM tickets t JOIN users u ON u.id = t.assignee_user_id
       WHERE ${whereBase}
       GROUP BY u.email ORDER BY open_count DESC`,
      filterValues,
    );

    const { rows: slaAttainment } = await pool.query(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE si.response_met = true) AS response_met_count,
        COUNT(*) FILTER (WHERE si.resolution_met = true) AS resolution_met_count
       FROM ticket_sla_instances si
       JOIN tickets t ON t.id = si.ticket_id AND t.tenant_id = si.tenant_id
       WHERE ${whereBase}`,
      filterValues,
    );

    const { rows: reopenRate } = await pool.query(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE t.reopened_count > 0) AS reopened
       FROM tickets t WHERE ${whereBase}`,
      filterValues,
    );

    const { rows: backlogAging } = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE t.created_at > NOW() - INTERVAL '1 day') AS today,
        COUNT(*) FILTER (WHERE t.created_at BETWEEN NOW() - INTERVAL '7 days' AND NOW() - INTERVAL '1 day') AS this_week,
        COUNT(*) FILTER (WHERE t.created_at BETWEEN NOW() - INTERVAL '30 days' AND NOW() - INTERVAL '7 days') AS this_month,
        COUNT(*) FILTER (WHERE t.created_at < NOW() - INTERVAL '30 days') AS older
       FROM tickets t WHERE t.tenant_id = $1 AND t.status NOT IN ('closed', 'resolved')`,
      [tenantId],
    );

    const { rows: responseTimeStats } = await pool.query(
      `SELECT
        AVG(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at))) AS avg_response_seconds,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t.first_response_at - t.created_at))) AS median_response_seconds,
        MIN(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at))) AS min_response_seconds,
        MAX(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at))) AS max_response_seconds,
        COUNT(*) AS sample_count
       FROM tickets t
       WHERE ${whereBase} AND t.first_response_at IS NOT NULL`,
      filterValues,
    );

    const { rows: resolutionTimeStats } = await pool.query(
      `SELECT
        AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))) AS avg_resolution_seconds,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))) AS median_resolution_seconds,
        MIN(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))) AS min_resolution_seconds,
        MAX(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))) AS max_resolution_seconds,
        COUNT(*) AS sample_count
       FROM tickets t
       WHERE ${whereBase} AND t.resolved_at IS NOT NULL`,
      filterValues,
    );

    const { rows: responseTimeByPriority } = await pool.query(
      `SELECT t.priority,
        AVG(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at))) AS avg_response_seconds,
        COUNT(*) AS sample_count
       FROM tickets t
       WHERE ${whereBase} AND t.first_response_at IS NOT NULL
       GROUP BY t.priority ORDER BY t.priority`,
      filterValues,
    );

    const { rows: resolutionTimeByPriority } = await pool.query(
      `SELECT t.priority,
        AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))) AS avg_resolution_seconds,
        COUNT(*) AS sample_count
       FROM tickets t
       WHERE ${whereBase} AND t.resolved_at IS NOT NULL
       GROUP BY t.priority ORDER BY t.priority`,
      filterValues,
    );

    const { rows: responseTimeByAgent } = await pool.query(
      `SELECT u.email,
        AVG(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at))) AS avg_response_seconds,
        COUNT(*) AS sample_count
       FROM tickets t JOIN users u ON u.id = t.assignee_user_id
       WHERE ${whereBase} AND t.first_response_at IS NOT NULL
       GROUP BY u.email ORDER BY avg_response_seconds`,
      filterValues,
    );

    return res.json({
      dailyCreated,
      dailyResolved,
      byPriority,
      byCategory,
      agentWorkload,
      slaAttainment: slaAttainment[0],
      reopenRate: reopenRate[0],
      backlogAging: backlogAging[0],
      responseTime: responseTimeStats[0],
      resolutionTime: resolutionTimeStats[0],
      responseTimeByPriority,
      resolutionTimeByPriority,
      responseTimeByAgent,
    });
  } catch (err) {
    logger.error('Failed to get reporting', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to get reporting data' });
  }
};

const bulkUpdateHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { ticket_ids, status, priority, assignee_user_id } = req.body;

  if (!Array.isArray(ticket_ids) || ticket_ids.length === 0) {
    return res.status(400).json({ error: 'ticket_ids array is required' });
  }

  const pool = getPlatformPool();

  try {
    const updates: string[] = [];
    const values: unknown[] = [tenantId];

    if (assignee_user_id) {
      const { rows: userCheck } = await pool.query(
        `SELECT user_id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
        [assignee_user_id, tenantId],
      );
      if (userCheck.length === 0) return res.status(400).json({ error: 'Assignee is not a member of this tenant' });
    }

    if (status) { values.push(status); updates.push(`status = $${values.length}`); }
    if (priority) { values.push(priority); updates.push(`priority = $${values.length}`); }
    if (assignee_user_id !== undefined) {
      if (assignee_user_id === null || assignee_user_id === '') {
        updates.push(`assignee_user_id = NULL`);
      } else {
        values.push(assignee_user_id); updates.push(`assignee_user_id = $${values.length}`);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push('updated_at = NOW()');

    if (status === 'resolved') updates.push(`resolved_at = NOW()`);
    if (status === 'closed') updates.push(`closed_at = NOW()`);

    const placeholders = ticket_ids.map((_: string, i: number) => `$${values.length + i + 1}`).join(', ');

    await pool.query(
      `UPDATE tickets SET ${updates.join(', ')} WHERE tenant_id = $1 AND id IN (${placeholders})`,
      [...values, ...ticket_ids],
    );

    for (const ticketId of ticket_ids) {
      if (status) {
        await pool.query(
          `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, field_name, new_value, content)
           VALUES ($1, $2, $3, 'status_change', 'status', $4, 'Bulk status update')`,
          [tenantId, ticketId, userId, status],
        );

        if (status === 'pending') {
          await pool.query(
            `UPDATE ticket_sla_instances SET paused_at = NOW() WHERE ticket_id = $1 AND tenant_id = $2 AND paused_at IS NULL`,
            [ticketId, tenantId],
          );
        } else if (status === 'resolved') {
          await pool.query(
            `UPDATE ticket_sla_instances SET
              resolution_met = CASE WHEN resolution_due_at IS NOT NULL AND NOW() <= resolution_due_at THEN true ELSE false END
             WHERE ticket_id = $1 AND tenant_id = $2`,
            [ticketId, tenantId],
          );
        }

        if (['open', 'in_progress'].includes(status)) {
          await pool.query(
            `UPDATE ticket_sla_instances SET
              paused_at = NULL,
              response_due_at = CASE WHEN paused_at IS NOT NULL THEN response_due_at + (NOW() - paused_at) ELSE response_due_at END,
              resolution_due_at = CASE WHEN paused_at IS NOT NULL THEN resolution_due_at + (NOW() - paused_at) ELSE resolution_due_at END
             WHERE ticket_id = $1 AND tenant_id = $2 AND paused_at IS NOT NULL`,
            [ticketId, tenantId],
          );
        }
      }
      if (assignee_user_id !== undefined) {
        if (assignee_user_id === null || assignee_user_id === '') {
          await pool.query(
            `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
             VALUES ($1, $2, $3, 'unassigned', 'Bulk unassignment')`,
            [tenantId, ticketId, userId],
          );
        } else {
          await pool.query(
            `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, new_value, content)
             VALUES ($1, $2, $3, 'assigned', $4, 'Bulk assignment')`,
            [tenantId, ticketId, userId, assignee_user_id],
          );
          dispatchTicketNotification(pool, tenantId, ticketId, assignee_user_id, 'assignment',
            `Ticket assigned to you (bulk)`,
            `You have been assigned a ticket via bulk assignment.`);
        }
      }
      if (priority) {
        await pool.query(
          `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, field_name, new_value, content)
           VALUES ($1, $2, $3, 'priority_change', 'priority', $4, 'Bulk priority update')`,
          [tenantId, ticketId, userId, priority],
        );
      }
    }

    return res.json({ success: true, updated: ticket_ids.length });
  } catch (err) {
    logger.error('Failed to bulk update tickets', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to bulk update tickets' });
  }
};

const applyMacroHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { macro_id } = req.body;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: macros } = await client.query(
      `SELECT * FROM ticket_macros WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
      [macro_id, tenantId],
    );

    if (macros.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Macro not found' }); }

    const macro = macros[0];
    const actions = macro.actions as Array<{ type: string; field?: string; value?: string; content?: string }>;

    for (const action of actions) {
      if (action.type === 'set_field' && action.field && action.value) {
        const allowed = ['status', 'priority', 'department', 'assignee_user_id'];
        if (allowed.includes(action.field)) {
          if (action.field === 'assignee_user_id') {
            const { rows: userCheck } = await client.query(
              `SELECT user_id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
              [action.value, tenantId],
            );
            if (userCheck.length === 0) continue;
          }
          await client.query(
            `UPDATE tickets SET ${action.field} = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
            [action.value, id, tenantId],
          );
        }
      }
      if (action.type === 'add_note' && action.content) {
        await client.query(
          `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
           VALUES ($1, $2, $3, 'note', $4)`,
          [tenantId, id, userId, action.content],
        );
      }
    }

    await client.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content, metadata)
       VALUES ($1, $2, $3, 'macro_applied', $4, $5)`,
      [tenantId, id, userId, `Macro applied: ${macro.name}`, JSON.stringify({ macro_id: macro.id })],
    );

    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to apply macro', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to apply macro' });
  } finally {
    client.release();
  }
};

const listCategoriesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ticket_categories WHERE tenant_id = $1 ORDER BY sort_order, name`,
      [tenantId],
    );
    return res.json({ categories: rows });
  } catch (err) {
    logger.error('Failed to list categories', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list categories' });
  }
};

const createCategoryHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, description, parent_id, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO ticket_categories (tenant_id, name, description, parent_id, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tenantId, name, description || '', parent_id || null, sort_order || 0],
    );
    return res.status(201).json({ category: rows[0] });
  } catch (err) {
    logger.error('Failed to create category', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create category' });
  }
};

const updateCategoryHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, description, parent_id, sort_order, is_active } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE ticket_categories SET name = COALESCE($3, name), description = COALESCE($4, description),
       parent_id = COALESCE($5, parent_id), sort_order = COALESCE($6, sort_order), is_active = COALESCE($7, is_active),
       updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, description, parent_id, sort_order, is_active],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Category not found' });
    return res.json({ category: rows[0] });
  } catch (err) {
    logger.error('Failed to update category', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update category' });
  }
};

const deleteCategoryHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ticket_categories WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Category not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete category', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete category' });
  }
};

const listSlaPoliciesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT sp.*, c.name AS category_name FROM ticket_sla_policies sp
       LEFT JOIN ticket_categories c ON c.id = sp.category_id
       WHERE sp.tenant_id = $1 ORDER BY sp.priority, sp.name`,
      [tenantId],
    );
    return res.json({ policies: rows });
  } catch (err) {
    logger.error('Failed to list SLA policies', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list SLA policies' });
  }
};

const createSlaPolicyHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, description, priority, category_id, first_response_minutes, resolution_minutes, escalation_minutes } = req.body;
  if (!name || !priority) return res.status(400).json({ error: 'name and priority are required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO ticket_sla_policies (tenant_id, name, description, priority, category_id, first_response_minutes, resolution_minutes, escalation_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [tenantId, name, description || '', priority, category_id || null, first_response_minutes || 480, resolution_minutes || 2880, escalation_minutes || null],
    );
    return res.status(201).json({ policy: rows[0] });
  } catch (err) {
    logger.error('Failed to create SLA policy', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create SLA policy' });
  }
};

const updateSlaPolicyHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, description, priority, category_id, first_response_minutes, resolution_minutes, escalation_minutes, is_active } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE ticket_sla_policies SET name = COALESCE($3, name), description = COALESCE($4, description),
       priority = COALESCE($5, priority), category_id = COALESCE($6, category_id),
       first_response_minutes = COALESCE($7, first_response_minutes), resolution_minutes = COALESCE($8, resolution_minutes),
       escalation_minutes = COALESCE($9, escalation_minutes), is_active = COALESCE($10, is_active),
       updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, description, priority, category_id, first_response_minutes, resolution_minutes, escalation_minutes, is_active],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'SLA policy not found' });
    return res.json({ policy: rows[0] });
  } catch (err) {
    logger.error('Failed to update SLA policy', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update SLA policy' });
  }
};

const deleteSlaPolicyHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ticket_sla_policies WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'SLA policy not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete SLA policy', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete SLA policy' });
  }
};

const listMacrosHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT m.*, u.email AS created_by_email FROM ticket_macros m LEFT JOIN users u ON u.id = m.created_by WHERE m.tenant_id = $1 ORDER BY m.name`,
      [tenantId],
    );
    return res.json({ macros: rows });
  } catch (err) {
    logger.error('Failed to list macros', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list macros' });
  }
};

const createMacroHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { name, description, actions } = req.body;
  if (!name || !actions) return res.status(400).json({ error: 'name and actions are required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO ticket_macros (tenant_id, name, description, actions, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tenantId, name, description || '', JSON.stringify(actions), userId],
    );
    return res.status(201).json({ macro: rows[0] });
  } catch (err) {
    logger.error('Failed to create macro', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create macro' });
  }
};

const updateMacroHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, description, actions, is_active } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE ticket_macros SET name = COALESCE($3, name), description = COALESCE($4, description),
       actions = COALESCE($5, actions), is_active = COALESCE($6, is_active),
       updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, description, actions ? JSON.stringify(actions) : undefined, is_active],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Macro not found' });
    return res.json({ macro: rows[0] });
  } catch (err) {
    logger.error('Failed to update macro', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update macro' });
  }
};

const deleteMacroHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ticket_macros WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Macro not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete macro', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete macro' });
  }
};

const listTemplatesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT t.*, c.name AS category_name FROM ticket_templates t LEFT JOIN ticket_categories c ON c.id = t.category_id WHERE t.tenant_id = $1 ORDER BY t.name`,
      [tenantId],
    );
    return res.json({ templates: rows });
  } catch (err) {
    logger.error('Failed to list templates', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list templates' });
  }
};

const createTemplateHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { name, subject, body, category_id, variables } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'name and body are required' });
  // Reject typos like {{custmer_name}} server-side too so the inline
  // editor warning can't be bypassed via direct API calls — see task
  // #806 and shared/tickets/templateTokens.ts.
  const unknownTokens = findUnknownTicketTemplateTokens(body);
  if (unknownTokens.length > 0) {
    return res.status(400).json({
      error: `Unknown merge token${unknownTokens.length === 1 ? '' : 's'}: ${unknownTokens
        .map((t) => `{{${t}}}`)
        .join(', ')}. Supported tokens: ${TICKET_TEMPLATE_TOKENS
        .map((t) => `{{${t}}}`)
        .join(', ')}.`,
      unknownTokens,
      knownTokens: TICKET_TEMPLATE_TOKENS,
    });
  }
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO ticket_templates (tenant_id, name, subject, body, category_id, variables, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenantId, name, subject || '', body, category_id || null, JSON.stringify(variables || []), userId],
    );
    return res.status(201).json({ template: rows[0] });
  } catch (err) {
    logger.error('Failed to create template', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create template' });
  }
};

const updateTemplateHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, subject, body, category_id, variables, is_active } = req.body;
  if (body !== undefined) {
    const unknownTokens = findUnknownTicketTemplateTokens(body);
    if (unknownTokens.length > 0) {
      return res.status(400).json({
        error: `Unknown merge token${unknownTokens.length === 1 ? '' : 's'}: ${unknownTokens
          .map((t) => `{{${t}}}`)
          .join(', ')}. Supported tokens: ${TICKET_TEMPLATE_TOKENS
          .map((t) => `{{${t}}}`)
          .join(', ')}.`,
        unknownTokens,
        knownTokens: TICKET_TEMPLATE_TOKENS,
      });
    }
  }
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE ticket_templates SET name = COALESCE($3, name), subject = COALESCE($4, subject),
       body = COALESCE($5, body), category_id = COALESCE($6, category_id),
       variables = COALESCE($7, variables), is_active = COALESCE($8, is_active),
       updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, subject, body, category_id, variables ? JSON.stringify(variables) : undefined, is_active],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    return res.json({ template: rows[0] });
  } catch (err) {
    logger.error('Failed to update template', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update template' });
  }
};

const deleteTemplateHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ticket_templates WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete template', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete template' });
  }
};

const listSavedViewsHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ticket_saved_views WHERE tenant_id = $1 AND (created_by = $2 OR is_shared = true) ORDER BY name`,
      [tenantId, userId],
    );
    return res.json({ views: rows });
  } catch (err) {
    logger.error('Failed to list saved views', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list saved views' });
  }
};

const createSavedViewHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { name, filters, sort_by, sort_order, is_shared } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO ticket_saved_views (tenant_id, name, filters, sort_by, sort_order, is_shared, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenantId, name, JSON.stringify(filters || {}), sort_by || 'created_at', sort_order || 'desc', is_shared || false, userId],
    );
    return res.status(201).json({ view: rows[0] });
  } catch (err) {
    logger.error('Failed to create saved view', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create saved view' });
  }
};

const deleteSavedViewHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ticket_saved_views WHERE id = $1 AND tenant_id = $2 AND created_by = $3`,
      [id, tenantId, userId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Saved view not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete saved view', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete saved view' });
  }
};

const listWorkflowRulesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ticket_workflow_rules WHERE tenant_id = $1 ORDER BY sort_order, name`,
      [tenantId],
    );
    return res.json({ rules: rows });
  } catch (err) {
    logger.error('Failed to list workflow rules', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list workflow rules' });
  }
};

const createWorkflowRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, description, trigger_event, conditions, actions, sort_order } = req.body;
  if (!name || !trigger_event) return res.status(400).json({ error: 'name and trigger_event are required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO ticket_workflow_rules (tenant_id, name, description, trigger_event, conditions, actions, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenantId, name, description || '', trigger_event, JSON.stringify(conditions || {}), JSON.stringify(actions || []), sort_order || 0],
    );
    return res.status(201).json({ rule: rows[0] });
  } catch (err) {
    logger.error('Failed to create workflow rule', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create workflow rule' });
  }
};

const updateWorkflowRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, description, trigger_event, conditions, actions, sort_order, is_active } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE ticket_workflow_rules SET name = COALESCE($3, name), description = COALESCE($4, description),
       trigger_event = COALESCE($5, trigger_event), conditions = COALESCE($6, conditions),
       actions = COALESCE($7, actions), sort_order = COALESCE($8, sort_order), is_active = COALESCE($9, is_active),
       updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, description, trigger_event, conditions ? JSON.stringify(conditions) : undefined, actions ? JSON.stringify(actions) : undefined, sort_order, is_active],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Workflow rule not found' });
    return res.json({ rule: rows[0] });
  } catch (err) {
    logger.error('Failed to update workflow rule', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update workflow rule' });
  }
};

const deleteWorkflowRuleHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ticket_workflow_rules WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Workflow rule not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete workflow rule', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete workflow rule' });
  }
};

const listCustomFieldsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ticket_custom_fields WHERE tenant_id = $1 ORDER BY sort_order, name`,
      [tenantId],
    );
    return res.json({ fields: rows });
  } catch (err) {
    logger.error('Failed to list custom fields', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list custom fields' });
  }
};

const createCustomFieldHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, field_key, field_type, options, is_required, sort_order } = req.body;
  if (!name || !field_key || !field_type) return res.status(400).json({ error: 'name, field_key, and field_type are required' });
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `INSERT INTO ticket_custom_fields (tenant_id, name, field_key, field_type, options, is_required, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenantId, name, field_key, field_type, JSON.stringify(options || []), is_required || false, sort_order || 0],
    );
    return res.status(201).json({ field: rows[0] });
  } catch (err) {
    logger.error('Failed to create custom field', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create custom field' });
  }
};

const updateCustomFieldHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, field_type, options, is_required, is_active, sort_order } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE ticket_custom_fields SET name = COALESCE($3, name), field_type = COALESCE($4, field_type),
       options = COALESCE($5, options), is_required = COALESCE($6, is_required),
       is_active = COALESCE($7, is_active), sort_order = COALESCE($8, sort_order),
       updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, field_type, options ? JSON.stringify(options) : undefined, is_required, is_active, sort_order],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Custom field not found' });
    return res.json({ field: rows[0] });
  } catch (err) {
    logger.error('Failed to update custom field', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update custom field' });
  }
};

const deleteCustomFieldHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ticket_custom_fields WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Custom field not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete custom field', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete custom field' });
  }
};

const linkTicketHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { target_ticket_id, link_type } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows: sourceCheck } = await pool.query(
      `SELECT id FROM tickets WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (sourceCheck.length === 0) return res.status(404).json({ error: 'Source ticket not found' });

    const { rows: targetCheck } = await pool.query(
      `SELECT id FROM tickets WHERE id = $1 AND tenant_id = $2`, [target_ticket_id, tenantId],
    );
    if (targetCheck.length === 0) return res.status(400).json({ error: 'Target ticket not found in this tenant' });

    await pool.query(
      `INSERT INTO ticket_links (tenant_id, source_ticket_id, target_ticket_id, link_type, created_by)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (source_ticket_id, target_ticket_id) DO NOTHING`,
      [tenantId, id, target_ticket_id, link_type || 'related', userId],
    );
    await pool.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content, new_value)
       VALUES ($1, $2, $3, 'linked', $4, $5)`,
      [tenantId, id, userId, `Linked to ticket`, target_ticket_id],
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to link tickets', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to link tickets' });
  }
};

const unlinkTicketHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id, linkId } = req.params;
  const pool = getPlatformPool();
  try {
    await pool.query(
      `DELETE FROM ticket_links WHERE id = $1 AND tenant_id = $2`, [linkId, tenantId],
    );
    await pool.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
       VALUES ($1, $2, $3, 'unlinked', 'Removed linked ticket')`,
      [tenantId, id, req.user!.userId],
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to unlink tickets', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to unlink tickets' });
  }
};

const uploadAttachmentHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const { file_name, file_url, file_size, file_type } = req.body;
  const pool = getPlatformPool();

  if (!file_name || !file_url) return res.status(400).json({ error: 'file_name and file_url are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: ticketCheck } = await client.query(
      `SELECT id FROM tickets WHERE id = $1 AND tenant_id = $2`, [id, tenantId],
    );
    if (ticketCheck.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Ticket not found' }); }

    const { rows } = await client.query(
      `INSERT INTO ticket_attachments (tenant_id, ticket_id, file_name, file_url, file_size, file_type, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenantId, id, file_name, file_url, file_size || 0, file_type || 'application/octet-stream', userId],
    );

    await client.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
       VALUES ($1, $2, $3, 'attachment_added', $4)`,
      [tenantId, id, userId, `Attached file: ${file_name}`],
    );

    await client.query('COMMIT');
    return res.json({ attachment: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to upload attachment', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to upload attachment' });
  } finally {
    client.release();
  }
};

const listAttachmentsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();

  try {
    const { rows } = await pool.query(
      `SELECT ta.*, u.email AS uploaded_by_email FROM ticket_attachments ta
       LEFT JOIN users u ON u.id = ta.uploaded_by AND u.tenant_id = $2
       WHERE ta.ticket_id = $1 AND ta.tenant_id = $2 ORDER BY ta.created_at DESC`,
      [id, tenantId],
    );
    return res.json({ attachments: rows });
  } catch (err) {
    logger.error('Failed to list attachments', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list attachments' });
  }
};

const deleteAttachmentHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id, attachmentId } = req.params;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM ticket_attachments WHERE id = $1 AND ticket_id = $2 AND tenant_id = $3`,
      [attachmentId, id, tenantId],
    );
    await client.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
       VALUES ($1, $2, $3, 'attachment_removed', 'Removed attachment')`,
      [tenantId, id, req.user!.userId],
    );
    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to delete attachment', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete attachment' });
  } finally {
    client.release();
  }
};

const processSlaBreachesHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: breached } = await client.query(
      `SELECT si.id, si.ticket_id, si.response_due_at, si.resolution_due_at,
              si.response_met, si.resolution_met, t.subject, t.status, t.assignee_user_id, t.ticket_number
       FROM ticket_sla_instances si
       JOIN tickets t ON t.id = si.ticket_id AND t.tenant_id = si.tenant_id
       WHERE si.tenant_id = $1 AND si.paused_at IS NULL
         AND t.status NOT IN ('closed', 'resolved')
         AND (
           (si.response_due_at < NOW() AND si.response_met IS NULL)
           OR (si.resolution_due_at < NOW() AND si.resolution_met IS NULL)
         )`,
      [tenantId],
    );

    let breachCount = 0;
    for (const sla of breached) {
      if (sla.response_due_at && new Date(sla.response_due_at) < new Date() && sla.response_met === null) {
        await client.query(
          `UPDATE ticket_sla_instances SET response_met = false WHERE id = $1 AND tenant_id = $2`,
          [sla.id, tenantId],
        );
        await client.query(
          `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
           VALUES ($1, $2, $3, 'sla_breached', 'SLA first response time breached')`,
          [tenantId, sla.ticket_id, userId],
        );
        breachCount++;
      }
      if (sla.resolution_due_at && new Date(sla.resolution_due_at) < new Date() && sla.resolution_met === null) {
        await client.query(
          `UPDATE ticket_sla_instances SET resolution_met = false WHERE id = $1 AND tenant_id = $2`,
          [sla.id, tenantId],
        );
        await client.query(
          `UPDATE tickets SET status = 'escalated', updated_at = NOW() WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('closed', 'resolved', 'escalated')`,
          [sla.ticket_id, tenantId],
        );
        await client.query(
          `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
           VALUES ($1, $2, $3, 'sla_breached', 'SLA resolution time breached - ticket escalated')`,
          [tenantId, sla.ticket_id, userId],
        );
        breachCount++;
      }

      if (sla.assignee_user_id) {
        dispatchTicketNotification(pool, tenantId, sla.ticket_id, sla.assignee_user_id, 'sla_breach',
          `SLA breach on ticket #${sla.ticket_number || ''}`,
          `A ticket assigned to you has breached its SLA policy and requires immediate attention.`);
      }
    }

    await client.query('COMMIT');
    return res.json({ success: true, breaches_processed: breachCount, tickets_checked: breached.length });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to process SLA breaches', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to process SLA breaches' });
  } finally {
    client.release();
  }
};

const autoCloseHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { days_resolved = 14, days_pending = 30 } = req.body;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: resolvedTickets } = await client.query(
      `UPDATE tickets SET status = 'closed', closed_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND status = 'resolved'
         AND resolved_at < NOW() - ($2 || ' days')::interval
       RETURNING id, subject`,
      [tenantId, String(days_resolved)],
    );

    const { rows: pendingTickets } = await client.query(
      `UPDATE tickets SET status = 'closed', closed_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND status = 'pending'
         AND updated_at < NOW() - ($2 || ' days')::interval
       RETURNING id, subject`,
      [tenantId, String(days_pending)],
    );

    const allClosed = [...resolvedTickets, ...pendingTickets];

    for (const ticket of allClosed) {
      await client.query(
        `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, content)
         VALUES ($1, $2, $3, 'auto_closed', 'Ticket auto-closed due to inactivity')`,
        [tenantId, ticket.id, userId],
      );
    }

    await client.query('COMMIT');
    return res.json({
      success: true,
      auto_closed: allClosed.length,
      resolved_closed: resolvedTickets.length,
      pending_closed: pendingTickets.length,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to auto-close tickets', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to auto-close tickets' });
  } finally {
    client.release();
  }
};


const listQueueConfigsHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(`SELECT * FROM ticket_queue_configs WHERE tenant_id = $1 ORDER BY name`, [tenantId]);
    return res.json({ queues: rows });
  } catch (err) {
    logger.error('Failed to list queue configs', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list queue configs' });
  }
};

const createQueueConfigHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, description, assignment_strategy, eligible_user_ids, filter_priority, filter_category_id, filter_department, max_tickets_per_agent } = req.body;
  const pool = getPlatformPool();
  try {
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await pool.query(
      `INSERT INTO ticket_queue_configs (tenant_id, name, description, assignment_strategy, eligible_user_ids, filter_priority, filter_category_id, filter_department, max_tickets_per_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [tenantId, name, description || '', assignment_strategy || 'manual', eligible_user_ids || [], filter_priority || [], filter_category_id || null, filter_department || '', max_tickets_per_agent || 0],
    );
    return res.status(201).json({ queue: rows[0] });
  } catch (err) {
    logger.error('Failed to create queue config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create queue config' });
  }
};

const updateQueueConfigHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, description, assignment_strategy, eligible_user_ids, filter_priority, filter_category_id, filter_department, max_tickets_per_agent, is_active } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE ticket_queue_configs SET
        name = COALESCE($3, name), description = COALESCE($4, description),
        assignment_strategy = COALESCE($5, assignment_strategy),
        eligible_user_ids = COALESCE($6, eligible_user_ids),
        filter_priority = COALESCE($7, filter_priority),
        filter_category_id = COALESCE($8, filter_category_id),
        filter_department = COALESCE($9, filter_department),
        max_tickets_per_agent = COALESCE($10, max_tickets_per_agent),
        is_active = COALESCE($11, is_active),
        updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, description, assignment_strategy, eligible_user_ids, filter_priority, filter_category_id, filter_department, max_tickets_per_agent, is_active],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Queue config not found' });
    return res.json({ queue: rows[0] });
  } catch (err) {
    logger.error('Failed to update queue config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update queue config' });
  }
};

const deleteQueueConfigHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(`DELETE FROM ticket_queue_configs WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Queue config not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete queue config', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete queue config' });
  }
};

const autoAssignHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { ticket_id, queue_id } = req.body;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: ticketRows } = await client.query(
      `SELECT * FROM tickets WHERE id = $1 AND tenant_id = $2 AND assignee_user_id IS NULL FOR UPDATE SKIP LOCKED`,
      [ticket_id, tenantId],
    );
    if (ticketRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ticket already assigned or not found' });
    }
    const ticket = ticketRows[0];

    let queueConfig;
    if (queue_id) {
      const { rows: qr } = await client.query(
        `SELECT * FROM ticket_queue_configs WHERE id = $1 AND tenant_id = $2 AND is_active = true FOR UPDATE`,
        [queue_id, tenantId],
      );
      if (qr.length > 0) queueConfig = qr[0];
    } else {
      const { rows: qr } = await client.query(
        `SELECT * FROM ticket_queue_configs WHERE tenant_id = $1 AND is_active = true AND assignment_strategy != 'manual'
         ORDER BY sort_order LIMIT 10 FOR UPDATE`,
        [tenantId],
      );
      queueConfig = qr.find((q: Record<string, unknown>) => {
        const fp = (q.filter_priority as string[]) || [];
        const fd = q.filter_department as string;
        const fc = q.filter_category_id as string;
        if (fp.length > 0 && !fp.includes(ticket.priority)) return false;
        if (fd && fd !== ticket.department) return false;
        if (fc && fc !== ticket.category_id) return false;
        return true;
      });
    }

    if (!queueConfig || queueConfig.assignment_strategy === 'manual') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No matching auto-assignment queue found' });
    }

    const eligibleIds: string[] = queueConfig.eligible_user_ids || [];
    if (eligibleIds.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No eligible agents in queue' });
    }

    let selectedUserId: string | null = null;

    if (queueConfig.assignment_strategy === 'round_robin') {
      const { rows: loads } = await client.query(
        `SELECT assignee_user_id, COUNT(*) AS cnt FROM tickets
         WHERE tenant_id = $1 AND assignee_user_id = ANY($2) AND status NOT IN ('closed', 'resolved')
         GROUP BY assignee_user_id`,
        [tenantId, eligibleIds],
      );
      const loadMap: Record<string, number> = {};
      for (const l of loads) loadMap[l.assignee_user_id] = parseInt(l.cnt as string);

      for (let attempt = 0; attempt < eligibleIds.length; attempt++) {
        const nextIdx = (queueConfig.last_assigned_user_index + 1 + attempt) % eligibleIds.length;
        const candidateId = eligibleIds[nextIdx];
        const candidateLoad = loadMap[candidateId] || 0;
        if (queueConfig.max_tickets_per_agent > 0 && candidateLoad >= queueConfig.max_tickets_per_agent) continue;
        selectedUserId = candidateId;
        await client.query(
          `UPDATE ticket_queue_configs SET last_assigned_user_index = $3 WHERE id = $1 AND tenant_id = $2`,
          [queueConfig.id, tenantId, nextIdx],
        );
        break;
      }
    } else if (queueConfig.assignment_strategy === 'least_loaded') {
      const { rows: loads } = await client.query(
        `SELECT assignee_user_id, COUNT(*) AS cnt FROM tickets
         WHERE tenant_id = $1 AND assignee_user_id = ANY($2) AND status NOT IN ('closed', 'resolved')
         GROUP BY assignee_user_id`,
        [tenantId, eligibleIds],
      );
      const loadMap: Record<string, number> = {};
      for (const l of loads) loadMap[l.assignee_user_id] = parseInt(l.cnt as string);
      let minLoad = Infinity;
      for (const uid of eligibleIds) {
        const load = loadMap[uid] || 0;
        if (queueConfig.max_tickets_per_agent > 0 && load >= queueConfig.max_tickets_per_agent) continue;
        if (load < minLoad) { minLoad = load; selectedUserId = uid; }
      }
    }

    if (!selectedUserId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'All eligible agents at capacity' });
    }

    await client.query(
      `UPDATE tickets SET assignee_user_id = $3, updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [ticket_id, tenantId, selectedUserId],
    );

    await client.query(
      `INSERT INTO ticket_activity_log (tenant_id, ticket_id, user_id, activity_type, new_value, content)
       VALUES ($1, $2, NULL, 'assigned', $3, $4)`,
      [tenantId, ticket_id, selectedUserId, `Auto-assigned via queue "${queueConfig.name}"`],
    );

    await client.query('COMMIT');

    dispatchTicketNotification(pool, tenantId, ticket_id, selectedUserId, 'assignment',
      `Ticket #${ticket.ticket_number} auto-assigned to you`,
      `You have been automatically assigned ticket "${ticket.subject}" via queue "${queueConfig.name}".`);

    return res.json({ success: true, assigned_to: selectedUserId, queue: queueConfig.name });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to auto-assign ticket', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to auto-assign ticket' });
  } finally {
    client.release();
  }
};

const listRetentionPoliciesHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(`SELECT * FROM ticket_retention_policies WHERE tenant_id = $1 ORDER BY name`, [tenantId]);
    return res.json({ policies: rows });
  } catch (err) {
    logger.error('Failed to list retention policies', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list retention policies' });
  }
};

const createRetentionPolicyHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { name, description, target_status, days_after_close, action } = req.body;
  const pool = getPlatformPool();
  try {
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await pool.query(
      `INSERT INTO ticket_retention_policies (tenant_id, name, description, target_status, days_after_close, action)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tenantId, name, description || '', target_status || 'closed', days_after_close || 90, action || 'archive'],
    );
    return res.status(201).json({ policy: rows[0] });
  } catch (err) {
    logger.error('Failed to create retention policy', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create retention policy' });
  }
};

const updateRetentionPolicyHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const { name, description, target_status, days_after_close, action, is_active } = req.body;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `UPDATE ticket_retention_policies SET
        name = COALESCE($3, name), description = COALESCE($4, description),
        target_status = COALESCE($5, target_status), days_after_close = COALESCE($6, days_after_close),
        action = COALESCE($7, action), is_active = COALESCE($8, is_active), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, name, description, target_status, days_after_close, action, is_active],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Retention policy not found' });
    return res.json({ policy: rows[0] });
  } catch (err) {
    logger.error('Failed to update retention policy', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update retention policy' });
  }
};

const deleteRetentionPolicyHandler: RequestHandler = async (req, res) => {
  const { tenantId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(`DELETE FROM ticket_retention_policies WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Retention policy not found' });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete retention policy', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to delete retention policy' });
  }
};

const executeRetentionHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const pool = getPlatformPool();

  try {
    const { rows: policies } = await pool.query(
      `SELECT * FROM ticket_retention_policies WHERE tenant_id = $1 AND is_active = true`,
      [tenantId],
    );

    let processed = 0;
    for (const policy of policies) {
      const interval = `${policy.days_after_close} days`;
      if (policy.action === 'archive') {
        const { rowCount } = await pool.query(
          `UPDATE tickets SET archived_at = NOW(), updated_at = NOW()
           WHERE tenant_id = $1 AND status = $2 AND closed_at < NOW() - $3::interval AND archived_at IS NULL`,
          [tenantId, policy.target_status, interval],
        );
        processed += rowCount || 0;
      } else if (policy.action === 'delete') {
        const { rowCount } = await pool.query(
          `DELETE FROM tickets WHERE tenant_id = $1 AND status = $2 AND closed_at < NOW() - $3::interval`,
          [tenantId, policy.target_status, interval],
        );
        processed += rowCount || 0;
      } else if (policy.action === 'anonymize') {
        const { rowCount } = await pool.query(
          `UPDATE tickets SET contact_name = 'Anonymized', contact_email = '', contact_phone = '', description = '[Anonymized]', updated_at = NOW()
           WHERE tenant_id = $1 AND status = $2 AND closed_at < NOW() - $3::interval AND contact_name != 'Anonymized'`,
          [tenantId, policy.target_status, interval],
        );
        processed += rowCount || 0;
      }

      await pool.query(`UPDATE ticket_retention_policies SET last_run_at = NOW() WHERE id = $1`, [policy.id]);
    }

    logger.info('Retention policies executed', { tenantId, userId, policiesRun: policies.length, ticketsProcessed: processed });

    return res.json({ success: true, policies_run: policies.length, tickets_processed: processed });
  } catch (err) {
    logger.error('Failed to execute retention policies', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to execute retention policies' });
  }
};

const listNotificationsHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT n.*, t.subject AS ticket_subject, t.ticket_number FROM ticket_notifications n
       LEFT JOIN tickets t ON t.id = n.ticket_id
       WHERE n.tenant_id = $1 AND n.user_id = $2 ORDER BY n.sent_at DESC LIMIT 50`,
      [tenantId, userId],
    );
    return res.json({ notifications: rows });
  } catch (err) {
    logger.error('Failed to list notifications', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to list notifications' });
  }
};

const markNotificationReadHandler: RequestHandler = async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { id } = req.params;
  const pool = getPlatformPool();
  try {
    await pool.query(
      `UPDATE ticket_notifications SET is_read = true WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [id, tenantId, userId],
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to mark notification read', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to mark notification read' });
  }
};

router.get('/tickets', requireAuth, listTicketsHandler);
router.get('/tickets/stats', requireAuth, getTicketStatsHandler);
router.get('/tickets/reporting', requireAuth, getReportingHandler);
router.post('/tickets', requireAuth, requireMiniSystemWrite, createTicketHandler);
router.post('/tickets/bulk', requireAuth, requireMiniSystemWrite, bulkUpdateHandler);
router.post('/tickets/sla/process-breaches', requireAuth, requireMiniSystemWrite, processSlaBreachesHandler);
router.post('/tickets/auto-close', requireAuth, requireMiniSystemWrite, autoCloseHandler);
router.post('/tickets/auto-assign', requireAuth, requireMiniSystemWrite, autoAssignHandler);
router.post('/tickets/retention/execute', requireAuth, requireMiniSystemWrite, executeRetentionHandler);
router.get('/tickets/:id', requireAuth, getTicketHandler);
router.get('/tickets/:id/activity', requireAuth, getTicketActivityHandler);
router.put('/tickets/:id', requireAuth, requireMiniSystemWrite, updateTicketHandler);
router.delete('/tickets/:id', requireAuth, requireMiniSystemWrite, deleteTicketHandler);
router.post('/tickets/:id/notes', requireAuth, requireMiniSystemWrite, addTicketNoteHandler);
router.post('/tickets/:id/watchers', requireAuth, requireMiniSystemWrite, addWatcherHandler);
router.delete('/tickets/:id/watchers/:userId', requireAuth, requireMiniSystemWrite, removeWatcherHandler);
router.post('/tickets/:id/links', requireAuth, requireMiniSystemWrite, linkTicketHandler);
router.delete('/tickets/:id/links/:linkId', requireAuth, requireMiniSystemWrite, unlinkTicketHandler);
router.post('/tickets/:id/macro', requireAuth, requireMiniSystemWrite, applyMacroHandler);
router.get('/tickets/:id/attachments', requireAuth, listAttachmentsHandler);
router.post('/tickets/:id/attachments', requireAuth, requireMiniSystemWrite, uploadAttachmentHandler);
router.delete('/tickets/:id/attachments/:attachmentId', requireAuth, requireMiniSystemWrite, deleteAttachmentHandler);

router.get('/ticket-categories', requireAuth, listCategoriesHandler);
router.post('/ticket-categories', requireAuth, requireMiniSystemWrite, createCategoryHandler);
router.put('/ticket-categories/:id', requireAuth, requireMiniSystemWrite, updateCategoryHandler);
router.delete('/ticket-categories/:id', requireAuth, requireMiniSystemWrite, deleteCategoryHandler);

router.get('/ticket-sla-policies', requireAuth, listSlaPoliciesHandler);
router.post('/ticket-sla-policies', requireAuth, requireMiniSystemWrite, createSlaPolicyHandler);
router.put('/ticket-sla-policies/:id', requireAuth, requireMiniSystemWrite, updateSlaPolicyHandler);
router.delete('/ticket-sla-policies/:id', requireAuth, requireMiniSystemWrite, deleteSlaPolicyHandler);

router.get('/ticket-macros', requireAuth, listMacrosHandler);
router.post('/ticket-macros', requireAuth, requireMiniSystemWrite, createMacroHandler);
router.put('/ticket-macros/:id', requireAuth, requireMiniSystemWrite, updateMacroHandler);
router.delete('/ticket-macros/:id', requireAuth, requireMiniSystemWrite, deleteMacroHandler);

router.get('/ticket-templates', requireAuth, listTemplatesHandler);
router.post('/ticket-templates', requireAuth, requireMiniSystemWrite, createTemplateHandler);
router.put('/ticket-templates/:id', requireAuth, requireMiniSystemWrite, updateTemplateHandler);
router.delete('/ticket-templates/:id', requireAuth, requireMiniSystemWrite, deleteTemplateHandler);

router.get('/ticket-saved-views', requireAuth, listSavedViewsHandler);
router.post('/ticket-saved-views', requireAuth, requireMiniSystemWrite, createSavedViewHandler);
router.delete('/ticket-saved-views/:id', requireAuth, requireMiniSystemWrite, deleteSavedViewHandler);

router.get('/ticket-workflow-rules', requireAuth, listWorkflowRulesHandler);
router.post('/ticket-workflow-rules', requireAuth, requireMiniSystemWrite, createWorkflowRuleHandler);
router.put('/ticket-workflow-rules/:id', requireAuth, requireMiniSystemWrite, updateWorkflowRuleHandler);
router.delete('/ticket-workflow-rules/:id', requireAuth, requireMiniSystemWrite, deleteWorkflowRuleHandler);

router.get('/ticket-custom-fields', requireAuth, listCustomFieldsHandler);
router.post('/ticket-custom-fields', requireAuth, requireMiniSystemWrite, createCustomFieldHandler);
router.put('/ticket-custom-fields/:id', requireAuth, requireMiniSystemWrite, updateCustomFieldHandler);
router.delete('/ticket-custom-fields/:id', requireAuth, requireMiniSystemWrite, deleteCustomFieldHandler);

router.get('/ticket-queue-configs', requireAuth, listQueueConfigsHandler);
router.post('/ticket-queue-configs', requireAuth, requireMiniSystemWrite, createQueueConfigHandler);
router.put('/ticket-queue-configs/:id', requireAuth, requireMiniSystemWrite, updateQueueConfigHandler);
router.delete('/ticket-queue-configs/:id', requireAuth, requireMiniSystemWrite, deleteQueueConfigHandler);

router.get('/ticket-retention-policies', requireAuth, listRetentionPoliciesHandler);
router.post('/ticket-retention-policies', requireAuth, requireMiniSystemWrite, createRetentionPolicyHandler);
router.put('/ticket-retention-policies/:id', requireAuth, requireMiniSystemWrite, updateRetentionPolicyHandler);
router.delete('/ticket-retention-policies/:id', requireAuth, requireMiniSystemWrite, deleteRetentionPolicyHandler);

router.get('/ticket-notifications', requireAuth, listNotificationsHandler);
router.put('/ticket-notifications/:id/read', requireAuth, markNotificationReadHandler);

export default router;
