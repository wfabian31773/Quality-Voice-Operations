import type { PoolClient } from 'pg';
import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('TENANT_PROVISIONING');

export type ProvisioningStatus = 'pending' | 'provisioning' | 'ready';

export interface ProvisioningResult {
  tenantId: string;
  agentId: string;
  status: ProvisioningStatus;
}

// Starter dispatch SMS templates seeded the first time a tenant
// provisions. The trigger_event values mirror STATUS_TO_TRIGGER in
// `server/admin-api/routes/dispatch.ts` (assigned -> job_assigned,
// scheduled -> job_scheduled, en_route -> en_route, on_site -> arrival,
// completed -> completed) and the body tokens are exactly the ones the
// `substitute()` chain in `fireNotifications` knows how to replace.
//
// The en_route template intentionally embeds {{tracking_url}} so the
// public booking-tracker link goes out the moment a tech hits "en
// route" — without this seed a freshly-provisioned tenant would have
// no template at all and `fireNotifications` would silently no-op
// (see migration 089 for the matching backfill on existing tenants).
export const DEFAULT_DISPATCH_TEMPLATES: Array<{
  name: string;
  trigger_event: string;
  channel: 'sms';
  subject: string;
  body_template: string;
}> = [
  {
    name: 'Job assigned (default)',
    trigger_event: 'job_assigned',
    channel: 'sms',
    subject: '',
    body_template:
      'Hi {{contact_name}}, we\'ve assigned {{resource_name}} to your {{job_title}} appointment. We\'ll text again when they\'re on the way.',
  },
  {
    name: 'Job scheduled (default)',
    trigger_event: 'job_scheduled',
    channel: 'sms',
    subject: '',
    body_template:
      'Hi {{contact_name}}, your {{job_title}} appointment is scheduled for {{eta}}. Reply to this message if you need to reschedule.',
  },
  {
    name: 'En route (default)',
    trigger_event: 'en_route',
    channel: 'sms',
    subject: '',
    body_template:
      'Hi {{contact_name}}, {{resource_name}} is on the way for your {{job_title}} appointment — ETA about {{eta_drive_minutes}} min ({{eta_arrival_time}}).\n\nTrack your tech: {{tracking_url}}',
  },
  {
    name: 'On site (default)',
    trigger_event: 'arrival',
    channel: 'sms',
    subject: '',
    body_template:
      'Hi {{contact_name}}, {{resource_name}} has arrived at {{address}} for your {{job_title}} appointment.',
  },
  {
    name: 'Completed (default)',
    trigger_event: 'completed',
    channel: 'sms',
    subject: '',
    body_template:
      'Hi {{contact_name}}, your {{job_title}} appointment is complete. Thanks for choosing us — please reach out if you have any questions.',
  },
];

/**
 * Seed the default dispatch SMS templates for a tenant. Idempotent:
 * skips entirely if the tenant already has any rows in
 * `dispatch_notification_templates` (so re-provisioning, manual seeds,
 * or tenants backfilled via migration 089 are never disturbed).
 *
 * Intentional behavior: this is "seed when empty," NOT "ensure full
 * pack." If a tenant already has *any* template (even just one
 * trigger), we do not top up the missing trigger_events. Reasoning:
 * any pre-existing row implies someone (a dispatcher or a prior
 * backfill) has already curated the tenant's templates, and silently
 * adding more rows under the operator could surprise customers with
 * unexpected outbound SMS. The dispatch CRUD API in
 * `server/admin-api/routes/dispatch.ts` is the supported way to fill
 * in missing triggers after the fact.
 *
 * Runs inside the caller's transaction so a seed failure rolls back
 * with the rest of provisioning rather than leaving a half-seeded
 * tenant behind.
 */
export async function seedDefaultDispatchTemplates(
  client: PoolClient,
  tenantId: string,
): Promise<number> {
  const { rows: existing } = await client.query(
    `SELECT 1 FROM dispatch_notification_templates WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  if (existing.length > 0) return 0;

  let inserted = 0;
  for (const tpl of DEFAULT_DISPATCH_TEMPLATES) {
    await client.query(
      `INSERT INTO dispatch_notification_templates
         (tenant_id, name, trigger_event, channel, subject, body_template, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [tenantId, tpl.name, tpl.trigger_event, tpl.channel, tpl.subject, tpl.body_template],
    );
    inserted += 1;
  }
  return inserted;
}

