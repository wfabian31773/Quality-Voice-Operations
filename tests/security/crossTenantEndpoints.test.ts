/**
 * Cross-tenant HTTP isolation tests.
 *
 * For each high-value resource family (agents, calls, phone numbers,
 * tickets, bookings, dispatch jobs, SMS conversations) we:
 *  1. Seed two tenants with one user each (using a privileged client to
 *     bypass RLS).
 *  2. Insert one resource in each tenant.
 *  3. Sign a real JWT for tenant-A's user and call the live express app
 *     via supertest.
 *  4. Assert that tenant A's listing only returns its own resource and
 *     that tenant A cannot read tenant B's resource by ID.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

const USER_A = { id: randomUUID(), email: `user-a-${Date.now()}@x-tenant-test.local` };
const USER_B = { id: randomUUID(), email: `user-b-${Date.now()}@x-tenant-test.local` };

interface SeededIds {
  agentA: string;
  agentB: string;
  callA: string;
  callB: string;
  phoneA: string;
  phoneB: string;
  ticketA: string;
  ticketB: string;
  bookingA: string;
  bookingB: string;
  dispatchA: string;
  dispatchB: string;
  smsA: string;
  smsB: string;
}

let app: import('express').Express;
let issueToken: typeof import('../../server/admin-api/middleware/auth').issueToken;
let withPrivilegedClient: typeof import('../../platform/db').withPrivilegedClient;
let getPlatformPool: typeof import('../../platform/db').getPlatformPool;
let seeded: SeededIds;
let tokenA: string;

async function seedTenant(opts: { tenantId: string; user: { id: string; email: string } }) {
  await withPrivilegedClient(async (client) => {
    await client.query(
      `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [opts.tenantId, `XTest ${opts.tenantId.slice(0, 8)}`, `xtest-${opts.tenantId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO users (id, tenant_id, email, role, is_active, email_verified)
       VALUES ($1, $2, $3, 'tenant_owner', true, true)
       ON CONFLICT (id) DO NOTHING`,
      [opts.user.id, opts.tenantId, opts.user.email],
    );
    await client.query(
      `INSERT INTO user_roles (user_id, tenant_id, role) VALUES ($1, $2, 'tenant_owner')
       ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
      [opts.user.id, opts.tenantId],
    );
  });
}

async function seedResources(tenantId: string): Promise<Record<string, string>> {
  const ids = {
    agent: randomUUID(),
    call: randomUUID(),
    phone: randomUUID(),
    ticket: randomUUID(),
    booking: randomUUID(),
    dispatch: randomUUID(),
    sms: randomUUID(),
  };
  await withPrivilegedClient(async (client) => {
    await client.query(
      `INSERT INTO agents (id, tenant_id, name, type, status) VALUES ($1, $2, $3, 'general', 'active')`,
      [ids.agent, tenantId, `XTest agent ${tenantId.slice(0, 6)}`],
    );
    await client.query(
      `INSERT INTO call_sessions (id, tenant_id, direction, lifecycle_state)
       VALUES ($1, $2, 'inbound', 'CALL_RECEIVED')`,
      [ids.call, tenantId],
    );
    await client.query(
      `INSERT INTO phone_numbers (id, tenant_id, phone_number, status)
       VALUES ($1, $2, $3, 'active')`,
      [ids.phone, tenantId, `+1${Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000}`],
    );
    await client.query(
      `INSERT INTO tickets (id, tenant_id, subject, status) VALUES ($1, $2, 'XTest ticket', 'open')`,
      [ids.ticket, tenantId],
    );
    await client.query(
      `INSERT INTO bookings (id, tenant_id, title, start_time, end_time, status)
       VALUES ($1, $2, 'XTest booking', now(), now() + interval '1 hour', 'confirmed')`,
      [ids.booking, tenantId],
    );
    await client.query(
      `INSERT INTO dispatch_jobs (id, tenant_id, title, status, priority)
       VALUES ($1, $2, 'XTest job', 'pending', 'medium')`,
      [ids.dispatch, tenantId],
    );
    await client.query(
      `INSERT INTO sms_conversations (id, tenant_id, phone_number_id, remote_number, status)
       VALUES ($1, $2, $3, $4, 'open')`,
      [ids.sms, tenantId, ids.phone, '+15555550100'],
    );
  });
  return ids;
}

async function cleanup() {
  await withPrivilegedClient(async (client) => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await client.query(`DELETE FROM sms_conversations WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM dispatch_jobs WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM bookings WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM tickets WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM phone_numbers WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM call_sessions WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM agents WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM user_roles WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });
}

describe('HTTP cross-tenant isolation', () => {
  beforeAll(async () => {
    process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'qvo-xtest-secret';
    const dbMod = await import('../../platform/db');
    withPrivilegedClient = dbMod.withPrivilegedClient;
    getPlatformPool = dbMod.getPlatformPool;
    const auth = await import('../../server/admin-api/middleware/auth');
    issueToken = auth.issueToken;
    app = (await import('../../server/admin-api/app')).default;

    await seedTenant({ tenantId: TENANT_A, user: USER_A });
    await seedTenant({ tenantId: TENANT_B, user: USER_B });
    const a = await seedResources(TENANT_A);
    const b = await seedResources(TENANT_B);
    seeded = {
      agentA: a.agent, agentB: b.agent,
      callA: a.call, callB: b.call,
      phoneA: a.phone, phoneB: b.phone,
      ticketA: a.ticket, ticketB: b.ticket,
      bookingA: a.booking, bookingB: b.booking,
      dispatchA: a.dispatch, dispatchB: b.dispatch,
      smsA: a.sms, smsB: b.sms,
    };

    tokenA = issueToken({
      userId: USER_A.id,
      tenantId: TENANT_A,
      email: USER_A.email,
      role: 'tenant_owner',
      isPlatformAdmin: false,
    });
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    const pool = getPlatformPool();
    if (typeof (pool as { end?: () => Promise<void> }).end === 'function') {
      await (pool as { end: () => Promise<void> }).end().catch(() => {});
    }
  });

  describe('Listing endpoints exclude foreign tenants', () => {
    const cases: Array<{ name: string; path: string; ownIdKey: keyof SeededIds; foreignIdKey: keyof SeededIds; idsField?: string }> = [
      { name: 'GET /agents', path: '/agents', ownIdKey: 'agentA', foreignIdKey: 'agentB' },
      { name: 'GET /calls', path: '/calls', ownIdKey: 'callA', foreignIdKey: 'callB' },
      { name: 'GET /phone-numbers', path: '/phone-numbers', ownIdKey: 'phoneA', foreignIdKey: 'phoneB' },
      { name: 'GET /tickets', path: '/tickets', ownIdKey: 'ticketA', foreignIdKey: 'ticketB' },
      { name: 'GET /scheduling/bookings', path: '/scheduling/bookings', ownIdKey: 'bookingA', foreignIdKey: 'bookingB' },
      { name: 'GET /dispatch/jobs', path: '/dispatch/jobs', ownIdKey: 'dispatchA', foreignIdKey: 'dispatchB' },
      { name: 'GET /sms-inbox/threads', path: '/sms-inbox/threads', ownIdKey: 'smsA', foreignIdKey: 'smsB' },
    ];
    for (const c of cases) {
      it(`${c.name} only returns tenant A resources`, async () => {
        const res = await request(app)
          .get(c.path)
          .set('Authorization', `Bearer ${tokenA}`);

        expect(res.status, `${c.path} returned ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);

        const body = res.body as Record<string, unknown>;
        const candidateArrays = [body.items, body.data, body.results, body.rows, body];
        const list = candidateArrays.find((v) => Array.isArray(v)) as unknown[] | undefined;
        const arr = (list ?? []) as Array<Record<string, unknown>>;
        const flatString = JSON.stringify(arr);

        expect(flatString, `tenant B id (${seeded[c.foreignIdKey]}) should not appear in ${c.path} for tenant A`).not.toContain(seeded[c.foreignIdKey]);
      });
    }
  });

  describe('Detail endpoints reject foreign-tenant IDs', () => {
    const cases: Array<{ name: string; path: (id: string) => string; foreignKey: keyof SeededIds }> = [
      { name: 'GET /agents/:id', path: (id) => `/agents/${id}`, foreignKey: 'agentB' },
      { name: 'GET /calls/:id', path: (id) => `/calls/${id}`, foreignKey: 'callB' },
      { name: 'GET /tickets/:id', path: (id) => `/tickets/${id}`, foreignKey: 'ticketB' },
      { name: 'GET /scheduling/bookings/:id', path: (id) => `/scheduling/bookings/${id}`, foreignKey: 'bookingB' },
      { name: 'GET /dispatch/jobs/:id', path: (id) => `/dispatch/jobs/${id}`, foreignKey: 'dispatchB' },
      { name: 'GET /sms-inbox/threads/:id', path: (id) => `/sms-inbox/threads/${id}`, foreignKey: 'smsB' },
    ];
    for (const c of cases) {
      it(`${c.name} returns 404/403 when fetching tenant B's id`, async () => {
        const id = seeded[c.foreignKey];
        const res = await request(app)
          .get(c.path(id))
          .set('Authorization', `Bearer ${tokenA}`);

        expect([403, 404]).toContain(res.status);
        const body = JSON.stringify(res.body);
        expect(body).not.toContain(`"id":"${id}"`);
      });
    }
  });

  describe('TenantGuard rejects body/query tenant overrides', () => {
    it('rejects ?tenantId=<other> on a tenant route', async () => {
      const res = await request(app)
        .get(`/agents?tenantId=${TENANT_B}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Platform admin endpoints reject non-admin tenant users', () => {
    const platformPaths = [
      '/platform/stats',
      '/platform/tenants',
      '/platform/cost-monitoring',
      '/platform/template-analytics',
      '/platform/marketplace/submissions',
      '/platform/marketplace/revenue',
    ];
    for (const p of platformPaths) {
      it(`tenant_owner gets 403 from ${p}`, async () => {
        const res = await request(app)
          .get(p)
          .set('Authorization', `Bearer ${tokenA}`);
        expect(res.status, `${p} returned ${res.status}`).toBe(403);
      });
    }
  });
});
