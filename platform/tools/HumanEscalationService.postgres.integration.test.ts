// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createScratchDatabase, probePostgres, type ScratchDatabase } from './testing/scratchPostgres';
import { ESCALATION_EMAIL_RECIPIENTS_SQL, ESCALATION_ROSTER_SQL } from './HumanEscalationService';

const dbReachable = await probePostgres();

describe.skipIf(!dbReachable)('escalation recipient queries against real Postgres', () => {
  let db: ScratchDatabase;
  let tenantId: string;

  async function insertUser(email: string, role: string, opts: { active?: boolean; rbac?: string[] } = {}): Promise<string> {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO users (id, tenant_id, email, role, is_active, first_name, last_name) VALUES ($1, $2, $3, $4, $5, 'Test', 'User')`,
      [id, tenantId, email, role, opts.active ?? true],
    );
    for (const rbacRole of opts.rbac ?? []) {
      await db.admin.query(`INSERT INTO user_roles (user_id, tenant_id, role) VALUES ($1, $2, $3)`, [id, tenantId, rbacRole]);
    }
    return id;
  }

  beforeAll(async () => {
    db = await createScratchDatabase('qvo_callfix_escalation');
    tenantId = randomUUID();
    await db.admin.query(`INSERT INTO tenants (id, name, slug, status) VALUES ($1, 'Shop', $2, 'active')`, [tenantId, `shop-${tenantId.slice(0, 8)}`]);
    await insertUser('zed.admin@example.test', 'admin');
    await insertUser('bea.owner@example.test', 'owner');
    // Two RBAC rows → two join rows; DISTINCT must collapse them.
    await insertUser('Cal.Ops@example.test', 'member', { rbac: ['tenant_owner', 'operations_manager'] });
    await insertUser('amy.member@example.test', 'member');
    await insertUser('old.admin@example.test', 'admin', { active: false });
  }, 600_000);

  afterAll(async () => {
    await db?.drop();
  }, 60_000);

  it('runs the escalation email query: owners first, then by email, no duplicates', async () => {
    const { rows } = await db.admin.query(ESCALATION_EMAIL_RECIPIENTS_SQL, [tenantId]);
    expect(rows.map((r) => r.email)).toEqual([
      'bea.owner@example.test',
      'Cal.Ops@example.test',
      'zed.admin@example.test',
    ]);
  });

  it('runs the roster query with the RBAC role and preference columns', async () => {
    const { rows } = await db.admin.query(ESCALATION_ROSTER_SQL, [tenantId]);
    expect(rows.map((r) => [r.email, r.rbac_role])).toEqual([
      ['bea.owner@example.test', null],
      ['Cal.Ops@example.test', 'tenant_owner'],
      ['zed.admin@example.test', null],
    ]);
    expect(rows.every((r) => r.in_app_enabled === true && r.email_enabled === true)).toBe(true);
  });

  it('runs both queries under RLS as the restricted role', async () => {
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const email = await client.query(ESCALATION_EMAIL_RECIPIENTS_SQL, [tenantId]);
      const roster = await client.query(ESCALATION_ROSTER_SQL, [tenantId]);
      expect(email.rows).toHaveLength(3);
      expect(roster.rows).toHaveLength(3);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
