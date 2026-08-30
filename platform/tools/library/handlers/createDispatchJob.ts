import { createLogger } from '../../../core/logger';
import { getPlatformPool, withTenantContext } from '../../../db';
import type { ToolContext, ToolDefinition } from '../../registry/types';
import { getToolLibraryEntry } from '../catalog';

const logger = createLogger('TOOL_CREATE_DISPATCH_JOB');

export async function executeCreateDispatchJob(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<{ success: boolean; message: string; jobId?: string }> {
  const title = String(input.title ?? '').trim();
  const description = String(input.description ?? '').trim();
  const contactName = String(input.contactName ?? '').trim();
  const contactPhone = String(input.contactPhone ?? '').trim();
  if (!title || !description || !contactName || !contactPhone) {
    return { success: false, message: 'title, description, contactName, and contactPhone are required.' };
  }

  const scheduledAt = input.scheduledAt ? new Date(String(input.scheduledAt)) : null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    return { success: false, message: 'scheduledAt must be a valid ISO-8601 timestamp.' };
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let jobId: string | undefined;
    await withTenantContext(client, context.tenantId, async () => {
      const { rows } = await client.query(
        `INSERT INTO dispatch_jobs (tenant_id, title, description, status, priority,
            contact_name, contact_phone, contact_email, address, scheduled_at, job_type, notes, metadata)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         RETURNING id`,
        [
          context.tenantId,
          title,
          description,
          String(input.priority ?? 'medium'),
          contactName,
          contactPhone,
          String(input.contactEmail ?? ''),
          String(input.address ?? ''),
          scheduledAt ? scheduledAt.toISOString() : null,
          String(input.jobType ?? 'general'),
          String(input.description),
          JSON.stringify({ source: 'voice-library', callSid: context.callSid ?? null }),
        ],
      );
      jobId = rows[0]?.id as string;
      await client.query(
        `INSERT INTO dispatch_job_events (job_id, tenant_id, event_type, to_status, performed_by, notes)
         VALUES ($1, $2, 'created', 'pending', NULL, 'Job created by voice agent tool library')`,
        [jobId, context.tenantId],
      );
    });
    await client.query('COMMIT');
    return {
      success: true,
      message: 'Dispatch job created as pending. A technician is not assigned until staff or routing acts.',
      jobId,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('create_dispatch_job failed', { tenantId: context.tenantId, error: String(err) });
    return { success: false, message: 'Failed to create the dispatch job. Offer to try again or escalate.' };
  } finally {
    client.release();
  }
}

const entry = getToolLibraryEntry('create_dispatch_job')!;

export const createDispatchJobTool: ToolDefinition = {
  name: entry.name,
  description: entry.description,
  inputSchema: entry.parameters,
  handler: (input, context) => executeCreateDispatchJob(input as Record<string, unknown>, context),
};
