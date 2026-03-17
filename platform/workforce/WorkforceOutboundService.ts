import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { createCampaign, updateCampaign, addContacts } from '../campaigns/CampaignService';
import type { WorkforceOutboundTask, OutboundCampaignType } from './types';

const logger = createLogger('WORKFORCE_OUTBOUND');

function mapTaskRow(row: Record<string, unknown>): WorkforceOutboundTask {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    teamId: row.team_id as string,
    campaignType: row.campaign_type as OutboundCampaignType,
    name: row.name as string,
    status: row.status as string,
    config: (typeof row.config === 'object' && row.config ? row.config : {}) as Record<string, unknown>,
    campaignId: (row.campaign_id as string) ?? null,
    scheduledAt: row.scheduled_at ? String(row.scheduled_at) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    totalContacts: (row.total_contacts as number) ?? 0,
    contactsReached: (row.contacts_reached as number) ?? 0,
    createdBy: (row.created_by as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const CAMPAIGN_TYPE_MAP: Record<string, string> = {
  appointment_reminder: 'appointment_reminder',
  follow_up: 'lead_followup',
  maintenance_reminder: 'appointment_reminder',
  review_request: 'review_request',
  reactivation: 'customer_reactivation',
  recall: 'appointment_reminder',
  lease_renewal: 'lead_followup',
  custom: 'outbound_call',
};

const CAMPAIGN_TYPE_DEFAULTS: Record<string, { messageTemplate: string; callWindowStart: string; callWindowEnd: string }> = {
  appointment_reminder: {
    messageTemplate: 'This is a friendly reminder about your upcoming appointment.',
    callWindowStart: '09:00',
    callWindowEnd: '18:00',
  },
  follow_up: {
    messageTemplate: 'We wanted to follow up on your recent visit. How was your experience?',
    callWindowStart: '10:00',
    callWindowEnd: '17:00',
  },
  maintenance_reminder: {
    messageTemplate: 'It\'s time for your scheduled maintenance. Would you like to book an appointment?',
    callWindowStart: '09:00',
    callWindowEnd: '17:00',
  },
  review_request: {
    messageTemplate: 'Thank you for choosing us. We\'d love to hear your feedback.',
    callWindowStart: '10:00',
    callWindowEnd: '18:00',
  },
  reactivation: {
    messageTemplate: 'We haven\'t heard from you in a while. We\'d love to help you again.',
    callWindowStart: '10:00',
    callWindowEnd: '17:00',
  },
  recall: {
    messageTemplate: 'It\'s time for your regular checkup. Would you like to schedule an appointment?',
    callWindowStart: '09:00',
    callWindowEnd: '17:00',
  },
  lease_renewal: {
    messageTemplate: 'Your lease is coming up for renewal. Let\'s discuss your options.',
    callWindowStart: '09:00',
    callWindowEnd: '17:00',
  },
  custom: {
    messageTemplate: '',
    callWindowStart: '09:00',
    callWindowEnd: '18:00',
  },
};

export class WorkforceOutboundService {
  async createTask(
    tenantId: string,
    teamId: string,
    params: {
      campaignType: OutboundCampaignType;
      name: string;
      config?: Record<string, unknown>;
      scheduledAt?: string;
      createdBy?: string;
    },
  ): Promise<WorkforceOutboundTask> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      return await withTenantContext(client, tenantId, async () => {
        const defaults = CAMPAIGN_TYPE_DEFAULTS[params.campaignType] ?? CAMPAIGN_TYPE_DEFAULTS.custom;
        const config = { ...defaults, ...params.config };

        const { rows } = await client.query(
          `INSERT INTO workforce_outbound_tasks
           (tenant_id, team_id, campaign_type, name, config, scheduled_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            tenantId, teamId, params.campaignType, params.name,
            JSON.stringify(config), params.scheduledAt ?? null, params.createdBy ?? null,
          ],
        );

        logger.info('Workforce outbound task created', {
          tenantId, teamId, taskId: rows[0].id, campaignType: params.campaignType,
        });

        return mapTaskRow(rows[0]);
      });
    } finally {
      client.release();
    }
  }

  async launchTask(
    tenantId: string,
    taskId: string,
    params: {
      agentId: string;
      contacts: Array<{ phoneNumber: string; name?: string }>;
    },
  ): Promise<WorkforceOutboundTask> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      const task = await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT * FROM workforce_outbound_tasks WHERE id = $1 AND tenant_id = $2`,
          [taskId, tenantId],
        );
        return rows[0] ? mapTaskRow(rows[0]) : null;
      });

      if (!task) {
        throw new Error('Outbound task not found');
      }

      if (task.status !== 'draft') {
        throw new Error(`Cannot launch task in status '${task.status}', must be 'draft'`);
      }

      const campaignType = CAMPAIGN_TYPE_MAP[task.campaignType] ?? 'outbound_call';
      const taskConfig = task.config as Record<string, unknown>;

      const campaign = await createCampaign({
        tenantId,
        agentId: params.agentId,
        name: `[Workforce] ${task.name}`,
        type: campaignType,
        config: {
          callWindowStart: (taskConfig.callWindowStart as string) ?? '09:00',
          callWindowEnd: (taskConfig.callWindowEnd as string) ?? '17:00',
          maxConcurrentCalls: 2,
          maxRetries: 1,
          workforceMeta: {
            workforceTaskId: taskId,
            teamId: task.teamId,
            campaignType: task.campaignType,
          },
        },
        scheduledAt: task.scheduledAt ? new Date(task.scheduledAt) : undefined,
      });

      if (params.contacts.length > 0) {
        await addContacts(tenantId, campaign.id, params.contacts.map((c) => ({
          phoneNumber: c.phoneNumber,
          name: c.name ?? null,
        })));
      }

      await updateCampaign(tenantId, campaign.id, { status: 'running' });

      const updated = await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `UPDATE workforce_outbound_tasks
           SET status = 'running', campaign_id = $3, total_contacts = $4,
               started_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2
           RETURNING *`,
          [taskId, tenantId, campaign.id, params.contacts.length],
        );
        return rows[0] ? mapTaskRow(rows[0]) : null;
      });

      logger.info('Workforce outbound task launched via CampaignScheduler', {
        tenantId, taskId, campaignId: campaign.id, contactCount: params.contacts.length,
      });

      return updated!;
    } finally {
      client.release();
    }
  }

  async syncTaskFromCampaign(
    tenantId: string,
    taskId: string,
  ): Promise<WorkforceOutboundTask | null> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      const task = await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT * FROM workforce_outbound_tasks WHERE id = $1 AND tenant_id = $2`,
          [taskId, tenantId],
        );
        return rows[0] ? mapTaskRow(rows[0]) : null;
      });

      if (!task || !task.campaignId) return task;

      const { rows: campaignRows } = await client.query(
        `SELECT status, (SELECT COUNT(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status IN ('completed', 'failed')) AS reached
         FROM campaigns c WHERE c.id = $1 AND c.tenant_id = $2`,
        [task.campaignId, tenantId],
      );

      if (campaignRows.length === 0) return task;

      const campaignStatus = campaignRows[0].status as string;
      const reached = (campaignRows[0].reached as number) ?? 0;

      let taskStatus = task.status;
      if (campaignStatus === 'completed') taskStatus = 'completed';
      else if (campaignStatus === 'paused') taskStatus = 'paused';
      else if (campaignStatus === 'cancelled') taskStatus = 'cancelled';

      return await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `UPDATE workforce_outbound_tasks
           SET status = $3, contacts_reached = $4,
               completed_at = CASE WHEN $3 IN ('completed', 'cancelled') THEN NOW() ELSE completed_at END,
               updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2
           RETURNING *`,
          [taskId, tenantId, taskStatus, reached],
        );
        return rows[0] ? mapTaskRow(rows[0]) : null;
      });
    } finally {
      client.release();
    }
  }

  async listTasks(
    tenantId: string,
    teamId: string,
    options: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<{ tasks: WorkforceOutboundTask[]; total: number }> {
    const pool = getPlatformPool();
    const client = await pool.connect();
    const limit = Math.min(options.limit ?? 20, 100);
    const offset = options.offset ?? 0;

    try {
      return await withTenantContext(client, tenantId, async () => {
        const conditions = ['tenant_id = $1', 'team_id = $2'];
        const params: unknown[] = [tenantId, teamId];
        let paramIdx = 3;

        if (options.status) {
          conditions.push(`status = $${paramIdx}`);
          params.push(options.status);
          paramIdx++;
        }

        const where = conditions.join(' AND ');

        const { rows: countRows } = await client.query(
          `SELECT COUNT(*)::int AS total FROM workforce_outbound_tasks WHERE ${where}`,
          params,
        );

        const { rows } = await client.query(
          `SELECT * FROM workforce_outbound_tasks WHERE ${where}
           ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
          [...params, limit, offset],
        );

        return {
          tasks: rows.map(mapTaskRow),
          total: countRows[0]?.total ?? 0,
        };
      });
    } finally {
      client.release();
    }
  }

  async getTask(tenantId: string, taskId: string): Promise<WorkforceOutboundTask | null> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      return await withTenantContext(client, tenantId, async () => {
        const { rows } = await client.query(
          `SELECT * FROM workforce_outbound_tasks WHERE id = $1 AND tenant_id = $2`,
          [taskId, tenantId],
        );
        return rows[0] ? mapTaskRow(rows[0]) : null;
      });
    } finally {
      client.release();
    }
  }

  async updateTaskStatus(
    tenantId: string,
    taskId: string,
    status: string,
    extra?: { campaignId?: string; totalContacts?: number; contactsReached?: number },
  ): Promise<WorkforceOutboundTask | null> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      return await withTenantContext(client, tenantId, async () => {
        const sets = ['status = $3', 'updated_at = NOW()'];
        const params: unknown[] = [taskId, tenantId, status];

        if (status === 'running') {
          sets.push('started_at = COALESCE(started_at, NOW())');
        }
        if (status === 'completed' || status === 'cancelled') {
          sets.push('completed_at = NOW()');
        }
        if (extra?.campaignId) {
          params.push(extra.campaignId);
          sets.push(`campaign_id = $${params.length}`);
        }
        if (extra?.totalContacts !== undefined) {
          params.push(extra.totalContacts);
          sets.push(`total_contacts = $${params.length}`);
        }
        if (extra?.contactsReached !== undefined) {
          params.push(extra.contactsReached);
          sets.push(`contacts_reached = $${params.length}`);
        }

        const { rows } = await client.query(
          `UPDATE workforce_outbound_tasks SET ${sets.join(', ')}
           WHERE id = $1 AND tenant_id = $2
           RETURNING *`,
          params,
        );
        return rows[0] ? mapTaskRow(rows[0]) : null;
      });
    } finally {
      client.release();
    }
  }

  async deleteTask(tenantId: string, taskId: string): Promise<boolean> {
    const pool = getPlatformPool();
    const client = await pool.connect();

    try {
      return await withTenantContext(client, tenantId, async () => {
        const { rowCount } = await client.query(
          `DELETE FROM workforce_outbound_tasks
           WHERE id = $1 AND tenant_id = $2 AND status IN ('draft', 'cancelled')`,
          [taskId, tenantId],
        );
        return (rowCount ?? 0) > 0;
      });
    } finally {
      client.release();
    }
  }
}