export async function provisionTenant(
  tenantId: string,
  userId: string,
  plan: string,
): Promise<ProvisioningResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);

    const { rows: lockRows } = await client.query(
      `SELECT id, status FROM tenants WHERE id = $1 FOR UPDATE`,
      [tenantId],
    );

    if (lockRows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`Tenant not found: ${tenantId}`);
    }

    const currentStatus = lockRows[0].status as string;
    if (currentStatus === 'active') {
      const { rows: existingAgents } = await client.query(
        `SELECT id FROM agents WHERE tenant_id = $1 LIMIT 1`, [tenantId],
      );
      await client.query('COMMIT');
      logger.info('Tenant already provisioned, skipping', { tenantId });
      return { tenantId, agentId: existingAgents[0]?.id as string ?? '', status: 'ready' };
    }

    if (currentStatus !== 'pending' && currentStatus !== 'provisioning') {
      await client.query('ROLLBACK');
      throw new Error(`Cannot provision tenant in status: ${currentStatus}`);
    }

    await client.query(
      `UPDATE tenants SET status = 'provisioning', updated_at = NOW() WHERE id = $1`,
      [tenantId],
    );

    const { rows: existingAgents } = await client.query(
      `SELECT id FROM agents WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );

    let agentId: string;
    if (existingAgents.length > 0) {
      agentId = existingAgents[0].id as string;
    } else {
      const { rows: agentRows } = await client.query(
        `INSERT INTO agents (tenant_id, name, type, status, voice, model, temperature, tools, escalation_config, metadata)
         VALUES ($1, 'Default Answering Service', 'answering-service', 'active', 'sage', 'gpt-realtime-2', 0.8, '[]', '{}', '{}')
         RETURNING id`,
        [tenantId],
      );
      agentId = agentRows[0].id as string;
    }

    const { rows: existingRole } = await client.query(
      `SELECT id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
      [userId, tenantId],
    );

    if (existingRole.length === 0) {
      await client.query(
        `INSERT INTO user_roles (user_id, tenant_id, role)
         VALUES ($1, $2, 'tenant_owner')`,
        [userId, tenantId],
      );
    }

    // Seed the starter dispatch SMS template pack so the tenant has a
    // working en_route message (with the {{tracking_url}} link) the
    // moment dispatch is used. Idempotent — see
    // seedDefaultDispatchTemplates for the skip-if-already-present
    // guard, which keeps re-provisioning safe.
    const seededTemplates = await seedDefaultDispatchTemplates(client, tenantId);

    await client.query(
      `UPDATE tenants SET status = 'active', plan = $2, updated_at = NOW() WHERE id = $1`,
      [tenantId, plan],
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, changes)
       VALUES ($1, $2, 'system', 'provisioning_complete', 'tenant', $1, $3)`,
      [tenantId, userId, JSON.stringify({
        plan,
        agentId,
        seededDispatchTemplates: seededTemplates,
        provisionedAt: new Date().toISOString(),
      })],
    );

    await client.query('COMMIT');

    logger.info('Tenant provisioned successfully', {
      tenantId,
      userId,
      plan,
      agentId,
      seededDispatchTemplates: seededTemplates,
    });

    return { tenantId, agentId, status: 'ready' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Tenant provisioning failed', { tenantId, userId, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

export async function getProvisioningStatus(
  tenantId: string,
): Promise<{ status: ProvisioningStatus; agentCount: number; phoneNumberCount: number; tenantCreatedAt: string | null }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);

    const { rows: tenantRows } = await client.query(
      `SELECT status, created_at FROM tenants WHERE id = $1`,
      [tenantId],
    );

    if (tenantRows.length === 0) {
      await client.query('COMMIT');
      return { status: 'pending', agentCount: 0, phoneNumberCount: 0, tenantCreatedAt: null };
    }

    const tenantStatus = tenantRows[0].status as string;
    const tenantCreatedAt = tenantRows[0].created_at ? new Date(tenantRows[0].created_at as string).toISOString() : null;

    const { rows: agentCount } = await client.query(
      `SELECT COUNT(*) AS count FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );

    const { rows: phoneCount } = await client.query(
      `SELECT COUNT(*) AS count FROM phone_numbers WHERE tenant_id = $1`,
      [tenantId],
    );

    await client.query('COMMIT');

    let status: ProvisioningStatus;
    if (tenantStatus === 'active') {
      status = 'ready';
    } else if (tenantStatus === 'provisioning') {
      status = 'provisioning';
    } else {
      status = 'pending';
    }

    return {
      status,
      agentCount: parseInt(agentCount[0].count as string, 10),
      phoneNumberCount: parseInt(phoneCount[0].count as string, 10),
      tenantCreatedAt,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
