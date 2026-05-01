/**
 * Task #1159: seed demo dispatch jobs, SMS conversations and call quality
 * scores onto the admin-org tenant so the
 * `tests/e2e/tenantStatusBadgeAxe.spec.ts` audit actually exercises the
 * status pills on `/dispatch`, `/sms-inbox` and `/quality`.
 *
 * Without these fixtures those three pages render zero status badges
 * under the admin-only seed used by `.github/workflows/admin-e2e.yml`,
 * and the audit no-ops on them with a "no badge nodes found" warning.
 *
 * Seeds (all on `admin-org`, idempotent via stable IDs + ON CONFLICT):
 *   - 1 phone number (carrier of the SMS conversations).
 *   - 10 dispatch_jobs, one per lifecycle state in the
 *     `dispatch_jobs_status_check` constraint:
 *     pending, assigned, scheduled, en_route, on_site, in_progress,
 *     completed, incomplete, cancelled, done.
 *   - 6 sms_conversations covering each conversation status the
 *     SmsInbox sidebar surfaces (open, pending, escalated, closed)
 *     plus pinned + follow-up boolean state, with at least one
 *     inbound message each so `last_message_at`/`unread_count` stay
 *     accurate and the conversation surfaces in the default 'all'
 *     view.
 *   - 4 call_sessions + matching call_quality_scores spanning the
 *     three score bands the Quality page colour-codes (good >= 8,
 *     fair 6-7.99, needs-attention < 6) so the lowest-scoring table
 *     renders representative rows under all colour bands.
 *
 * Pre-requisite: `scripts/seed-admin.ts` has run (this script needs the
 * `admin-org` tenant + `admin-org-smoke-agent` row that script seeds).
 *
 * Usage:
 *   APP_ENV=development DATABASE_URL=... \
 *     npx tsx scripts/seed-status-badge-fixtures.ts
 */
import pg from 'pg';

const ADMIN_TENANT_ID = 'admin-org';

// Stable id used by the seeded fixture agent in `seed-admin.ts`. Kept in
// sync with `SMOKE_AGENT_ID` over there. Used here so the call_sessions
// rows we seed have a real agent_id (NULL is allowed but the Quality
// "Lowest Scoring" rows render the agent name).
const SMOKE_AGENT_ID = 'admin-org-smoke-agent';

// Stable id for the fixture phone number that the SMS conversation
// rows hang off. The conversations all reference this row via
// `phone_number_id`.
const FIXTURE_PHONE_ID = 'admin-org-fixture-phone';
const FIXTURE_PHONE_NUMBER = '+15555550100';

interface DispatchJobFixture {
  id: string;
  status: string;
  title: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  contactName: string;
  notes: string;
}

const DISPATCH_JOB_FIXTURES: DispatchJobFixture[] = [
  { id: 'admin-org-fixture-job-pending',     status: 'pending',     title: 'Replace HVAC condenser fan motor',  priority: 'medium', contactName: 'Avery Patel',       notes: 'Customer reports loud humming at unit.' },
  { id: 'admin-org-fixture-job-assigned',    status: 'assigned',    title: 'Install new water heater',           priority: 'high',   contactName: 'Jordan Rivera',     notes: 'Assigned to senior tech.' },
  { id: 'admin-org-fixture-job-scheduled',   status: 'scheduled',   title: 'Annual furnace tune-up',             priority: 'low',    contactName: 'Morgan Lee',        notes: 'Scheduled for tomorrow morning.' },
  { id: 'admin-org-fixture-job-en-route',    status: 'en_route',    title: 'Emergency leak inspection',          priority: 'urgent', contactName: 'Sam Chen',          notes: 'Tech departed depot at 09:15.' },
  { id: 'admin-org-fixture-job-on-site',     status: 'on_site',     title: 'Diagnose intermittent A/C failure',  priority: 'high',   contactName: 'Riley Brooks',      notes: 'Tech on-site, beginning diagnostics.' },
  { id: 'admin-org-fixture-job-in-progress', status: 'in_progress', title: 'Replace burst pipe in basement',     priority: 'urgent', contactName: 'Casey Nguyen',      notes: 'Repair in progress, parts on truck.' },
  { id: 'admin-org-fixture-job-completed',   status: 'completed',   title: 'Quarterly preventative maintenance', priority: 'medium', contactName: 'Taylor Sims',       notes: 'Job completed, awaiting customer signoff.' },
  { id: 'admin-org-fixture-job-incomplete',  status: 'incomplete',  title: 'Smart thermostat install',           priority: 'medium', contactName: 'Jamie Foster',      notes: 'Customer was unavailable, needs reschedule.' },
  { id: 'admin-org-fixture-job-cancelled',   status: 'cancelled',   title: 'Duct cleaning service',              priority: 'low',    contactName: 'Pat Kim',           notes: 'Customer cancelled prior to dispatch.' },
  { id: 'admin-org-fixture-job-done',        status: 'done',        title: 'Refrigerant top-up + leak seal',     priority: 'high',   contactName: 'Quinn Alvarez',     notes: 'Completed and signed off.' },
];

