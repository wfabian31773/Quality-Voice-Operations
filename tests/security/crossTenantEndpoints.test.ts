/**
 * Cross-tenant HTTP isolation tests.
 *
 * For each tenant-scoped resource family we:
 *  1. Seed two tenants with one user each (using a privileged client to
 *     bypass RLS).
 *  2. Insert one resource in each tenant.
 *  3. Sign a real JWT for tenant-A's user and call the live express app
 *     via supertest.
 *  4. Assert that tenant A's listing only returns its own resource and
 *     that tenant A cannot read, mutate, or delete tenant B's resource by ID.
 *
 * Coverage tracked here corresponds to the BL-026 / D-20 audit items:
 * agents, calls, phone numbers, tickets, scheduling/bookings, dispatch,
 * sms-inbox, autopilot (recommendations + insights + actions, including
 * approve / reject / execute / dismiss / rollback mutations), digital-twin
 * (models + scenarios + runs + forecasts), evolution (platform-admin only),
 * insights (currently served via /autopilot/insights — the bare /insights/*
 * tree is reserved by a regression guard below), improvements, case-studies,
 * widget tokens, knowledge documents, tool executions/replay, marketplace
 * installations (customize / generic update / checklist / customization
 * schema), and the reserved /workforce/* family (regression-guarded until it
 * is exposed on admin-api).
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
  autopilotRecA: string;
  autopilotRecB: string;
  autopilotInsightA: string;
  autopilotInsightB: string;
  autopilotActionA: string;
  autopilotActionB: string;
  dtModelA: string;
  dtModelB: string;
  dtScenarioA: string;
  dtScenarioB: string;
  dtRunA: string;
  dtRunB: string;
  forecastA: string;
  forecastB: string;
  improvementA: string;
  improvementB: string;
  caseStudyA: string;
  caseStudyB: string;
  widgetTokenA: string;
  widgetTokenB: string;
  kbDocA: string;
  kbDocB: string;
  toolInvA: string;
  toolInvB: string;
  installationA: string;
  installationB: string;
}

let app: import('express').Express;
let issueToken: typeof import('../../server/admin-api/middleware/auth').issueToken;
let withPrivilegedClient: typeof import('../../platform/db').withPrivilegedClient;
let getPlatformPool: typeof import('../../platform/db').getPlatformPool;
let seeded: SeededIds;
let tokenA: string;
let sharedTemplateId: string;

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

async function ensureSharedTemplate(): Promise<string> {
  const slug = `xtest-template-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO template_registry (slug, display_name, description, current_version, agent_type, config_schema)
       VALUES ($1, $2, $3, '1.0.0', 'inbound', '{}'::jsonb)
       RETURNING id`,
      [slug, `XTest Template ${slug}`, 'Cross-tenant test fixture template'],
    );
    return rows[0].id as string;
  });
}

async function seedResources(tenantId: string, templateId: string): Promise<Record<string, string>> {
  const ids = {
    agent: randomUUID(),
    call: randomUUID(),
    phone: randomUUID(),
    ticket: randomUUID(),
    booking: randomUUID(),
    dispatch: randomUUID(),
    sms: randomUUID(),
    autopilotRec: randomUUID(),
    autopilotInsight: randomUUID(),
    autopilotAction: randomUUID(),
    dtModel: randomUUID(),
    dtScenario: randomUUID(),
    dtRun: randomUUID(),
    forecast: randomUUID(),
    improvement: randomUUID(),
    caseStudy: randomUUID(),
    widgetToken: randomUUID(),
    kbDoc: '',
    toolInv: randomUUID(),
    installation: randomUUID(),
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

    // Autopilot recommendation (used by /autopilot/recommendations/:id/* mutations).
    await client.query(
      `INSERT INTO autopilot_recommendations (
         id, tenant_id, title, situation_summary, recommended_action, expected_outcome,
         reasoning, confidence_score, risk_tier, action_type, status
       ) VALUES ($1, $2, 'XTest rec', 'situation', 'action', 'outcome',
         'reasoning', 0.5, 'low', 'noop', 'pending')`,
      [ids.autopilotRec, tenantId],
    );

    // Autopilot insight (drives /autopilot/insights listing isolation).
    await client.query(
      `INSERT INTO autopilot_insights (
         id, tenant_id, category, severity, title, description, detected_signal, status
       ) VALUES ($1, $2, 'volume', 'info', 'XTest insight', 'XTest description',
         'XTest signal', 'active')`,
      [ids.autopilotInsight, tenantId],
    );

    // Autopilot action backs /autopilot/actions (list) and
    // /autopilot/actions/:id/rollback (mutate). Seeded as completed with a
    // null rollback_payload so rollbackAction() updates the row in place
    // without dispatching any side-effecting reverse action.
    await client.query(
      `INSERT INTO autopilot_actions (
         id, tenant_id, recommendation_id, action_type, action_payload, status,
         executed_at, completed_at, rollback_payload
       ) VALUES ($1, $2, $3, 'noop', '{}'::jsonb, 'completed',
         now(), now(), NULL)`,
      [ids.autopilotAction, tenantId, ids.autopilotRec],
    );

    // Digital-twin model + scenario + run + forecast for /digital-twin/* tests.
    await client.query(
      `INSERT INTO digital_twin_models (id, tenant_id, name, status, snapshot_data, is_simulation)
       VALUES ($1, $2, 'XTest model', 'ready', '{}'::jsonb, true)`,
      [ids.dtModel, tenantId],
    );
    await client.query(
      `INSERT INTO digital_twin_scenarios (id, tenant_id, name, scenario_type, parameters)
       VALUES ($1, $2, 'XTest scenario', 'baseline', '{}'::jsonb)`,
      [ids.dtScenario, tenantId],
    );
    await client.query(
      `INSERT INTO digital_twin_simulation_runs (
         id, tenant_id, model_id, scenario_id, name, status, parameters, is_simulation
       ) VALUES ($1, $2, $3, $4, 'XTest run', 'completed', '{}'::jsonb, true)`,
      [ids.dtRun, tenantId, ids.dtModel, ids.dtScenario],
    );
    await client.query(
      `INSERT INTO forecast_models (
         id, tenant_id, model_id, forecast_type, horizon_days, projections, confidence_level, is_simulation
       ) VALUES ($1, $2, $3, 'call_volume', 30, '[]'::jsonb, 0.8, true)`,
      [ids.forecast, tenantId, ids.dtModel],
    );

    // Improvement suggestion for /improvements/suggestions/:id*.
    await client.query(
      `INSERT INTO prompt_improvement_suggestions (
         id, tenant_id, agent_id, status, weakness_category, weakness_description,
         current_prompt_section, suggested_prompt_section, rationale
       ) VALUES ($1, $2, $3, 'pending', 'tone', 'XTest weakness',
         'current section', 'suggested section', 'XTest rationale')`,
      [ids.improvement, tenantId, ids.agent],
    );

    // Case study for /case-studies/:id/status (PATCH).
    await client.query(
      `INSERT INTO case_studies (
         id, tenant_id, milestone_type, milestone_value, industry, company_size, metrics, title, summary, status
       ) VALUES ($1, $2, 'call_volume', 100, 'general', 'small', '{}'::jsonb,
         'XTest case study', 'XTest summary', 'draft')`,
      [ids.caseStudy, tenantId],
    );

    // Widget token for /widget/tokens (list) and /widget/tokens/:id (DELETE).
    await client.query(
      `INSERT INTO widget_tokens (id, tenant_id, token_hash, label)
       VALUES ($1, $2, $3, 'XTest token')`,
      [ids.widgetToken, tenantId, `xtest-${randomUUID()}`],
    );

    // Knowledge document for /knowledge-documents/:id (GET/DELETE/reindex).
    // knowledge_documents.id is a SERIAL integer; capture it via RETURNING.
    const kbInsert = await client.query(
      `INSERT INTO knowledge_documents (
         tenant_id, title, source_type, status, raw_content, file_size
       ) VALUES ($1, 'XTest doc', 'text', 'ready', 'placeholder body', 16)
       RETURNING id`,
      [tenantId],
    );
    ids.kbDoc = String(kbInsert.rows[0].id);

    // Tool invocation row drives /tool-executions and /tool-executions/:id/replay.
    await client.query(
      `INSERT INTO tool_invocations (
         id, tenant_id, call_session_id, tool_name, status, input, parameters_redacted, agent_id
       ) VALUES ($1, $2, $3, 'noop_tool', 'success', '{}'::jsonb, '{}'::jsonb, $4)`,
      [ids.toolInv, tenantId, ids.call, ids.agent],
    );

    // Marketplace installation backs /marketplace/installations/:id/customize.
    await client.query(
      `INSERT INTO tenant_agent_installations (
         id, tenant_id, template_id, installed_version, status, agent_id, config, customization_overrides
       ) VALUES ($1, $2, $3, '1.0.0', 'active', $4, '{}'::jsonb, '{}'::jsonb)`,
      [ids.installation, tenantId, templateId, ids.agent],
    );
  });
  return ids;
}

async function cleanup() {
  await withPrivilegedClient(async (client) => {
    // Disable triggers in this transaction so FK ON DELETE SET NULL on
    // audit_logs.actor_user_id doesn't trip the immutable-audit_logs guard.
    await client.query(`SET LOCAL session_replication_role = replica`);
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await client.query(`DELETE FROM tenant_agent_installations WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM tool_invocations WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM knowledge_chunks WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM knowledge_documents WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM widget_tokens WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM widget_configs WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM case_studies WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM prompt_improvement_suggestions WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM forecast_models WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM digital_twin_results WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM digital_twin_simulation_runs WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM digital_twin_scenarios WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM digital_twin_models WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM autopilot_actions WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM autopilot_approvals WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM autopilot_recommendations WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM autopilot_runs WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM autopilot_insights WHERE tenant_id = $1`, [tenantId]);
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
    if (sharedTemplateId) {
      await client.query(`DELETE FROM template_registry WHERE id = $1`, [sharedTemplateId]);
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

    sharedTemplateId = await ensureSharedTemplate();
    await seedTenant({ tenantId: TENANT_A, user: USER_A });
    await seedTenant({ tenantId: TENANT_B, user: USER_B });
    const a = await seedResources(TENANT_A, sharedTemplateId);
    const b = await seedResources(TENANT_B, sharedTemplateId);
    seeded = {
      agentA: a.agent, agentB: b.agent,
      callA: a.call, callB: b.call,
      phoneA: a.phone, phoneB: b.phone,
      ticketA: a.ticket, ticketB: b.ticket,
      bookingA: a.booking, bookingB: b.booking,
      dispatchA: a.dispatch, dispatchB: b.dispatch,
      smsA: a.sms, smsB: b.sms,
      autopilotRecA: a.autopilotRec, autopilotRecB: b.autopilotRec,
      autopilotInsightA: a.autopilotInsight, autopilotInsightB: b.autopilotInsight,
      autopilotActionA: a.autopilotAction, autopilotActionB: b.autopilotAction,
      dtModelA: a.dtModel, dtModelB: b.dtModel,
      dtScenarioA: a.dtScenario, dtScenarioB: b.dtScenario,
      dtRunA: a.dtRun, dtRunB: b.dtRun,
      forecastA: a.forecast, forecastB: b.forecast,
      improvementA: a.improvement, improvementB: b.improvement,
      caseStudyA: a.caseStudy, caseStudyB: b.caseStudy,
      widgetTokenA: a.widgetToken, widgetTokenB: b.widgetToken,
      kbDocA: a.kbDoc, kbDocB: b.kbDoc,
      toolInvA: a.toolInv, toolInvB: b.toolInv,
      installationA: a.installation, installationB: b.installation,
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
    // `requireOwn`: when true, also assert that tenant A's seeded row IS
    // present in the listing. Some legacy listings filter or transform rows
    // (e.g. /calls only surfaces certain lifecycle states) so we keep those
    // looser to avoid false negatives.
    const cases: Array<{
      name: string;
      path: string;
      ownIdKey: keyof SeededIds;
      foreignIdKey: keyof SeededIds;
      requireOwn?: boolean;
    }> = [
      { name: 'GET /agents', path: '/agents', ownIdKey: 'agentA', foreignIdKey: 'agentB' },
      { name: 'GET /calls', path: '/calls', ownIdKey: 'callA', foreignIdKey: 'callB' },
      { name: 'GET /phone-numbers', path: '/phone-numbers', ownIdKey: 'phoneA', foreignIdKey: 'phoneB' },
      { name: 'GET /tickets', path: '/tickets', ownIdKey: 'ticketA', foreignIdKey: 'ticketB' },
      { name: 'GET /scheduling/bookings', path: '/scheduling/bookings', ownIdKey: 'bookingA', foreignIdKey: 'bookingB' },
      { name: 'GET /dispatch/jobs', path: '/dispatch/jobs', ownIdKey: 'dispatchA', foreignIdKey: 'dispatchB' },
      { name: 'GET /sms-inbox/threads', path: '/sms-inbox/threads', ownIdKey: 'smsA', foreignIdKey: 'smsB' },
      { name: 'GET /autopilot/recommendations', path: '/autopilot/recommendations', ownIdKey: 'autopilotRecA', foreignIdKey: 'autopilotRecB', requireOwn: true },
      { name: 'GET /autopilot/insights', path: '/autopilot/insights', ownIdKey: 'autopilotInsightA', foreignIdKey: 'autopilotInsightB', requireOwn: true },
      { name: 'GET /autopilot/actions', path: '/autopilot/actions', ownIdKey: 'autopilotActionA', foreignIdKey: 'autopilotActionB', requireOwn: true },
      { name: 'GET /digital-twin/models', path: '/digital-twin/models', ownIdKey: 'dtModelA', foreignIdKey: 'dtModelB', requireOwn: true },
      { name: 'GET /digital-twin/runs', path: '/digital-twin/runs', ownIdKey: 'dtRunA', foreignIdKey: 'dtRunB', requireOwn: true },
      { name: 'GET /digital-twin/forecasts', path: '/digital-twin/forecasts', ownIdKey: 'forecastA', foreignIdKey: 'forecastB', requireOwn: true },
      { name: 'GET /improvements/suggestions', path: '/improvements/suggestions', ownIdKey: 'improvementA', foreignIdKey: 'improvementB', requireOwn: true },
      { name: 'GET /case-studies', path: '/case-studies', ownIdKey: 'caseStudyA', foreignIdKey: 'caseStudyB', requireOwn: true },
      { name: 'GET /widget/tokens', path: '/widget/tokens', ownIdKey: 'widgetTokenA', foreignIdKey: 'widgetTokenB', requireOwn: true },
      { name: 'GET /knowledge-documents', path: '/knowledge-documents', ownIdKey: 'kbDocA', foreignIdKey: 'kbDocB', requireOwn: true },
      { name: 'GET /tool-executions', path: '/tool-executions', ownIdKey: 'toolInvA', foreignIdKey: 'toolInvB', requireOwn: true },
      { name: 'GET /marketplace/installations', path: '/marketplace/installations', ownIdKey: 'installationA', foreignIdKey: 'installationB', requireOwn: true },
    ];
    for (const c of cases) {
      it(`${c.name} only returns tenant A resources`, async () => {
        const res = await request(app)
          .get(c.path)
          .set('Authorization', `Bearer ${tokenA}`);

        expect(res.status, `${c.path} returned ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);

        const body = res.body as Record<string, unknown>;
        const candidateArrays = [body.items, body.data, body.results, body.rows, body.tokens, body.documents, body.executions, body.installations, body.suggestions, body.recommendations, body.insights, body.models, body.runs, body.forecasts, body.actions, body];
        const list = candidateArrays.find((v) => Array.isArray(v)) as unknown[] | undefined;
        const arr = (list ?? []) as Array<Record<string, unknown>>;

        const ownId = String(seeded[c.ownIdKey]);
        const foreignId = String(seeded[c.foreignIdKey]);
        // Compare against each row's `id` field directly to avoid substring
        // collisions (e.g. integer ids that match timestamps in JSON).
        const ids = arr.map((row) => String((row as Record<string, unknown>).id));
        expect(ids, `${c.path}: tenant B's ${c.foreignIdKey} (${foreignId}) must not appear in listing for tenant A`).not.toContain(foreignId);
        if (c.requireOwn) {
          expect(ids, `${c.path}: tenant A's seeded ${c.ownIdKey} (${ownId}) must appear in its own listing`).toContain(ownId);
        }
        // Also assert no row claims tenant B as its tenant_id (covers cases
        // where a route maps to a different surface id but still leaks rows).
        for (const row of arr) {
          const rowTenant = (row as Record<string, unknown>).tenant_id ?? (row as Record<string, unknown>).tenantId;
          if (rowTenant !== undefined && rowTenant !== null) {
            expect(rowTenant, `${c.path}: row leaked from foreign tenant`).not.toBe(TENANT_B);
          }
        }
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
      { name: 'GET /digital-twin/models/:id', path: (id) => `/digital-twin/models/${id}`, foreignKey: 'dtModelB' },
      { name: 'GET /digital-twin/scenarios/:id', path: (id) => `/digital-twin/scenarios/${id}`, foreignKey: 'dtScenarioB' },
      { name: 'GET /digital-twin/runs/:id', path: (id) => `/digital-twin/runs/${id}`, foreignKey: 'dtRunB' },
      { name: 'GET /digital-twin/forecasts/:id', path: (id) => `/digital-twin/forecasts/${id}`, foreignKey: 'forecastB' },
      { name: 'GET /improvements/suggestions/:id', path: (id) => `/improvements/suggestions/${id}`, foreignKey: 'improvementB' },
      { name: 'GET /knowledge-documents/:id', path: (id) => `/knowledge-documents/${id}`, foreignKey: 'kbDocB' },
      { name: 'GET /tool-executions/:id', path: (id) => `/tool-executions/${id}`, foreignKey: 'toolInvB' },
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

    it('GET /digital-twin/runs/:id/results returns no rows for foreign-tenant runs', async () => {
      const res = await request(app)
        .get(`/digital-twin/runs/${seeded.dtRunB}/results`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect([200, 403, 404]).toContain(res.status);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(seeded.dtRunB);
    });
  });

  describe('Mutation endpoints reject foreign-tenant IDs', () => {
    it('POST /autopilot/recommendations/:id/dismiss returns 404 for tenant B id', async () => {
      const res = await request(app)
        .post(`/autopilot/recommendations/${seeded.autopilotRecB}/dismiss`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({});
      expect([403, 404]).toContain(res.status);
    });

    it('POST /autopilot/recommendations/:id/approve returns 404 for tenant B id', async () => {
      const res = await request(app)
        .post(`/autopilot/recommendations/${seeded.autopilotRecB}/approve`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({});
      expect([403, 404]).toContain(res.status);
    });

    it('POST /autopilot/recommendations/:id/reject returns 404 for tenant B id', async () => {
      const res = await request(app)
        .post(`/autopilot/recommendations/${seeded.autopilotRecB}/reject`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ reason: 'cross-tenant-test' });
      expect([403, 404]).toContain(res.status);
    });

    it('POST /autopilot/recommendations/:id/execute returns 404 for tenant B id', async () => {
      const res = await request(app)
        .post(`/autopilot/recommendations/${seeded.autopilotRecB}/execute`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({});
      // /execute returns 400 ("must be approved") only when the row is found
      // in the caller's tenant. A foreign-tenant id must surface as 404/403,
      // never as 400 (which would imply the row leaked).
      expect([403, 404]).toContain(res.status);
    });

    it('POST /autopilot/actions/:id/rollback returns 404 for tenant B id', async () => {
      const res = await request(app)
        .post(`/autopilot/actions/${seeded.autopilotActionB}/rollback`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({});
      expect([403, 404]).toContain(res.status);
    });

    it('POST /improvements/suggestions/:id/accept returns 404 for tenant B id', async () => {
      const res = await request(app)
        .post(`/improvements/suggestions/${seeded.improvementB}/accept`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({});
      expect([403, 404]).toContain(res.status);
    });

    it('POST /improvements/suggestions/:id/dismiss returns 404 for tenant B id', async () => {
      const res = await request(app)
        .post(`/improvements/suggestions/${seeded.improvementB}/dismiss`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({});
      expect([403, 404]).toContain(res.status);
    });

    it('PATCH /case-studies/:id/status returns 404 for tenant B id', async () => {
      const res = await request(app)
        .patch(`/case-studies/${seeded.caseStudyB}/status`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ status: 'approved' });
      expect([403, 404]).toContain(res.status);
    });

    it('DELETE /widget/tokens/:id returns 404 for tenant B id', async () => {
      const res = await request(app)
        .delete(`/widget/tokens/${seeded.widgetTokenB}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect([403, 404]).toContain(res.status);
    });

    it('DELETE /knowledge-documents/:id returns 404 for tenant B id', async () => {
      const res = await request(app)
        .delete(`/knowledge-documents/${seeded.kbDocB}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect([403, 404]).toContain(res.status);
    });

    it('POST /knowledge-documents/:id/reindex returns 404 for tenant B id', async () => {
      const res = await request(app)
        .post(`/knowledge-documents/${seeded.kbDocB}/reindex`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({});
      expect([403, 404]).toContain(res.status);
    });

    it('POST /tool-executions/:id/replay returns 404 for tenant B id', async () => {
      const res = await request(app)
        .post(`/tool-executions/${seeded.toolInvB}/replay`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({});
      expect([403, 404]).toContain(res.status);
    });

    it('DELETE /digital-twin/models/:id returns 404 for tenant B id', async () => {
      const res = await request(app)
        .delete(`/digital-twin/models/${seeded.dtModelB}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect([403, 404]).toContain(res.status);
    });

    it('PATCH /marketplace/installations/:id/customize returns 404 for tenant B id', async () => {
      const res = await request(app)
        .patch(`/marketplace/installations/${seeded.installationB}/customize`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'attempted-cross-tenant-update' });
      expect([403, 404]).toContain(res.status);
    });

    it('PATCH /marketplace/installations/:id returns 404 for tenant B id', async () => {
      const res = await request(app)
        .patch(`/marketplace/installations/${seeded.installationB}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'attempted-cross-tenant-rename' });
      expect([403, 404]).toContain(res.status);
    });

    it('GET /marketplace/installations/:id/checklist returns 404 for tenant B id', async () => {
      const res = await request(app)
        .get(`/marketplace/installations/${seeded.installationB}/checklist`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect([403, 404]).toContain(res.status);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(seeded.installationB);
    });

    it('GET /marketplace/installations/:id/customization-schema returns 404 for tenant B id', async () => {
      const res = await request(app)
        .get(`/marketplace/installations/${seeded.installationB}/customization-schema`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect([403, 404]).toContain(res.status);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(seeded.installationB);
    });
  });

  // /workforce/* and /insights/* are called out by BL-026 as endpoint
  // families we must keep cross-tenant-tested. They are not yet mounted on
  // admin-api (workforce currently lives only as an internal platform service
  // and insights surface through /autopilot/insights). These tests guard
  // against a future regression where someone adds those routes without
  // adding cross-tenant tests: the moment any /workforce/* or /insights/*
  // endpoint is mounted, these assertions will start failing and require
  // proper tenant-scoped coverage to be authored alongside the new routes.
  describe('Reserved route families (workforce, insights) are not yet exposed', () => {
    const reservedPaths = [
      '/workforce/teams',
      '/workforce/members',
      '/workforce/handoffs',
      '/insights',
      '/insights/summary',
    ];
    for (const p of reservedPaths) {
      it(`${p} is not mounted (would otherwise need its own cross-tenant tests)`, async () => {
        const res = await request(app)
          .get(p)
          .set('Authorization', `Bearer ${tokenA}`);
        expect(
          res.status,
          `${p} now responds with ${res.status}; if you just mounted this route, add a cross-tenant test for it before relaxing this assertion.`,
        ).toBe(404);
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

  describe('Tool registry endpoints', () => {
    const TENANT_C = randomUUID();
    const USER_C = { id: randomUUID(), email: `user-c-${Date.now()}@x-tenant-test.local` };
    let tokenC: string;

    beforeAll(async () => {
      const { registerTemplateTools } = await import('../../platform/tools/registerTemplateTools');
      registerTemplateTools();

      await seedTenant({ tenantId: TENANT_C, user: USER_C });
      await withPrivilegedClient(async (client) => {
        await client.query(
          `INSERT INTO agents (id, tenant_id, name, type, status)
           VALUES ($1, $2, 'XTest dental', 'dental', 'active')`,
          [randomUUID(), TENANT_C],
        );
      });
      tokenC = issueToken({
        userId: USER_C.id,
        tenantId: TENANT_C,
        email: USER_C.email,
        role: 'tenant_owner',
        isPlatformAdmin: false,
      });
    });

    afterAll(async () => {
      await withPrivilegedClient(async (client) => {
        await client.query(`DELETE FROM agents WHERE tenant_id = $1`, [TENANT_C]);
        await client.query(`DELETE FROM user_roles WHERE tenant_id = $1`, [TENANT_C]);
        await client.query(`DELETE FROM users WHERE tenant_id = $1`, [TENANT_C]);
        await client.query(`DELETE FROM tenants WHERE id = $1`, [TENANT_C]);
      });
    });

    it('GET /platform/tools/registry returns 403 for non-admin tenant users', async () => {
      const res = await request(app)
        .get('/platform/tools/registry')
        .set('Authorization', `Bearer ${tokenC}`);
      expect(res.status, `expected 403, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(403);
    });

    it('GET /tools/registry only returns tools enabled by the tenant\u2019s agent templates', async () => {
      const res = await request(app)
        .get('/tools/registry')
        .set('Authorization', `Bearer ${tokenC}`);
      expect(res.status, `expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);

      const tools = (res.body?.tools ?? []) as Array<{ name: string }>;
      const names = new Set(tools.map((t) => t.name));

      // The dental template allows scheduleDentalAppointment.
      expect(names.has('scheduleDentalAppointment'), 'scheduleDentalAppointment should be returned for a tenant with a dental agent').toBe(true);

      // Tools denied by every one of the tenant\u2019s agent templates must not appear.
      const deniedForDentalOnlyTenant = [
        'createServiceTicket',
        'createAfterHoursTicket',
        'triageEscalate',
        'scheduleConsultation',
        'submitMaintenanceRequest',
        'bookServiceAppointment',
      ];
      for (const denied of deniedForDentalOnlyTenant) {
        expect(names.has(denied), `tool ${denied} should NOT be returned for a tenant whose only agent denies it`).toBe(false);
      }
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
      '/platform/tools/registry',
      // Evolution endpoints are platform-admin-only; tenant users must never
      // see another tenant's roadmap, signals, opportunities, or experiments.
      '/evolution/signals',
      '/evolution/opportunities',
      '/evolution/recommendations',
      '/evolution/experiments',
      '/evolution/dashboard',
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
