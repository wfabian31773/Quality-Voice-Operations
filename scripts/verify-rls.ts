/**
 * RLS Cross-Tenant Isolation Verification Script
 *
 * Verifies both SELECT (USING) and INSERT (WITH CHECK) RLS enforcement.
 * Covers: agents, tenants, phone_numbers, call_sessions, outbox_events, billing_events
 *
 * Uses platform_rls_tester role (no BYPASSRLS) so policies are enforced.
 * Requires PLATFORM_DB_POOL_URL to be set.
 *
 * RLS design note: policies use current_setting('app.tenant_id') because this
 * platform connects to Supabase as a server-side Node.js process via the transaction
 * pooler — not via client SDK. The middleware sets app.tenant_id per transaction
 * via withTenantContext() before any tenant-scoped query.
 */
import { Pool } from 'pg';

const TENANT_A = 'rls-test-tenant-a';
const TENANT_B = 'rls-test-tenant-b';

async function main() {
  const url = process.env.PLATFORM_DB_POOL_URL;
  if (!url) throw new Error('[VERIFY-RLS] PLATFORM_DB_POOL_URL is not set');

  const pool = new Pool({ connectionString: url, max: 3, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string) {
    if (condition) { console.log(`  PASS: ${label}`); passed++; }
    else { console.error(`  FAIL: ${label}`); failed++; }
  }

  try {
    await client.query('BEGIN');

    console.log('[VERIFY-RLS] Seeding test fixtures (superuser context)...');
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan)
       VALUES ('${TENANT_A}', 'RLS Test A', 'rls-test-a', 'active', 'starter'),
              ('${TENANT_B}', 'RLS Test B', 'rls-test-b', 'active', 'starter')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO agents (id, tenant_id, name, type, status)
       VALUES ('agent-rls-a', '${TENANT_A}', 'RLS Agent A', 'general', 'active'),
              ('agent-rls-b', '${TENANT_B}', 'RLS Agent B', 'general', 'active')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO phone_numbers (id, tenant_id, phone_number, status)
       VALUES ('phone-rls-a', '${TENANT_A}', '+15550001111', 'active'),
              ('phone-rls-b', '${TENANT_B}', '+15550002222', 'active')
       ON CONFLICT (tenant_id, phone_number) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO call_sessions (id, tenant_id, agent_id, direction)
       VALUES ('session-rls-a', '${TENANT_A}', 'agent-rls-a', 'inbound'),
              ('session-rls-b', '${TENANT_B}', 'agent-rls-b', 'inbound')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO outbox_events (id, tenant_id, idempotency_key, event_type, payload)
       VALUES ('outbox-rls-a', '${TENANT_A}', 'key-rls-a', 'test.event', '{}'),
              ('outbox-rls-b', '${TENANT_B}', 'key-rls-b', 'test.event', '{}')
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO billing_events (id, tenant_id, event_type, amount_cents)
       VALUES ('billing-rls-a', '${TENANT_A}', 'invoice_paid', 100),
              ('billing-rls-b', '${TENANT_B}', 'invoice_paid', 200)
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, role)
       VALUES ('user-rls-a', '${TENANT_A}', 'rls-a@test.example', 'user'),
              ('user-rls-b', '${TENANT_B}', 'rls-b@test.example', 'user')
       ON CONFLICT (email) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO user_roles (id, user_id, tenant_id, role)
       VALUES ('role-rls-a', 'user-rls-a', '${TENANT_A}', 'support_reviewer'),
              ('role-rls-b', 'user-rls-b', '${TENANT_B}', 'support_reviewer')
       ON CONFLICT (id) DO NOTHING`,
    );

    console.log('[VERIFY-RLS] Switching to platform_rls_tester role (RLS enforced)...');
    await client.query(`SET LOCAL ROLE platform_rls_tester`);

    const selectTests: Array<{ name: string; idA: string; idB: string; query: string }> = [
      {
        name: 'user_roles',
        idA: 'role-rls-a', idB: 'role-rls-b',
        query: "SELECT id FROM user_roles WHERE id IN ('role-rls-a','role-rls-b')",
      },
      {
        name: 'agents',
        idA: 'agent-rls-a', idB: 'agent-rls-b',
        query: "SELECT id FROM agents WHERE id IN ('agent-rls-a','agent-rls-b')",
      },
      {
        name: 'tenants',
        idA: TENANT_A, idB: TENANT_B,
        query: `SELECT id FROM tenants WHERE id IN ('${TENANT_A}','${TENANT_B}')`,
      },
      {
        name: 'phone_numbers',
        idA: 'phone-rls-a', idB: 'phone-rls-b',
        query: "SELECT id FROM phone_numbers WHERE id IN ('phone-rls-a','phone-rls-b')",
      },
      {
        name: 'call_sessions',
        idA: 'session-rls-a', idB: 'session-rls-b',
        query: "SELECT id FROM call_sessions WHERE id IN ('session-rls-a','session-rls-b')",
      },
      {
        name: 'outbox_events',
        idA: 'outbox-rls-a', idB: 'outbox-rls-b',
        query: "SELECT id FROM outbox_events WHERE id IN ('outbox-rls-a','outbox-rls-b')",
      },
      {
        name: 'billing_events',
        idA: 'billing-rls-a', idB: 'billing-rls-b',
        query: "SELECT id FROM billing_events WHERE id IN ('billing-rls-a','billing-rls-b')",
      },
    ];

    console.log('\n[VERIFY-RLS] ── SELECT isolation tests ──');
    for (const t of selectTests) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      const { rows: rowsA } = await client.query(t.query);
      assert(rowsA.length === 1, `${t.name}: Tenant A sees only its own row`);
      assert(rowsA[0]?.id === t.idA, `${t.name}: Tenant A correct row id`);

      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
      const { rows: rowsB } = await client.query(t.query);
      assert(rowsB.length === 1, `${t.name}: Tenant B sees only its own row`);
      assert(rowsB[0]?.id === t.idB, `${t.name}: Tenant B denied Tenant A rows`);

      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, ['']);
      const { rows: rowsNone } = await client.query(t.query);
      assert(rowsNone.length === 0, `${t.name}: Empty context = 0 rows`);
    }

    console.log('\n[VERIFY-RLS] ── INSERT (WITH CHECK) isolation tests ──');

    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    let insertBlocked = false;
    await client.query('SAVEPOINT sp_cross');
    try {
      await client.query(
        `INSERT INTO agents (id, tenant_id, name, type, status)
         VALUES ('agent-cross-check', '${TENANT_B}', 'Cross Tenant', 'general', 'active')`,
      );
      await client.query('RELEASE SAVEPOINT sp_cross');
    } catch (e: unknown) {
      await client.query('ROLLBACK TO SAVEPOINT sp_cross');
      insertBlocked = (e as { code?: string }).code === '42501';
    }
    assert(insertBlocked, 'agents: INSERT with wrong tenant_id is blocked by WITH CHECK');

    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    let insertAllowed = false;
    await client.query('SAVEPOINT sp_own');
    try {
      await client.query(
        `INSERT INTO agents (id, tenant_id, name, type, status)
         VALUES ('agent-own-check', '${TENANT_A}', 'Own Tenant Insert', 'general', 'active')`,
      );
      await client.query('RELEASE SAVEPOINT sp_own');
      insertAllowed = true;
    } catch (_e) {
      await client.query('ROLLBACK TO SAVEPOINT sp_own');
      insertAllowed = false;
    }
    assert(insertAllowed, 'agents: INSERT with correct tenant_id is allowed');

    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    let outboxBlocked = false;
    await client.query('SAVEPOINT sp_outbox');
    try {
      await client.query(
        `INSERT INTO outbox_events (id, tenant_id, idempotency_key, event_type, payload)
         VALUES ('outbox-cross-check', '${TENANT_B}', 'key-cross', 'test', '{}')`,
      );
      await client.query('RELEASE SAVEPOINT sp_outbox');
    } catch (e: unknown) {
      await client.query('ROLLBACK TO SAVEPOINT sp_outbox');
      outboxBlocked = (e as { code?: string }).code === '42501';
    }
    assert(outboxBlocked, 'outbox_events: INSERT with wrong tenant_id is blocked by WITH CHECK');

    await client.query('ROLLBACK');
    console.log(`\n[VERIFY-RLS] Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error('[VERIFY-RLS] CRITICAL: RLS isolation is NOT working correctly!');
      process.exit(1);
    } else {
      console.log('[VERIFY-RLS] All SELECT + INSERT isolation checks passed.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[VERIFY-RLS] Test error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