interface ConversationFixture {
  id: string;
  status: 'open' | 'pending' | 'closed' | 'escalated';
  remoteNumber: string;
  contactName: string;
  preview: string;
  unreadCount: number;
  pinned: boolean;
  followUp: boolean;
  priority: 'normal' | 'high' | 'urgent';
}

const SMS_CONVERSATION_FIXTURES: ConversationFixture[] = [
  {
    id: 'admin-org-fixture-conv-open',
    status: 'open',
    remoteNumber: '+15555550211',
    contactName: 'Alex Doerr',
    preview: 'Hi, can someone confirm my appointment for Friday?',
    unreadCount: 2,
    pinned: false,
    followUp: false,
    priority: 'normal',
  },
  {
    id: 'admin-org-fixture-conv-pending',
    status: 'pending',
    remoteNumber: '+15555550212',
    contactName: 'Bailey Singh',
    preview: 'Following up on my service request from yesterday.',
    unreadCount: 0,
    pinned: false,
    followUp: true,
    priority: 'high',
  },
  {
    id: 'admin-org-fixture-conv-escalated',
    status: 'escalated',
    remoteNumber: '+15555550213',
    contactName: 'Cory Mendoza',
    preview: 'This is the third time the unit has failed — need a manager.',
    unreadCount: 1,
    pinned: true,
    followUp: false,
    priority: 'urgent',
  },
  {
    id: 'admin-org-fixture-conv-closed',
    status: 'closed',
    remoteNumber: '+15555550214',
    contactName: 'Devin Park',
    preview: 'Thanks, all set — appreciate the quick fix!',
    unreadCount: 0,
    pinned: false,
    followUp: false,
    priority: 'normal',
  },
  {
    id: 'admin-org-fixture-conv-pinned',
    status: 'open',
    remoteNumber: '+15555550215',
    contactName: 'Emery Sato',
    preview: 'Pinning this for the morning standup.',
    unreadCount: 0,
    pinned: true,
    followUp: false,
    priority: 'normal',
  },
  {
    id: 'admin-org-fixture-conv-follow-up',
    status: 'open',
    remoteNumber: '+15555550216',
    contactName: 'Frankie Olsen',
    preview: 'Will follow up next week with the quote.',
    unreadCount: 0,
    pinned: false,
    followUp: true,
    priority: 'normal',
  },
];

interface CallFixture {
  id: string;
  callerNumber: string;
  durationSeconds: number;
  /** Score 0-10. Quality page colour-codes >=8 green, 6-7.99 yellow, <6 red. */
  score: number;
  summary: string;
}

const CALL_FIXTURES: CallFixture[] = [
  // good band
  { id: 'admin-org-fixture-call-good',       callerNumber: '+15555550311', durationSeconds: 184, score: 9.2, summary: 'Routine appointment confirmation, customer satisfied.' },
  // fair band (two so the table has variety)
  { id: 'admin-org-fixture-call-fair-1',     callerNumber: '+15555550312', durationSeconds: 312, score: 7.4, summary: 'Customer wanted to reschedule; scheduling friction noted.' },
  { id: 'admin-org-fixture-call-fair-2',     callerNumber: '+15555550313', durationSeconds: 256, score: 6.8, summary: 'Quote walkthrough; customer asked clarifying questions.' },
  // needs-attention band
  { id: 'admin-org-fixture-call-low',        callerNumber: '+15555550314', durationSeconds: 421, score: 4.6, summary: 'Escalation: agent could not resolve billing dispute.' },
];

