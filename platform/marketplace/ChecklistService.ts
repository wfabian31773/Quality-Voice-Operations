import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';

const logger = createLogger('CHECKLIST_SERVICE');

export interface ChecklistStep {
  key: string;
  label: string;
  description: string;
  completed: boolean;
  completedAt: string | null;
  link: string;
  order: number;
}

export interface ChecklistState {
  steps: ChecklistStep[];
  completedCount: number;
  totalCount: number;
  allComplete: boolean;
}

const CHECKLIST_STEPS: Omit<ChecklistStep, 'completed' | 'completedAt'>[] = [
  { key: 'assign_phone', label: 'Assign Phone Number', description: 'Link a phone number to your agent so it can receive calls', link: '/phone-numbers', order: 1 },
  { key: 'enable_widget', label: 'Enable Web Widget', description: 'Set up a chat/voice widget for your website', link: '/widget', order: 2 },
  { key: 'attach_knowledge', label: 'Attach Knowledge Base', description: 'Add knowledge base articles to help your agent answer questions', link: '/knowledge-base', order: 3 },
  { key: 'customize_greeting', label: 'Customize Greeting', description: 'Personalize the greeting message your agent uses', link: '', order: 4 },
  { key: 'test_call', label: 'Run Test Call', description: 'Make a test call to verify your agent is working correctly', link: '/calls', order: 5 },
  { key: 'publish_agent', label: 'Publish Agent', description: 'Set your agent to active and start handling real calls', link: '', order: 6 },
];

export async function getChecklistState(
  tenantId: TenantId,
  installationId: string,
): Promise<ChecklistState | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, checklist_state, agent_id
       FROM tenant_agent_installations
       WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
      [installationId, tenantId],
    );

    await client.query('COMMIT');

    if (rows.length === 0) return null;

    const savedState = (rows[0].checklist_state as Record<string, { completed: boolean; completedAt: string | null }>) ?? {};

    const steps: ChecklistStep[] = CHECKLIST_STEPS.map((step) => {
      const saved = savedState[step.key];
      return {
        ...step,
        completed: saved?.completed ?? false,
        completedAt: saved?.completedAt ?? null,
      };
    });

    const completedCount = steps.filter((s) => s.completed).length;

    return {
      steps,
      completedCount,
      totalCount: steps.length,
      allComplete: completedCount === steps.length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to get checklist state', { tenantId, installationId, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

export async function markStepComplete(
  tenantId: TenantId,
  installationId: string,
  stepKey: string,
): Promise<{ success: boolean; error?: string; checklist?: ChecklistState }> {
  const validKeys = new Set(CHECKLIST_STEPS.map((s) => s.key));
  if (!validKeys.has(stepKey)) {
    return { success: false, error: `Invalid step key: ${stepKey}` };
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, checklist_state
       FROM tenant_agent_installations
       WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
      [installationId, tenantId],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return { success: false, error: 'Installation not found' };
    }

    const savedState = (rows[0].checklist_state as Record<string, { completed: boolean; completedAt: string | null }>) ?? {};
    savedState[stepKey] = { completed: true, completedAt: new Date().toISOString() };

    await client.query(
      `UPDATE tenant_agent_installations SET checklist_state = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(savedState), installationId, tenantId],
    );

    await client.query('COMMIT');

    const checklist = await getChecklistState(tenantId, installationId);
    return { success: true, checklist: checklist! };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to mark step complete', { tenantId, installationId, stepKey, error: String(err) });
    return { success: false, error: 'Failed to update checklist' };
  } finally {
    client.release();
  }
}

export async function markStepIncomplete(
  tenantId: TenantId,
  installationId: string,
  stepKey: string,
): Promise<{ success: boolean; error?: string; checklist?: ChecklistState }> {
  const validKeys = new Set(CHECKLIST_STEPS.map((s) => s.key));
  if (!validKeys.has(stepKey)) {
    return { success: false, error: `Invalid step key: ${stepKey}` };
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT id, checklist_state
       FROM tenant_agent_installations
       WHERE id = $1 AND tenant_id = $2 AND status = 'active'`,
      [installationId, tenantId],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return { success: false, error: 'Installation not found' };
    }

    const savedState = (rows[0].checklist_state as Record<string, { completed: boolean; completedAt: string | null }>) ?? {};
    savedState[stepKey] = { completed: false, completedAt: null };

    await client.query(
      `UPDATE tenant_agent_installations SET checklist_state = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(savedState), installationId, tenantId],
    );

    await client.query('COMMIT');

    const checklist = await getChecklistState(tenantId, installationId);
    return { success: true, checklist: checklist! };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to mark step incomplete', { tenantId, installationId, stepKey, error: String(err) });
    return { success: false, error: 'Failed to update checklist' };
  } finally {
    client.release();
  }
}
