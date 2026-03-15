/*
 * Migration 017: Complete RLS with WITH CHECK enforcement on write paths
 *
 * Design note — Why current_setting('app.tenant_id') instead of auth.uid()/JWT:
 * This platform connects to Supabase via the transaction pooler (port 6543) as a
 * server-side Node.js process. Direct Supabase auth claims (auth.uid()) apply to
 * client-SDK connections. For backend service-role connections the standard pattern
 * is to set app.tenant_id per transaction in the application middleware before any
 * tenant-scoped query — the withTenantContext() helper in platform/db/index.ts does
 * this. Policies include WITH CHECK so that INSERT/UPDATE are also tenant-scoped.
 */

DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_tenants              ON tenants;              EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_user_tenant_roles    ON user_tenant_roles;    EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_users                ON users;                EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_agents               ON agents;               EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_agent_tools          ON agent_tools;          EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_phone_endpoints      ON phone_endpoints;      EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_phone_numbers        ON phone_numbers;        EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_number_routing       ON number_routing;       EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_campaigns            ON campaigns;            EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_campaign_contacts    ON campaign_contacts;    EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_campaign_contact_attempts ON campaign_contact_attempts; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_call_logs            ON call_logs;            EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_sms_logs             ON sms_logs;             EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_callback_queue       ON callback_queue;       EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_answering_service_logs ON answering_service_logs; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_support_tickets      ON support_tickets;      EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_scheduling_workflows ON scheduling_workflows; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_agent_prompts        ON agent_prompts;        EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_agent_prompt_versions ON agent_prompt_versions; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_active_call_sessions ON active_call_sessions; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_handoff_states       ON handoff_states;       EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_ticket_outbox        ON ticket_outbox;        EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_webhook_events       ON webhook_events;       EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_prompt_versions      ON prompt_versions;      EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_user_invitations     ON user_invitations;     EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_password_reset_tokens ON password_reset_tokens; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_daily_openai_costs   ON daily_openai_costs;   EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_daily_org_usage      ON daily_org_usage;      EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_daily_reconciliation ON daily_reconciliation; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_call_sessions        ON call_sessions;        EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_call_events          ON call_events;          EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_call_transcripts     ON call_transcripts;     EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_tool_invocations     ON tool_invocations;     EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_workflow_executions  ON workflow_executions;  EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_workflow_steps       ON workflow_steps;       EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_integrations         ON integrations;         EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_connector_configs    ON connector_configs;    EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_outbox_events        ON outbox_events;        EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_subscriptions        ON subscriptions;        EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_usage_metrics        ON usage_metrics;        EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_billing_events       ON billing_events;       EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_analytics_metrics    ON analytics_metrics;    EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_system_metrics       ON system_metrics;       EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_error_logs           ON error_logs;           EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_audit_logs           ON audit_logs;           EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_demo_agents          ON demo_agents;          EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS tenant_isolation_demo_sessions        ON demo_sessions;        EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE POLICY tenant_isolation_tenants ON tenants
  USING (id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_user_tenant_roles ON user_tenant_roles
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_users ON users
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_agents ON agents
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_agent_tools ON agent_tools
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_phone_endpoints ON phone_endpoints
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_phone_numbers ON phone_numbers
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_number_routing ON number_routing
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_campaigns ON campaigns
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_campaign_contacts ON campaign_contacts
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_campaign_contact_attempts ON campaign_contact_attempts
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_call_logs ON call_logs
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_sms_logs ON sms_logs
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_callback_queue ON callback_queue
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_answering_service_logs ON answering_service_logs
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_support_tickets ON support_tickets
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_scheduling_workflows ON scheduling_workflows
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_agent_prompts ON agent_prompts
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_agent_prompt_versions ON agent_prompt_versions
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_active_call_sessions ON active_call_sessions
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_handoff_states ON handoff_states
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_ticket_outbox ON ticket_outbox
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_webhook_events ON webhook_events
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_prompt_versions ON prompt_versions
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_user_invitations ON user_invitations
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_password_reset_tokens ON password_reset_tokens
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_daily_openai_costs ON daily_openai_costs
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_daily_org_usage ON daily_org_usage
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_daily_reconciliation ON daily_reconciliation
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_call_sessions ON call_sessions
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_call_events ON call_events
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_call_transcripts ON call_transcripts
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_tool_invocations ON tool_invocations
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_workflow_executions ON workflow_executions
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_workflow_steps ON workflow_steps
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_integrations ON integrations
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_connector_configs ON connector_configs
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_outbox_events ON outbox_events
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_subscriptions ON subscriptions
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_usage_metrics ON usage_metrics
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_billing_events ON billing_events
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_analytics_metrics ON analytics_metrics
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_error_logs ON error_logs
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_demo_agents ON demo_agents
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);

CREATE POLICY tenant_isolation_demo_sessions ON demo_sessions
  USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar);