async function main(): Promise<void> {
  const env = process.env.APP_ENV ?? 'development';
  if (env !== 'development') {
    throw new Error(
      '[SEED-FIXTURES] This script can only run in development (APP_ENV=development). ' +
      'It seeds visible fixture data into the admin-org tenant — never run against prod.',
    );
  }

  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    throw new Error('[SEED-FIXTURES] DATABASE_URL is not set for development.');
  }

  console.log(`[SEED-FIXTURES] Environment: ${env}`);
  console.log(`[SEED-FIXTURES] Tenant: ${ADMIN_TENANT_ID}`);

  const pool = new pg.Pool({ connectionString: url, max: 3 });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // RLS-protected tables (sms_*, call_quality_scores) require the
    // tenant GUC to be set so policies allow inserts. We're running as
    // the migration role which generally bypasses RLS, but setting the
    // GUC keeps this safe even if a future migration ever removes the
    // bypass.
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ADMIN_TENANT_ID]);

    // Sanity-check the tenant + agent rows seed-admin.ts is supposed to
    // have created. If they're missing, fail loud rather than letting
    // FK violations bubble up further down.
    const tenantCheck = await client.query(`SELECT 1 FROM tenants WHERE id = $1`, [ADMIN_TENANT_ID]);
    if (tenantCheck.rowCount === 0) {
      throw new Error(
        `[SEED-FIXTURES] Tenant ${ADMIN_TENANT_ID} not found. ` +
        'Run `scripts/seed-admin.ts` first.',
      );
    }
    const agentCheck = await client.query(`SELECT 1 FROM agents WHERE id = $1 AND tenant_id = $2`, [SMOKE_AGENT_ID, ADMIN_TENANT_ID]);
    if (agentCheck.rowCount === 0) {
      throw new Error(
        `[SEED-FIXTURES] Smoke agent ${SMOKE_AGENT_ID} not found on ${ADMIN_TENANT_ID}. ` +
        'Run `scripts/seed-admin.ts` first.',
      );
    }

    // ─── Phone number fixture (parent of SMS conversations) ────────────
    console.log('[SEED-FIXTURES] Upserting fixture phone number...');
    await client.query(
      `INSERT INTO phone_numbers (id, tenant_id, phone_number, friendly_name, status, capabilities, provisioned_at)
       VALUES ($1, $2, $3, 'Status Badge Fixture Line', 'active',
               '{"voice": true, "sms": true}'::jsonb, NOW())
       ON CONFLICT (tenant_id, phone_number) DO UPDATE SET
         id = EXCLUDED.id,
         friendly_name = EXCLUDED.friendly_name,
         status = 'active',
         updated_at = NOW()`,
      [FIXTURE_PHONE_ID, ADMIN_TENANT_ID, FIXTURE_PHONE_NUMBER],
    );

    // ─── Dispatch jobs (one per lifecycle state) ───────────────────────
    console.log(`[SEED-FIXTURES] Upserting ${DISPATCH_JOB_FIXTURES.length} dispatch jobs...`);
    for (const job of DISPATCH_JOB_FIXTURES) {
      const completedAt = job.status === 'completed' || job.status === 'done' ? 'NOW()' : 'NULL';
      await client.query(
        `INSERT INTO dispatch_jobs
           (id, tenant_id, title, description, status, priority,
            contact_name, notes, scheduled_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '1 day', ${completedAt})
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           status = EXCLUDED.status,
           priority = EXCLUDED.priority,
           contact_name = EXCLUDED.contact_name,
           notes = EXCLUDED.notes,
           completed_at = ${completedAt},
           updated_at = NOW()`,
        [
          job.id,
          ADMIN_TENANT_ID,
          job.title,
          `Status-badge audit fixture (job lifecycle: ${job.status}).`,
          job.status,
          job.priority,
          job.contactName,
          job.notes,
        ],
      );
    }

    // ─── SMS conversations (one per inbox view) + a seed message each ──
    console.log(`[SEED-FIXTURES] Upserting ${SMS_CONVERSATION_FIXTURES.length} SMS conversations...`);
    for (const conv of SMS_CONVERSATION_FIXTURES) {
      await client.query(
        `INSERT INTO sms_conversations
           (id, tenant_id, phone_number_id, remote_number, status,
            priority, pinned, unread_count, follow_up,
            last_message_at, last_message_preview, contact_name,
            closed_at, escalated_at)
         VALUES ($1, $2, $3, $4, $5::varchar, $6, $7, $8, $9,
                 NOW(), $10, $11,
                 CASE WHEN $5::varchar = 'closed' THEN NOW() ELSE NULL END,
                 CASE WHEN $5::varchar = 'escalated' THEN NOW() ELSE NULL END)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           priority = EXCLUDED.priority,
           pinned = EXCLUDED.pinned,
           unread_count = EXCLUDED.unread_count,
           follow_up = EXCLUDED.follow_up,
           last_message_at = EXCLUDED.last_message_at,
           last_message_preview = EXCLUDED.last_message_preview,
           contact_name = EXCLUDED.contact_name,
           closed_at = EXCLUDED.closed_at,
           escalated_at = EXCLUDED.escalated_at,
           updated_at = NOW()`,
        [
          conv.id,
          ADMIN_TENANT_ID,
          FIXTURE_PHONE_ID,
          conv.remoteNumber,
          conv.status,
          conv.priority,
          conv.pinned,
          conv.unreadCount,
          conv.followUp,
          conv.preview,
          conv.contactName,
        ],
      );

      const messageId = `${conv.id}-msg-1`;
      await client.query(
        `INSERT INTO sms_messages
           (id, tenant_id, conversation_id, direction,
            from_number, to_number, body, status, sent_at)
         VALUES ($1, $2, $3, 'inbound', $4, $5, $6, 'delivered', NOW())
         ON CONFLICT (id) DO UPDATE SET
           body = EXCLUDED.body,
           status = EXCLUDED.status,
           sent_at = EXCLUDED.sent_at`,
        [
          messageId,
          ADMIN_TENANT_ID,
          conv.id,
          conv.remoteNumber,
          FIXTURE_PHONE_NUMBER,
          conv.preview,
        ],
      );
    }

    // ─── Call sessions + quality scores (Lowest Scoring rows) ──────────
    console.log(`[SEED-FIXTURES] Upserting ${CALL_FIXTURES.length} call sessions + quality scores...`);
    for (const call of CALL_FIXTURES) {
      await client.query(
        `INSERT INTO call_sessions
           (id, tenant_id, agent_id, direction, caller_number, called_number,
            lifecycle_state, start_time, end_time, duration_seconds)
         VALUES ($1, $2, $3, 'inbound', $4, $5,
                 'CALL_COMPLETED',
                 NOW() - ($6::int || ' seconds')::INTERVAL,
                 NOW(),
                 $6::int)
         ON CONFLICT (id) DO UPDATE SET
           lifecycle_state = 'CALL_COMPLETED',
           duration_seconds = EXCLUDED.duration_seconds,
           end_time = EXCLUDED.end_time,
           updated_at = NOW()`,
        [
          call.id,
          ADMIN_TENANT_ID,
          SMOKE_AGENT_ID,
          call.callerNumber,
          FIXTURE_PHONE_NUMBER,
          call.durationSeconds,
        ],
      );

      const qualityId = `${call.id}-quality`;
      await client.query(
        `INSERT INTO call_quality_scores
           (id, tenant_id, call_session_id, score, feedback, scored_by, scored_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'gpt-4o-mini', NOW())
         ON CONFLICT (id) DO UPDATE SET
           score = EXCLUDED.score,
           feedback = EXCLUDED.feedback,
           scored_at = EXCLUDED.scored_at`,
        [
          qualityId,
          ADMIN_TENANT_ID,
          call.id,
          call.score,
          JSON.stringify({ summary: call.summary, transcriptPreview: call.summary }),
        ],
      );
    }

    await client.query('COMMIT');
    console.log(
      `[SEED-FIXTURES] Done. ` +
      `${DISPATCH_JOB_FIXTURES.length} dispatch jobs, ` +
      `${SMS_CONVERSATION_FIXTURES.length} SMS conversations, ` +
      `${CALL_FIXTURES.length} call/quality records seeded on ${ADMIN_TENANT_ID}.`,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[SEED-FIXTURES] Failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
