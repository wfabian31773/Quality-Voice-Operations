--
-- PostgreSQL database dump
--

\restrict G2qAv94C1arSpmbcqIQPrE3mTUkJSINKruFIWbV70IPXzGYyKce1piz3RKiHuLr

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: billing_event_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.billing_event_type AS ENUM (
    'subscription_created',
    'subscription_updated',
    'subscription_cancelled',
    'invoice_paid',
    'invoice_failed',
    'usage_charged',
    'credit_applied',
    'refund_issued',
    'usage_warning',
    'account_suspended'
);


--
-- Name: billing_interval; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.billing_interval AS ENUM (
    'monthly',
    'annual'
);


--
-- Name: call_lifecycle_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.call_lifecycle_state AS ENUM (
    'CALL_RECEIVED',
    'SESSION_INITIALIZED',
    'AGENT_CONNECTED',
    'ACTIVE_CONVERSATION',
    'WORKFLOW_EXECUTION',
    'TOOL_EXECUTION',
    'ESCALATION_CHECK',
    'ESCALATED',
    'CALL_COMPLETED',
    'CALL_FAILED',
    'WORKFLOW_FAILED',
    'ESCALATION_FAILED',
    'HANDOFF'
);


--
-- Name: cost_component_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cost_component_type AS ENUM (
    'stt',
    'llm',
    'tts',
    'infrastructure'
);


--
-- Name: error_severity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.error_severity AS ENUM (
    'debug',
    'info',
    'warning',
    'error',
    'critical'
);


--
-- Name: evolution_experiment_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.evolution_experiment_state AS ENUM (
    'draft',
    'active',
    'paused',
    'concluded',
    'cancelled'
);


--
-- Name: evolution_opportunity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.evolution_opportunity_type AS ENUM (
    'missing_vertical',
    'missing_integration',
    'missing_tool',
    'onboarding_gap',
    'marketplace_gap',
    'retention_risk',
    'revenue_opportunity',
    'ux_improvement'
);


--
-- Name: evolution_recommendation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.evolution_recommendation_status AS ENUM (
    'proposed',
    'approved',
    'rejected',
    'deferred',
    'in_progress',
    'completed'
);


--
-- Name: evolution_scoring_dimension; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.evolution_scoring_dimension AS ENUM (
    'customer_demand',
    'revenue_potential',
    'strategic_fit',
    'development_effort',
    'retention_impact',
    'differentiation'
);


--
-- Name: evolution_signal_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.evolution_signal_source AS ENUM (
    'call_analytics',
    'marketplace',
    'usage_metrics',
    'onboarding',
    'demo_behavior',
    'support_patterns',
    'churn',
    'feature_request'
);


--
-- Name: integration_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.integration_type AS ENUM (
    'crm',
    'ticketing',
    'scheduling',
    'ehr',
    'sms',
    'email',
    'webhook',
    'custom',
    'accounting'
);


--
-- Name: marketplace_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.marketplace_category AS ENUM (
    'vertical_agent',
    'workflow_package',
    'integration_connector',
    'prompt_pack',
    'analytics_pack'
);


--
-- Name: model_tier; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.model_tier AS ENUM (
    'economy',
    'standard',
    'premium'
);


--
-- Name: outbox_event_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.outbox_event_status AS ENUM (
    'pending',
    'processing',
    'delivered',
    'failed',
    'dead_letter'
);


--
-- Name: price_model; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.price_model AS ENUM (
    'free',
    'one_time',
    'monthly_subscription',
    'usage_based'
);


--
-- Name: submission_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.submission_status AS ENUM (
    'draft',
    'submitted',
    'in_review',
    'approved',
    'rejected',
    'published'
);


--
-- Name: subscription_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.subscription_status AS ENUM (
    'trialing',
    'active',
    'past_due',
    'paused',
    'cancelled'
);


--
-- Name: tenant_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tenant_role AS ENUM (
    'tenant_owner',
    'operations_manager',
    'support_reviewer',
    'billing_admin',
    'agent_developer'
);


--
-- Name: tool_invocation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tool_invocation_status AS ENUM (
    'pending',
    'running',
    'success',
    'failed',
    'timeout'
);


--
-- Name: usage_metric_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.usage_metric_type AS ENUM (
    'calls_inbound',
    'calls_outbound',
    'sms_sent',
    'sms_received',
    'ai_minutes',
    'tool_invocations',
    'workflow_executions',
    'tool_executions',
    'api_requests'
);


--
-- Name: workflow_execution_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.workflow_execution_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed',
    'timed_out',
    'cancelled'
);


--
-- Name: ensure_call_events_partition(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_call_events_partition(p_month_start timestamp with time zone) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_start DATE := date_trunc('month', p_month_start)::DATE;
  v_end   DATE := (date_trunc('month', p_month_start) + INTERVAL '1 month')::DATE;
  v_name  TEXT := 'call_events_' || to_char(v_start, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF call_events FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end
    );
  END IF;
  RETURN v_name;
END;
$$;


--
-- Name: prevent_audit_log_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_audit_log_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is immutable: % operations are not permitted', TG_OP;
  RETURN NULL;
END;
$$;


--
-- Name: prune_call_events_older_than(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_call_events_older_than(p_retain_days integer DEFAULT 90) RETURNS text[]
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_cutoff   TIMESTAMPTZ := date_trunc('day', NOW()) - make_interval(days => p_retain_days);
  v_dropped  TEXT[] := ARRAY[]::TEXT[];
  v_part     RECORD;
  v_upper_ts TIMESTAMPTZ;
BEGIN
  FOR v_part IN
    SELECT child.relname           AS part_name,
           pg_get_expr(child.relpartbound, child.oid) AS bounds
      FROM pg_inherits i
      JOIN pg_class child  ON child.oid  = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
     WHERE parent.relname = 'call_events'
  LOOP
    -- Default partition (if anyone creates one) returns 'DEFAULT' here; skip.
    IF v_part.bounds = 'DEFAULT' THEN
      CONTINUE;
    END IF;

    -- bounds looks like:  FOR VALUES FROM ('2025-07-01') TO ('2025-08-01')
    -- Extract the upper-bound literal between the last "TO ('" and the
    -- closing "')".
    v_upper_ts := substring(v_part.bounds FROM 'TO \(''([^'']+)''\)')::TIMESTAMPTZ;

    IF v_upper_ts <= v_cutoff THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', v_part.part_name);
      v_dropped := array_append(v_dropped, v_part.part_name);
    END IF;
  END LOOP;

  RETURN v_dropped;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activation_events (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    event_type text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: active_call_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_call_sessions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    call_sid character varying(50) NOT NULL,
    agent_id character varying,
    session_data jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_prompt_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_prompt_versions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    agent_id character varying NOT NULL,
    version integer NOT NULL,
    system_prompt text NOT NULL,
    notes text,
    created_by character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_prompts (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    agent_id character varying,
    name character varying(255) NOT NULL,
    content text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_templates (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    created_by_user_id character varying,
    name character varying(120) NOT NULL,
    description text,
    workflow_definition jsonb DEFAULT '{"edges": [], "nodes": []}'::jsonb NOT NULL,
    welcome_greeting text,
    system_prompt text,
    language character varying(8) DEFAULT 'en'::character varying NOT NULL,
    is_shared boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tools (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    agent_id character varying NOT NULL,
    tool_name character varying(100) NOT NULL,
    tool_config jsonb DEFAULT '{}'::jsonb,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_versions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    agent_id character varying NOT NULL,
    version integer NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    workflow_definition jsonb,
    system_prompt text,
    voice character varying(50),
    model character varying(100),
    temperature numeric(3,2),
    welcome_greeting text,
    tools jsonb,
    published_at timestamp without time zone,
    published_by character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    name character varying(255) NOT NULL,
    type character varying(60) DEFAULT 'general'::character varying NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    system_prompt text,
    voice character varying(50) DEFAULT 'alloy'::character varying,
    model character varying(100) DEFAULT 'gpt-4o-realtime-preview'::character varying,
    temperature numeric(3,2) DEFAULT 0.8,
    max_response_output_tokens integer,
    tools jsonb DEFAULT '[]'::jsonb,
    knowledge_base jsonb DEFAULT '{}'::jsonb,
    escalation_config jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    welcome_greeting text,
    workflow_definition jsonb,
    published_workflow_definition jsonb,
    published_version integer,
    workflow_id character varying,
    execution_mode character varying(20) DEFAULT 'native'::character varying NOT NULL,
    remote_system character varying(60),
    remote_agent_id character varying(120),
    sync_mode character varying(30) DEFAULT 'event_push'::character varying,
    last_sync_at timestamp with time zone,
    scheduling_provider character varying(60),
    language character varying(8) DEFAULT 'en'::character varying NOT NULL,
    CONSTRAINT agents_execution_mode_check CHECK (((execution_mode)::text = ANY ((ARRAY['native'::character varying, 'federated'::character varying])::text[]))),
    CONSTRAINT agents_sync_mode_check CHECK (((sync_mode IS NULL) OR ((sync_mode)::text = ANY ((ARRAY['event_push'::character varying, 'pull'::character varying, 'bidirectional'::character varying])::text[]))))
);


--
-- Name: ai_insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_insights (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    category character varying(40) NOT NULL,
    title character varying(255) NOT NULL,
    description text NOT NULL,
    impact_estimate text,
    difficulty character varying(20) DEFAULT 'medium'::character varying,
    estimated_revenue_impact_cents integer,
    status character varying(20) DEFAULT 'new'::character varying NOT NULL,
    action_type character varying(60),
    action_payload jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    dismissed_at timestamp with time zone,
    accepted_at timestamp with time zone,
    accepted_by character varying(64),
    measured_impact jsonb,
    analysis_period_start timestamp with time zone,
    analysis_period_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: analytics_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_metrics (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    metric_name character varying(100) NOT NULL,
    metric_value numeric NOT NULL,
    dimensions jsonb DEFAULT '{}'::jsonb,
    recorded_at timestamp without time zone DEFAULT now()
);


--
-- Name: answering_service_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.answering_service_logs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    call_log_id character varying,
    caller_name character varying(255),
    caller_number character varying(20),
    message text,
    urgency character varying(20),
    callback_requested boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    name character varying(100) NOT NULL,
    key_hash character varying(64) NOT NULL,
    key_prefix character varying(12) NOT NULL,
    scopes jsonb DEFAULT '["*"]'::jsonb,
    last_used_at timestamp without time zone,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    revoked_at timestamp without time zone,
    permission_level character varying(20) DEFAULT 'read-only'::character varying,
    CONSTRAINT api_keys_permission_level_check CHECK (((permission_level)::text = ANY ((ARRAY['read-only'::character varying, 'write'::character varying, 'admin'::character varying])::text[])))
);


--
-- Name: appointment_scheduling_dispatch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointment_scheduling_dispatch (
    tenant_id character varying(255) NOT NULL,
    lookup_key character varying(500) NOT NULL,
    scheduling_provider character varying(60) NOT NULL,
    external_event_id character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assistant_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assistant_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    tenant_id character varying NOT NULL,
    action_type text NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb,
    result jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assistant_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assistant_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    user_id character varying NOT NULL,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    page_context text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    actor_user_id character varying,
    actor_role character varying(60),
    action character varying(100) NOT NULL,
    resource_type character varying(60) NOT NULL,
    resource_id character varying,
    changes jsonb DEFAULT '{}'::jsonb,
    ip_address inet,
    user_agent text,
    occurred_at timestamp without time zone DEFAULT now(),
    before_state jsonb,
    after_state jsonb,
    severity character varying(20) DEFAULT 'info'::character varying
);


--
-- Name: autopilot_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_actions (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    recommendation_id character varying(64),
    action_type character varying(60) NOT NULL,
    action_payload jsonb DEFAULT '{}'::jsonb,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    executed_at timestamp with time zone,
    completed_at timestamp with time zone,
    result jsonb DEFAULT '{}'::jsonb,
    error_message text,
    rollback_payload jsonb,
    rolled_back boolean DEFAULT false NOT NULL,
    rolled_back_at timestamp with time zone,
    rolled_back_by character varying(64),
    executed_by character varying(64),
    auto_executed boolean DEFAULT false NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: autopilot_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_approvals (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    recommendation_id character varying(64) NOT NULL,
    action character varying(20) NOT NULL,
    user_id character varying(64) NOT NULL,
    user_role character varying(40),
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: autopilot_impact_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_impact_reports (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    action_id character varying(64),
    recommendation_id character varying(64),
    report_type character varying(40) DEFAULT 'post_action'::character varying NOT NULL,
    metrics_before jsonb DEFAULT '{}'::jsonb,
    metrics_after jsonb DEFAULT '{}'::jsonb,
    measured_revenue_impact_cents integer,
    measured_cost_savings_cents integer,
    improvement_percentage double precision,
    assessment text,
    measurement_period_start timestamp with time zone,
    measurement_period_end timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: autopilot_insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_insights (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    run_id character varying(64),
    category character varying(60) NOT NULL,
    severity character varying(20) DEFAULT 'info'::character varying NOT NULL,
    title character varying(255) NOT NULL,
    description text NOT NULL,
    detected_signal text NOT NULL,
    data_evidence jsonb DEFAULT '{}'::jsonb,
    industry_pack character varying(40),
    confidence_score double precision DEFAULT 0.5 NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    resolved_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    analysis_period_start timestamp with time zone,
    analysis_period_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: autopilot_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_notifications (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    recommendation_id character varying(64),
    insight_id character varying(64),
    channel character varying(20) DEFAULT 'in_app'::character varying NOT NULL,
    severity character varying(20) DEFAULT 'info'::character varying NOT NULL,
    title character varying(255) NOT NULL,
    body text NOT NULL,
    read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    delivered boolean DEFAULT false NOT NULL,
    delivered_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: autopilot_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_policies (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    name character varying(120) NOT NULL,
    description text,
    risk_tier character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    action_type character varying(60) NOT NULL,
    requires_approval boolean DEFAULT true NOT NULL,
    approval_role character varying(40) DEFAULT 'admin'::character varying,
    auto_execute boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: autopilot_recommendations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_recommendations (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    insight_id character varying(64),
    run_id character varying(64),
    title character varying(255) NOT NULL,
    situation_summary text NOT NULL,
    recommended_action text NOT NULL,
    expected_outcome text NOT NULL,
    reasoning text NOT NULL,
    confidence_score double precision DEFAULT 0.5 NOT NULL,
    risk_tier character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    action_type character varying(60) NOT NULL,
    action_payload jsonb DEFAULT '{}'::jsonb,
    estimated_revenue_impact_cents integer,
    estimated_cost_savings_cents integer,
    status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    approved_by character varying(64),
    approved_at timestamp with time zone,
    rejected_by character varying(64),
    rejected_at timestamp with time zone,
    rejection_reason text,
    dismissed_by character varying(64),
    dismissed_at timestamp with time zone,
    expires_at timestamp with time zone,
    industry_pack character varying(40),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: autopilot_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_runs (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    run_type character varying(40) DEFAULT 'scheduled'::character varying NOT NULL,
    status character varying(20) DEFAULT 'running'::character varying NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    insights_detected integer DEFAULT 0 NOT NULL,
    recommendations_generated integer DEFAULT 0 NOT NULL,
    actions_auto_executed integer DEFAULT 0 NOT NULL,
    errors integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: billing_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_events (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    event_type public.billing_event_type NOT NULL,
    stripe_event_id character varying(60),
    amount_cents integer,
    currency character varying(3) DEFAULT 'usd'::character varying,
    description text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: billing_recommendation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_recommendation_events (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    event_type character varying(32) NOT NULL,
    current_tier character varying(32) NOT NULL,
    recommended_tier character varying(32) NOT NULL,
    monthly_savings_cents bigint,
    trailing_window_months integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    coupon_id character varying(255),
    promotion_code character varying(255),
    pitch character varying(32) DEFAULT 'tier-switch'::character varying NOT NULL,
    CONSTRAINT billing_recommendation_events_event_type_check CHECK (((event_type)::text = ANY ((ARRAY['impression'::character varying, 'click'::character varying, 'switch_completed'::character varying, 'discount_impression'::character varying, 'discount_click'::character varying, 'discount_switch_completed'::character varying])::text[]))),
    CONSTRAINT billing_recommendation_events_pitch_check CHECK (((pitch)::text = ANY ((ARRAY['tier-switch'::character varying, 'annual-only'::character varying])::text[])))
);


--
-- Name: bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    title character varying(500) NOT NULL,
    description text DEFAULT ''::text,
    start_time timestamp with time zone NOT NULL,
    end_time timestamp with time zone NOT NULL,
    status character varying(30) DEFAULT 'confirmed'::character varying NOT NULL,
    contact_name character varying(255) DEFAULT ''::character varying,
    contact_phone character varying(50) DEFAULT ''::character varying,
    contact_email character varying(255) DEFAULT ''::character varying,
    agent_id character varying(255),
    created_by character varying(255),
    notes text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_id character varying(255),
    appointment_type_id character varying(255),
    resource_id character varying(255),
    recurring_series_id character varying(255) DEFAULT NULL::character varying,
    cancellation_reason text DEFAULT ''::text,
    checked_in_at timestamp with time zone,
    completed_at timestamp with time zone,
    intake_data jsonb DEFAULT '{}'::jsonb,
    timezone character varying(50) DEFAULT 'America/New_York'::character varying,
    location character varying(255) DEFAULT ''::character varying,
    booking_source character varying(30) DEFAULT 'manual'::character varying,
    CONSTRAINT bookings_booking_source_check CHECK (((booking_source)::text = ANY ((ARRAY['manual'::character varying, 'self_schedule'::character varying, 'ai_agent'::character varying, 'phone'::character varying, 'api'::character varying])::text[]))),
    CONSTRAINT bookings_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'cancelled'::character varying, 'completed'::character varying, 'no_show'::character varying, 'checked_in'::character varying, 'rescheduled'::character varying])::text[])))
);


--
-- Name: call_conversion_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_conversion_stages (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    stage text NOT NULL,
    reached_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: call_csat_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_csat_responses (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    request_channel character varying(16) NOT NULL,
    response_channel character varying(16),
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    score_scale integer,
    score_raw numeric(4,2),
    score_normalized numeric(4,3),
    comment text,
    raw_response text,
    dispatch_to text,
    dispatch_token character varying(64),
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT call_csat_responses_request_channel_check CHECK (((request_channel)::text = ANY ((ARRAY['sms'::character varying, 'ivr'::character varying, 'web'::character varying, 'email'::character varying])::text[]))),
    CONSTRAINT call_csat_responses_response_channel_check CHECK (((response_channel IS NULL) OR ((response_channel)::text = ANY ((ARRAY['sms'::character varying, 'ivr'::character varying, 'web'::character varying, 'email'::character varying])::text[])))),
    CONSTRAINT call_csat_responses_score_normalized_check CHECK (((score_normalized IS NULL) OR ((score_normalized >= (0)::numeric) AND (score_normalized <= (1)::numeric)))),
    CONSTRAINT call_csat_responses_score_raw_check CHECK (((score_raw IS NULL) OR (score_raw >= (0)::numeric))),
    CONSTRAINT call_csat_responses_score_scale_check CHECK (((score_scale IS NULL) OR ((score_scale >= 2) AND (score_scale <= 10)))),
    CONSTRAINT call_csat_responses_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'responded'::character varying, 'expired'::character varying, 'failed'::character varying, 'opted_out'::character varying])::text[])))
);


--
-- Name: call_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_events (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    event_type character varying(60) NOT NULL,
    from_state public.call_lifecycle_state,
    to_state public.call_lifecycle_state,
    payload jsonb DEFAULT '{}'::jsonb,
    occurred_at timestamp without time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (occurred_at);


--
-- Name: call_events_2026_03; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_events_2026_03 (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    event_type character varying(60) NOT NULL,
    from_state public.call_lifecycle_state,
    to_state public.call_lifecycle_state,
    payload jsonb DEFAULT '{}'::jsonb,
    occurred_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: call_events_2026_04; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_events_2026_04 (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    event_type character varying(60) NOT NULL,
    from_state public.call_lifecycle_state,
    to_state public.call_lifecycle_state,
    payload jsonb DEFAULT '{}'::jsonb,
    occurred_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: call_events_2026_05; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_events_2026_05 (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    event_type character varying(60) NOT NULL,
    from_state public.call_lifecycle_state,
    to_state public.call_lifecycle_state,
    payload jsonb DEFAULT '{}'::jsonb,
    occurred_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: call_events_2026_06; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_events_2026_06 (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    event_type character varying(60) NOT NULL,
    from_state public.call_lifecycle_state,
    to_state public.call_lifecycle_state,
    payload jsonb DEFAULT '{}'::jsonb,
    occurred_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: call_events_retention_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_events_retention_runs (
    id bigint NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text NOT NULL,
    retention_days integer NOT NULL,
    ensured_partitions text[] DEFAULT ARRAY[]::text[] NOT NULL,
    dropped_partitions text[] DEFAULT ARRAY[]::text[] NOT NULL,
    error_message text,
    CONSTRAINT call_events_retention_runs_status_check CHECK ((status = ANY (ARRAY['success'::text, 'failure'::text])))
);


--
-- Name: call_events_retention_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.call_events_retention_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: call_events_retention_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.call_events_retention_runs_id_seq OWNED BY public.call_events_retention_runs.id;


--
-- Name: call_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_logs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    agent_id character varying,
    call_sid character varying(50),
    direction character varying(10) DEFAULT 'inbound'::character varying,
    caller_number character varying(20),
    called_number character varying(20),
    status character varying(30),
    duration_seconds integer,
    cost_cents integer,
    summary text,
    sentiment character varying(20),
    escalated boolean DEFAULT false,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: call_quality_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_quality_scores (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    score double precision NOT NULL,
    feedback jsonb DEFAULT '{}'::jsonb,
    scored_by character varying(100) DEFAULT 'gpt-4o-mini'::character varying NOT NULL,
    scored_at timestamp without time zone DEFAULT now()
);


--
-- Name: call_saved_view_pins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_saved_view_pins (
    user_id character varying(255) NOT NULL,
    view_id character varying(255) NOT NULL,
    tenant_id character varying(255) NOT NULL,
    pin_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: call_saved_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_saved_views (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_shared boolean DEFAULT false NOT NULL,
    created_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    digest_enabled boolean DEFAULT false NOT NULL,
    digest_subscribers text[] DEFAULT '{}'::text[] NOT NULL,
    digest_last_run_at timestamp with time zone,
    digest_last_match_count integer
);


--
-- Name: call_sentiment_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_sentiment_scores (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    sentiment_score double precision NOT NULL,
    sentiment_label text DEFAULT 'neutral'::text NOT NULL,
    confidence double precision DEFAULT 0.0 NOT NULL,
    details jsonb DEFAULT '{}'::jsonb,
    scored_by text DEFAULT 'gpt-4o-mini'::text NOT NULL,
    scored_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: call_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_sessions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    agent_id character varying,
    call_sid character varying(50),
    session_id character varying(100),
    direction character varying(10) DEFAULT 'inbound'::character varying NOT NULL,
    caller_number character varying(20),
    called_number character varying(20),
    lifecycle_state public.call_lifecycle_state DEFAULT 'CALL_RECEIVED'::public.call_lifecycle_state NOT NULL,
    workflow_id character varying,
    context jsonb DEFAULT '{}'::jsonb,
    escalation_target character varying,
    escalation_reason text,
    start_time timestamp without time zone DEFAULT now(),
    end_time timestamp without time zone,
    duration_seconds integer,
    total_cost_cents integer,
    environment character varying(20) DEFAULT 'production'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    call_id character varying(50),
    sentiment_score double precision,
    has_tool_failure boolean DEFAULT false,
    escalated boolean DEFAULT false,
    external_id character varying(255),
    stir_status character varying(32),
    stir_verstat character varying(64),
    stir_attestation character(1),
    language character varying(8),
    CONSTRAINT call_sessions_stir_attestation_chk CHECK (((stir_attestation IS NULL) OR (stir_attestation = ANY (ARRAY['A'::bpchar, 'B'::bpchar, 'C'::bpchar]))))
);


--
-- Name: call_topic_classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_topic_classifications (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    primary_topic text NOT NULL,
    secondary_topics text[] DEFAULT '{}'::text[],
    confidence double precision DEFAULT 0.0 NOT NULL,
    details jsonb DEFAULT '{}'::jsonb,
    classified_by text DEFAULT 'gpt-4o-mini'::text NOT NULL,
    classified_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: call_transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_transcripts (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    role character varying(20) NOT NULL,
    content text NOT NULL,
    sequence_number integer DEFAULT 0 NOT NULL,
    occurred_at timestamp without time zone DEFAULT now()
);


--
-- Name: callback_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.callback_queue (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    phone_number character varying(20) NOT NULL,
    agent_id character varying,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    priority integer DEFAULT 0,
    notes text,
    scheduled_at timestamp without time zone,
    attempted_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: campaign_contact_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_contact_attempts (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    campaign_contact_id character varying NOT NULL,
    call_sid character varying(50),
    status character varying(30),
    duration_seconds integer,
    notes text,
    attempted_at timestamp without time zone DEFAULT now()
);


--
-- Name: campaign_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_contacts (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    campaign_id character varying NOT NULL,
    phone_number character varying(20) NOT NULL,
    name character varying(255),
    status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    outcome character varying(30),
    attempt_count integer DEFAULT 0 NOT NULL,
    last_attempted_at timestamp without time zone
);


--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    agent_id character varying,
    name character varying(255) NOT NULL,
    type character varying(50) DEFAULT 'outbound_call'::character varying NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    scheduled_at timestamp without time zone,
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    quiet_hours_skips bigint DEFAULT 0 NOT NULL
);


--
-- Name: case_studies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_studies (
    id character varying DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying NOT NULL,
    milestone_type character varying(50) NOT NULL,
    milestone_value integer NOT NULL,
    industry character varying(100) DEFAULT 'general'::character varying NOT NULL,
    company_size character varying(50) DEFAULT 'small'::character varying NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    public_slug character varying(200),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: changelog_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.changelog_entries (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    title character varying(200) NOT NULL,
    body text NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    published_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: changelog_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.changelog_reads (
    user_id character varying NOT NULL,
    entry_id character varying NOT NULL,
    read_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: connector_alert_mutes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_alert_mutes (
    tenant_id character varying NOT NULL,
    scope character varying(16) NOT NULL,
    target character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    created_by character varying,
    CONSTRAINT connector_alert_mutes_scope_check CHECK (((scope)::text = ANY ((ARRAY['provider'::character varying, 'integration'::character varying])::text[])))
);


--
-- Name: connector_alert_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_alert_recipients (
    id bigint NOT NULL,
    tenant_id character varying NOT NULL,
    integration_id character varying NOT NULL,
    dispatch_id character varying(64) NOT NULL,
    notification_type text NOT NULL,
    channel text NOT NULL,
    dispatched_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id character varying,
    recipient_name text,
    recipient_email text,
    recipient_phone text,
    delivery_status text NOT NULL,
    delivery_error text,
    twilio_status_code integer,
    twilio_message_sid character varying(64),
    twilio_message_status text,
    twilio_error_code integer,
    delivery_status_updated_at timestamp with time zone,
    email_message_id character varying(512),
    email_provider_event text
);


--
-- Name: connector_alert_recipients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.connector_alert_recipients_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: connector_alert_recipients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.connector_alert_recipients_id_seq OWNED BY public.connector_alert_recipients.id;


--
-- Name: connector_alert_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_alert_settings (
    tenant_id character varying NOT NULL,
    digest_mode boolean DEFAULT false NOT NULL,
    digest_last_sent_at timestamp without time zone,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_by character varying
);


--
-- Name: connector_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_configs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    integration_id character varying NOT NULL,
    config_key character varying(100) NOT NULL,
    encrypted_value text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: connector_stale_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_stale_alerts (
    id bigint NOT NULL,
    tenant_id character varying(64) NOT NULL,
    integration_id character varying(64) NOT NULL,
    last_provider character varying(80),
    last_status character varying(40),
    first_alerted_at timestamp with time zone DEFAULT now() NOT NULL,
    last_alerted_at timestamp with time zone DEFAULT now() NOT NULL,
    alert_count integer DEFAULT 1 NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: connector_stale_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.connector_stale_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: connector_stale_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.connector_stale_alerts_id_seq OWNED BY public.connector_stale_alerts.id;


--
-- Name: conversation_costs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_costs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    stt_cost_cents integer DEFAULT 0 NOT NULL,
    llm_cost_cents integer DEFAULT 0 NOT NULL,
    tts_cost_cents integer DEFAULT 0 NOT NULL,
    infra_cost_cents integer DEFAULT 0 NOT NULL,
    total_cost_cents integer DEFAULT 0 NOT NULL,
    model_tier public.model_tier DEFAULT 'standard'::public.model_tier NOT NULL,
    model_used character varying(100),
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cache_hits integer DEFAULT 0 NOT NULL,
    cache_misses integer DEFAULT 0 NOT NULL,
    prompt_tokens_saved integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: cost_budget_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_budget_settings (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    max_cost_per_conversation_cents integer DEFAULT 500 NOT NULL,
    alert_threshold_percent integer DEFAULT 80 NOT NULL,
    auto_downgrade_model boolean DEFAULT true NOT NULL,
    auto_end_call boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: crm_caller_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_caller_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(64) NOT NULL,
    provider character varying(50) NOT NULL,
    phone_e164 character varying(32) NOT NULL,
    contact_id character varying(255),
    account_id character varying(255),
    opportunity_id character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    extras jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_validated_at timestamp with time zone
);


--
-- Name: crm_stale_cache_scrubs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_stale_cache_scrubs (
    id bigint NOT NULL,
    tenant_id character varying NOT NULL,
    provider character varying(64) NOT NULL,
    caller_phone character varying(32) NOT NULL,
    stale_ids jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_stale_cache_scrubs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_stale_cache_scrubs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crm_stale_cache_scrubs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crm_stale_cache_scrubs_id_seq OWNED BY public.crm_stale_cache_scrubs.id;


--
-- Name: daily_openai_costs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_openai_costs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    date date NOT NULL,
    model character varying(100),
    input_tokens integer DEFAULT 0,
    output_tokens integer DEFAULT 0,
    cost_cents integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: daily_org_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_org_usage (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    date date NOT NULL,
    total_calls integer DEFAULT 0,
    total_sms integer DEFAULT 0,
    total_ai_minutes integer DEFAULT 0,
    total_cost_cents integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: daily_reconciliation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_reconciliation (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    date date NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    discrepancies jsonb DEFAULT '[]'::jsonb,
    reconciled_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: demo_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demo_agents (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    agent_template character varying(60) NOT NULL,
    voice_id character varying(60),
    persona jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: demo_analytics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demo_analytics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    agent_type text,
    ip_hash text NOT NULL,
    duration_seconds integer,
    cta_type text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: demo_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.demo_sessions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    demo_agent_id character varying NOT NULL,
    visitor_id character varying(100),
    call_session_id character varying,
    channel character varying(20) DEFAULT 'web'::character varying,
    duration_seconds integer,
    converted boolean DEFAULT false NOT NULL,
    feedback jsonb DEFAULT '{}'::jsonb,
    started_at timestamp without time zone DEFAULT now(),
    ended_at timestamp without time zone
);


--
-- Name: developer_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.developer_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    developer_id text NOT NULL,
    developer_name text NOT NULL,
    developer_email text NOT NULL,
    package_name text NOT NULL,
    package_slug text NOT NULL,
    marketplace_category public.marketplace_category DEFAULT 'vertical_agent'::public.marketplace_category NOT NULL,
    description text NOT NULL,
    short_description text,
    version text DEFAULT '1.0.0'::text NOT NULL,
    price_model public.price_model DEFAULT 'free'::public.price_model,
    price_cents integer DEFAULT 0,
    manifest jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.submission_status DEFAULT 'draft'::public.submission_status,
    review_notes text,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    template_id character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: digital_twin_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.digital_twin_models (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    name text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'building'::text NOT NULL,
    snapshot_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    data_range_start timestamp with time zone,
    data_range_end timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    is_simulation boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: digital_twin_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.digital_twin_results (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    run_id character varying NOT NULL,
    result_type text DEFAULT 'operational'::text NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    comparison_baseline jsonb DEFAULT '{}'::jsonb,
    summary text,
    is_simulation boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    recommendation_id character varying,
    conversation_quality jsonb,
    validation_outcome jsonb
);


--
-- Name: digital_twin_scenarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.digital_twin_scenarios (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying DEFAULT '__system__'::character varying NOT NULL,
    name text NOT NULL,
    description text,
    category text DEFAULT 'custom'::text NOT NULL,
    scenario_type text DEFAULT 'operational'::text NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_predefined boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: digital_twin_simulation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.digital_twin_simulation_runs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    model_id character varying NOT NULL,
    scenario_id character varying NOT NULL,
    name text,
    status text DEFAULT 'pending'::text NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_simulation boolean DEFAULT true NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_assignment_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_assignment_rules (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description text DEFAULT ''::text,
    rule_type character varying(50) DEFAULT 'auto_assign'::character varying NOT NULL,
    priority integer DEFAULT 0,
    conditions jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dispatch_assignment_rules_rule_type_check CHECK (((rule_type)::text = ANY ((ARRAY['auto_assign'::character varying, 'round_robin'::character varying, 'skill_match'::character varying, 'territory_match'::character varying, 'capacity_based'::character varying])::text[])))
);


--
-- Name: dispatch_job_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_job_attachments (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    job_id character varying(255) NOT NULL,
    tenant_id character varying(255) NOT NULL,
    attachment_type character varying(50) DEFAULT 'note'::character varying NOT NULL,
    title character varying(255) DEFAULT ''::character varying,
    content text DEFAULT ''::text,
    file_url character varying(1000) DEFAULT NULL::character varying,
    uploaded_by character varying(255) DEFAULT NULL::character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mime_type character varying(100) DEFAULT NULL::character varying,
    file_size_bytes bigint,
    object_path character varying(1000) DEFAULT NULL::character varying,
    CONSTRAINT dispatch_job_attachments_attachment_type_check CHECK (((attachment_type)::text = ANY ((ARRAY['note'::character varying, 'photo'::character varying, 'document'::character varying, 'signature'::character varying, 'proof_of_service'::character varying, 'proof_of_completion'::character varying])::text[])))
);


--
-- Name: dispatch_job_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_job_events (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    job_id character varying(255) NOT NULL,
    tenant_id character varying(255) NOT NULL,
    event_type character varying(50) NOT NULL,
    from_status character varying(30) DEFAULT NULL::character varying,
    to_status character varying(30) DEFAULT NULL::character varying,
    performed_by character varying(255) DEFAULT NULL::character varying,
    notes text DEFAULT ''::text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_job_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_job_exceptions (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    job_id character varying(255) NOT NULL,
    tenant_id character varying(255) NOT NULL,
    exception_type character varying(50) NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    resolution text DEFAULT ''::text,
    resolved_at timestamp with time zone,
    reported_by character varying(255) DEFAULT NULL::character varying,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dispatch_job_exceptions_exception_type_check CHECK (((exception_type)::text = ANY ((ARRAY['delay'::character varying, 'no_access'::character varying, 'cancelled'::character varying, 'reschedule'::character varying, 'return_visit'::character varying, 'reassignment'::character varying, 'other'::character varying])::text[])))
);


--
-- Name: dispatch_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_jobs (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    title character varying(500) NOT NULL,
    description text DEFAULT ''::text,
    status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    assignee_user_id character varying(255),
    contact_id character varying(255) DEFAULT NULL::character varying,
    contact_name character varying(255) DEFAULT ''::character varying,
    scheduled_at timestamp with time zone,
    completed_at timestamp with time zone,
    notes text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    territory_id character varying(255),
    resource_id character varying(255),
    job_type character varying(100) DEFAULT 'general'::character varying,
    estimated_duration_minutes integer,
    actual_duration_minutes integer,
    eta_start timestamp with time zone,
    eta_end timestamp with time zone,
    address text DEFAULT ''::text,
    contact_phone character varying(50) DEFAULT ''::character varying,
    contact_email character varying(255) DEFAULT ''::character varying,
    parent_job_id character varying(255),
    is_follow_up boolean DEFAULT false,
    required_skills text[] DEFAULT '{}'::text[],
    metadata jsonb DEFAULT '{}'::jsonb,
    address_lat numeric(10,7),
    address_lon numeric(10,7),
    address_geocoded_at timestamp with time zone,
    address_geocoded_for text,
    tracking_token text DEFAULT (gen_random_uuid())::text NOT NULL,
    CONSTRAINT dispatch_jobs_priority_check CHECK (((priority)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'urgent'::character varying])::text[]))),
    CONSTRAINT dispatch_jobs_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'assigned'::character varying, 'scheduled'::character varying, 'en_route'::character varying, 'on_site'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'incomplete'::character varying, 'cancelled'::character varying, 'done'::character varying])::text[])))
);


--
-- Name: dispatch_notification_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_notification_templates (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    trigger_event character varying(100) NOT NULL,
    channel character varying(30) DEFAULT 'sms'::character varying NOT NULL,
    subject character varying(500) DEFAULT ''::character varying,
    body_template text DEFAULT ''::text NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dispatch_notification_templates_channel_check CHECK (((channel)::text = ANY ((ARRAY['sms'::character varying, 'email'::character varying, 'both'::character varying])::text[])))
);


--
-- Name: dispatch_notifications_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_notifications_log (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    job_id character varying(255),
    tenant_id character varying(255) NOT NULL,
    template_id character varying(255),
    channel character varying(30) NOT NULL,
    recipient character varying(255) NOT NULL,
    subject character varying(500) DEFAULT ''::character varying,
    body text DEFAULT ''::text,
    status character varying(20) DEFAULT 'sent'::character varying NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_resource_location_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_resource_location_history (
    id bigint NOT NULL,
    resource_id character varying(255) NOT NULL,
    tenant_id character varying(255) NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    accuracy_m double precision,
    heading_deg double precision,
    speed_mps double precision,
    active_job_id character varying(255),
    recorded_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_resource_location_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dispatch_resource_location_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dispatch_resource_location_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dispatch_resource_location_history_id_seq OWNED BY public.dispatch_resource_location_history.id;


--
-- Name: dispatch_resource_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_resource_locations (
    resource_id character varying(255) NOT NULL,
    tenant_id character varying(255) NOT NULL,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    accuracy_m double precision,
    heading_deg double precision,
    speed_mps double precision,
    active_job_id character varying(255),
    active_status character varying(30),
    recorded_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_resource_pairing_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_resource_pairing_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    resource_id character varying(255) NOT NULL,
    code_hash text NOT NULL,
    issued_by_user character varying(255),
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    consumed_device character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_resource_skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_resource_skills (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    resource_id character varying(255) NOT NULL,
    skill_type_id character varying(255) NOT NULL,
    proficiency_level integer DEFAULT 1,
    certified_at timestamp with time zone,
    expires_at timestamp with time zone,
    CONSTRAINT dispatch_resource_skills_proficiency_level_check CHECK (((proficiency_level >= 1) AND (proficiency_level <= 5)))
);


--
-- Name: dispatch_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_resources (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    user_id character varying(255),
    name character varying(255) NOT NULL,
    email character varying(255) DEFAULT ''::character varying,
    phone character varying(50) DEFAULT ''::character varying,
    role character varying(50) DEFAULT 'field_worker'::character varying NOT NULL,
    territory_id character varying(255),
    shift_start time without time zone DEFAULT '08:00:00'::time without time zone,
    shift_end time without time zone DEFAULT '17:00:00'::time without time zone,
    shift_days integer[] DEFAULT '{1,2,3,4,5}'::integer[],
    max_concurrent_jobs integer DEFAULT 3,
    current_status character varying(30) DEFAULT 'available'::character varying NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dispatch_resources_current_status_check CHECK (((current_status)::text = ANY ((ARRAY['available'::character varying, 'busy'::character varying, 'on_break'::character varying, 'off_shift'::character varying, 'unavailable'::character varying])::text[])))
);


--
-- Name: dispatch_route_export_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_route_export_jobs (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    requested_by_user_id character varying(255),
    requested_by_email text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    format text DEFAULT 'gpx'::text NOT NULL,
    include_empty boolean DEFAULT true NOT NULL,
    selection jsonb DEFAULT '{}'::jsonb NOT NULL,
    job_count integer,
    included_count integer,
    skipped_empty integer,
    archive_object_path text,
    archive_filename text,
    archive_bytes bigint,
    download_token text,
    download_expires_at timestamp with time zone,
    error_message text,
    email_sent_at timestamp with time zone,
    email_message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT dispatch_route_export_jobs_format_check CHECK ((format = ANY (ARRAY['gpx'::text, 'csv'::text]))),
    CONSTRAINT dispatch_route_export_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'ready'::text, 'failed'::text])))
);


--
-- Name: dispatch_skill_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_skill_types (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description text DEFAULT ''::text,
    category character varying(100) DEFAULT 'general'::character varying,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dispatch_territories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_territories (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description text DEFAULT ''::text,
    region character varying(255) DEFAULT ''::character varying,
    zip_codes text[] DEFAULT '{}'::text[],
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: distributed_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.distributed_locks (
    lock_name character varying(255) NOT NULL,
    tenant_id character varying,
    holder_id character varying(100),
    acquired_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL
);


--
-- Name: dnc_list; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dnc_list (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    phone_number character varying(20) NOT NULL,
    reason text,
    source character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: docs_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.docs_feedback (
    id integer NOT NULL,
    article_slug character varying(128) NOT NULL,
    vote character varying(16) NOT NULL,
    comment text,
    page_path text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(16) DEFAULT 'new'::character varying NOT NULL,
    status_updated_at timestamp with time zone,
    status_updated_by character varying(128),
    reply_email character varying(320),
    reply_count integer DEFAULT 0 NOT NULL,
    pending_reply_alerted_at timestamp with time zone,
    CONSTRAINT docs_feedback_status_check CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'resolved'::character varying, 'hidden'::character varying])::text[])))
);


--
-- Name: docs_feedback_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.docs_feedback_alerts (
    article_slug character varying(128) NOT NULL,
    last_alerted_at timestamp with time zone DEFAULT now() NOT NULL,
    last_total_votes integer DEFAULT 0 NOT NULL,
    last_not_helpful_count integer DEFAULT 0 NOT NULL,
    last_helpful_ratio integer,
    last_reason character varying(64),
    alert_count integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: docs_feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.docs_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: docs_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.docs_feedback_id_seq OWNED BY public.docs_feedback.id;


--
-- Name: docs_feedback_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.docs_feedback_replies (
    id integer NOT NULL,
    feedback_id integer NOT NULL,
    sent_by character varying(256),
    to_email character varying(320) NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    email_message_id text,
    email_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    digest_notified_at timestamp with time zone,
    retry_of integer,
    retry_count integer DEFAULT 0 NOT NULL,
    last_retry_at timestamp with time zone,
    retry_skipped_reason text
);


--
-- Name: docs_feedback_replies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.docs_feedback_replies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: docs_feedback_replies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.docs_feedback_replies_id_seq OWNED BY public.docs_feedback_replies.id;


--
-- Name: encrypted_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encrypted_fields (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    table_name character varying(100) NOT NULL,
    column_name character varying(100) NOT NULL,
    encryption_key_id character varying,
    encrypted_at timestamp without time zone DEFAULT now()
);


--
-- Name: encryption_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encryption_keys (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    key_alias character varying(100) NOT NULL,
    encrypted_dek text NOT NULL,
    algorithm character varying(30) DEFAULT 'aes-256-gcm'::character varying,
    is_active boolean DEFAULT true,
    rotated_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: error_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.error_logs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    severity public.error_severity DEFAULT 'error'::public.error_severity NOT NULL,
    service character varying(100),
    error_code character varying(100),
    message text NOT NULL,
    stack_trace text,
    context jsonb DEFAULT '{}'::jsonb,
    call_session_id character varying,
    resolved_at timestamp without time zone,
    occurred_at timestamp without time zone DEFAULT now()
);


--
-- Name: escalation_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.escalation_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    call_session_id text NOT NULL,
    agent_slug text,
    caller_phone text,
    reason text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    assigned_to text,
    notes text,
    tool_name text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: evolution_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evolution_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type character varying(100) NOT NULL,
    entity_id uuid NOT NULL,
    action character varying(100) NOT NULL,
    old_value jsonb,
    new_value jsonb,
    performed_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: evolution_opportunities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evolution_opportunities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    opportunity_type public.evolution_opportunity_type NOT NULL,
    title character varying(500) NOT NULL,
    description text,
    status character varying(50) DEFAULT 'active'::character varying,
    customer_demand_score double precision DEFAULT 0,
    revenue_potential_score double precision DEFAULT 0,
    strategic_fit_score double precision DEFAULT 0,
    development_effort_score double precision DEFAULT 0,
    retention_impact_score double precision DEFAULT 0,
    differentiation_score double precision DEFAULT 0,
    composite_score double precision DEFAULT 0,
    signal_count integer DEFAULT 0,
    affected_tenant_count integer DEFAULT 0,
    evidence jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    first_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_signal_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: evolution_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evolution_signals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source public.evolution_signal_source NOT NULL,
    signal_type character varying(100) NOT NULL,
    title character varying(500) NOT NULL,
    description text,
    tenant_id character varying(255),
    strength double precision DEFAULT 1.0,
    raw_data jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    collected_at timestamp with time zone DEFAULT now() NOT NULL,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: execution_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.execution_traces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    call_session_id character varying NOT NULL,
    trace_type character varying(50) NOT NULL,
    step_name character varying(255) NOT NULL,
    sequence_number integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    duration_ms integer,
    input_data jsonb,
    output_data jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    parent_trace_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: experiment_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.experiment_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    experiment_name character varying(500) NOT NULL,
    experiment_type character varying(100) NOT NULL,
    state public.evolution_experiment_state DEFAULT 'draft'::public.evolution_experiment_state,
    hypothesis text,
    description text,
    pilot_tenant_ids jsonb DEFAULT '[]'::jsonb,
    config jsonb DEFAULT '{}'::jsonb,
    success_criteria jsonb DEFAULT '{}'::jsonb,
    results jsonb DEFAULT '{}'::jsonb,
    opportunity_id uuid,
    started_at timestamp with time zone,
    concluded_at timestamp with time zone,
    created_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feature_request_clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_request_clusters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cluster_name character varying(500) NOT NULL,
    description text,
    request_count integer DEFAULT 0,
    unique_tenant_count integer DEFAULT 0,
    representative_requests jsonb DEFAULT '[]'::jsonb,
    opportunity_id uuid,
    trend character varying(50) DEFAULT 'stable'::character varying,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: federal_dnc_numbers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federal_dnc_numbers (
    phone_number character varying(20) NOT NULL,
    registry_version character varying(64) NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: federal_dnc_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federal_dnc_sync_state (
    id integer DEFAULT 1 NOT NULL,
    last_sync_started_at timestamp with time zone,
    last_sync_completed_at timestamp with time zone,
    last_registry_version character varying(64),
    last_record_count integer,
    last_status character varying(20),
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT federal_dnc_sync_state_id_check CHECK ((id = 1))
);


--
-- Name: forecast_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forecast_models (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    model_id character varying,
    forecast_type text NOT NULL,
    horizon_days integer DEFAULT 30 NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    projections jsonb DEFAULT '[]'::jsonb NOT NULL,
    confidence_level double precision DEFAULT 0.8 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    is_simulation boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gdpr_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gdpr_requests (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    request_type character varying(30) NOT NULL,
    subject_email character varying(255) NOT NULL,
    subject_user_id character varying,
    status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    requested_by character varying,
    result_data jsonb,
    completed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT gdpr_requests_request_type_check CHECK (((request_type)::text = ANY ((ARRAY['export'::character varying, 'erasure'::character varying])::text[]))),
    CONSTRAINT gdpr_requests_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: gin_aggregation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gin_aggregation_runs (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    run_type character varying(40) NOT NULL,
    status character varying(20) DEFAULT 'running'::character varying NOT NULL,
    tenants_processed integer DEFAULT 0 NOT NULL,
    signals_collected integer DEFAULT 0 NOT NULL,
    patterns_detected integer DEFAULT 0 NOT NULL,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: gin_policy_acceptance_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gin_policy_acceptance_records (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    action character varying(20) NOT NULL,
    policy_version character varying(20) DEFAULT '1.0'::character varying NOT NULL,
    accepted_by character varying(64),
    ip_address character varying(45),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: global_insight_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.global_insight_patterns (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    pattern_type character varying(60) NOT NULL,
    title character varying(255) NOT NULL,
    description text NOT NULL,
    industry_vertical character varying(60),
    confidence_score numeric(4,3) DEFAULT 0.5 NOT NULL,
    sample_size integer DEFAULT 0 NOT NULL,
    impact_estimate text,
    metadata jsonb DEFAULT '{}'::jsonb,
    aggregation_run_id character varying(64),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: global_prompt_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.global_prompt_patterns (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    prompt_category character varying(60) NOT NULL,
    industry_vertical character varying(60),
    pattern_description text NOT NULL,
    example_prompt text,
    effectiveness_score numeric(4,3) DEFAULT 0.5 NOT NULL,
    sample_size integer DEFAULT 0 NOT NULL,
    conversion_rate_avg numeric(5,4),
    avg_call_duration_seconds numeric(8,2),
    metadata jsonb DEFAULT '{}'::jsonb,
    aggregation_run_id character varying(64),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: handoff_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.handoff_states (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    call_sid character varying(50) NOT NULL,
    agent_id character varying,
    state character varying(50) NOT NULL,
    context jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: improvement_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.improvement_metrics (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    agent_id character varying NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    suggestions_generated integer DEFAULT 0 NOT NULL,
    suggestions_accepted integer DEFAULT 0 NOT NULL,
    suggestions_dismissed integer DEFAULT 0 NOT NULL,
    avg_quality_before numeric(4,2),
    avg_quality_after numeric(4,2),
    quality_delta numeric(4,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: industry_benchmarks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.industry_benchmarks (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    industry_vertical character varying(60) NOT NULL,
    metric_name character varying(80) NOT NULL,
    metric_value numeric(12,4) NOT NULL,
    sample_size integer DEFAULT 0 NOT NULL,
    percentile_25 numeric(12,4),
    percentile_50 numeric(12,4),
    percentile_75 numeric(12,4),
    period_start date NOT NULL,
    period_end date NOT NULL,
    aggregation_run_id character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ingest_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_events (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    org_id character varying NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    event_type character varying(60) NOT NULL,
    event_version character varying(10) DEFAULT 'v1'::character varying NOT NULL,
    source character varying(60) DEFAULT 'remix'::character varying NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'received'::character varying NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT ingest_events_status_check CHECK (((status)::text = ANY ((ARRAY['received'::character varying, 'processed'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: integration_demand_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_demand_scores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    integration_name character varying(255) NOT NULL,
    category character varying(100),
    demand_score double precision DEFAULT 0,
    request_count integer DEFAULT 0,
    unique_tenant_count integer DEFAULT 0,
    search_frequency integer DEFAULT 0,
    competitor_has boolean DEFAULT false,
    estimated_revenue_impact_cents bigint DEFAULT 0,
    opportunity_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: integration_event_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_event_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying(255) NOT NULL,
    call_session_id character varying,
    tool_invocation_id character varying,
    request_method character varying(10) DEFAULT 'POST'::character varying NOT NULL,
    request_url text NOT NULL,
    request_headers jsonb DEFAULT '{}'::jsonb,
    request_body jsonb,
    response_status integer,
    response_body jsonb,
    response_headers jsonb DEFAULT '{}'::jsonb,
    latency_ms integer,
    error_message text,
    service_name character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integrations (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    name character varying(100) NOT NULL,
    integration_type public.integration_type NOT NULL,
    provider character varying(60) NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    fallback_connector_type text,
    fallback_provider text,
    last_sync_at timestamp without time zone,
    last_sync_status character varying(20),
    last_sync_error text,
    last_sync_error_at timestamp without time zone,
    auth_alert_sent_at timestamp without time zone,
    recovery_alert_sent_at timestamp without time zone,
    auto_disabled_at timestamp without time zone,
    expiry_warning_sent_at timestamp with time zone
);


--
-- Name: knowledge_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_articles (
    id integer NOT NULL,
    tenant_id character varying NOT NULL,
    title character varying(500) NOT NULL,
    content text NOT NULL,
    category character varying(100),
    metadata jsonb DEFAULT '{}'::jsonb,
    embedding jsonb,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: knowledge_articles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knowledge_articles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_articles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knowledge_articles_id_seq OWNED BY public.knowledge_articles.id;


--
-- Name: knowledge_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_chunks (
    id integer NOT NULL,
    tenant_id character varying NOT NULL,
    document_id integer NOT NULL,
    chunk_index integer NOT NULL,
    content text NOT NULL,
    embedding jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: knowledge_chunks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knowledge_chunks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_chunks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knowledge_chunks_id_seq OWNED BY public.knowledge_chunks.id;


--
-- Name: knowledge_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_documents (
    id integer NOT NULL,
    tenant_id character varying NOT NULL,
    title character varying(500) NOT NULL,
    source_type character varying(20) NOT NULL,
    source_url text,
    raw_content text,
    raw_file bytea,
    category character varying(100),
    status character varying(20) DEFAULT 'processing'::character varying NOT NULL,
    error_message text,
    file_name character varying(500),
    file_size integer,
    chunk_count integer DEFAULT 0,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT knowledge_documents_source_type_check CHECK (((source_type)::text = ANY ((ARRAY['pdf'::character varying, 'url'::character varying, 'text'::character varying, 'faq'::character varying])::text[]))),
    CONSTRAINT knowledge_documents_status_check CHECK (((status)::text = ANY ((ARRAY['processing'::character varying, 'ready'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: knowledge_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knowledge_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knowledge_documents_id_seq OWNED BY public.knowledge_documents.id;


--
-- Name: legacy_agent_prompt_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legacy_agent_prompt_versions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    agent_prompt_id character varying,
    version integer DEFAULT 1 NOT NULL,
    content text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: marketing_lead_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_lead_events (
    id bigint NOT NULL,
    lead_id bigint NOT NULL,
    event_type text NOT NULL,
    previous_status text,
    new_status text,
    notes text,
    author text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketing_lead_events_event_type_check CHECK ((event_type = ANY (ARRAY['created'::text, 'status_change'::text, 'note'::text])))
);


--
-- Name: marketing_lead_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.marketing_lead_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: marketing_lead_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.marketing_lead_events_id_seq OWNED BY public.marketing_lead_events.id;


--
-- Name: marketing_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_leads (
    id bigint NOT NULL,
    source text NOT NULL,
    name text,
    email text NOT NULL,
    company text,
    phone text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    notified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    status_notes text,
    status_updated_at timestamp with time zone,
    status_updated_by text
);


--
-- Name: marketing_leads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.marketing_leads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: marketing_leads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.marketing_leads_id_seq OWNED BY public.marketing_leads.id;


--
-- Name: marketing_search_empty_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_search_empty_queries (
    id bigint NOT NULL,
    query_normalized text NOT NULL,
    query_raw text NOT NULL,
    locale character varying(16) NOT NULL,
    source character varying(32) NOT NULL,
    page_path text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketing_search_empty_queries_locale_len CHECK (((char_length((locale)::text) >= 1) AND (char_length((locale)::text) <= 16))),
    CONSTRAINT marketing_search_empty_queries_query_normalized_len CHECK (((char_length(query_normalized) >= 1) AND (char_length(query_normalized) <= 256))),
    CONSTRAINT marketing_search_empty_queries_query_raw_len CHECK (((char_length(query_raw) >= 1) AND (char_length(query_raw) <= 512))),
    CONSTRAINT marketing_search_empty_queries_source_check CHECK (((source)::text = ANY ((ARRAY['help_widget'::character varying, 'resources'::character varying, 'docs_help_widget'::character varying, 'docs_search'::character varying])::text[])))
);


--
-- Name: marketing_search_empty_queries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.marketing_search_empty_queries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: marketing_search_empty_queries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.marketing_search_empty_queries_id_seq OWNED BY public.marketing_search_empty_queries.id;


--
-- Name: marketplace_opportunity_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_opportunity_scores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_category character varying(255) NOT NULL,
    gap_description text,
    demand_score double precision DEFAULT 0,
    install_velocity double precision DEFAULT 0,
    uninstall_rate double precision DEFAULT 0,
    search_miss_count integer DEFAULT 0,
    estimated_installs integer DEFAULT 0,
    opportunity_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketplace_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    template_id character varying NOT NULL,
    stripe_payment_id text,
    stripe_checkout_session_id text,
    amount_cents integer DEFAULT 0 NOT NULL,
    currency text DEFAULT 'usd'::text,
    price_model public.price_model DEFAULT 'one_time'::public.price_model,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    stripe_subscription_id text,
    subscription_status text,
    discount_badge_applied boolean DEFAULT false NOT NULL,
    discount_coupon_id text,
    discount_promotion_code text,
    discount_name text,
    discount_percent_off numeric(5,2),
    discount_amount_off_cents integer,
    discount_currency text,
    CONSTRAINT marketplace_purchases_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'refunded'::text]))),
    CONSTRAINT marketplace_purchases_subscription_status_check CHECK (((subscription_status IS NULL) OR (subscription_status = ANY (ARRAY['active'::text, 'past_due'::text, 'canceled'::text, 'unpaid'::text, 'incomplete'::text]))))
);


--
-- Name: marketplace_revenue_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_revenue_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purchase_id uuid,
    template_id character varying NOT NULL,
    developer_id text,
    gross_amount_cents integer DEFAULT 0 NOT NULL,
    platform_fee_cents integer DEFAULT 0 NOT NULL,
    developer_share_cents integer DEFAULT 0 NOT NULL,
    event_type text DEFAULT 'sale'::text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT marketplace_revenue_events_event_type_check CHECK ((event_type = ANY (ARRAY['sale'::text, 'refund'::text, 'subscription_renewal'::text])))
);


--
-- Name: marketplace_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    template_id character varying NOT NULL,
    rating integer NOT NULL,
    review_text text,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT marketplace_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT marketplace_reviews_status_check CHECK ((status = ANY (ARRAY['active'::text, 'flagged'::text, 'removed'::text])))
);


--
-- Name: milestone_thresholds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.milestone_thresholds (
    id character varying DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying NOT NULL,
    milestone_type character varying(50) NOT NULL,
    milestone_value integer NOT NULL,
    label character varying(200) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: model_routing_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_routing_log (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying,
    query_text text,
    complexity_score numeric(4,2) DEFAULT 0 NOT NULL,
    routed_tier public.model_tier NOT NULL,
    reason character varying(255),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: network_recommendations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.network_recommendations (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    source_pattern_id character varying(64),
    title character varying(255) NOT NULL,
    description text NOT NULL,
    recommendation_type character varying(60) NOT NULL,
    industry_vertical character varying(60),
    estimated_impact text,
    confidence_score numeric(4,3) DEFAULT 0.5 NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    dismissed_at timestamp with time zone,
    applied_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: number_routing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.number_routing (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    phone_number_id character varying NOT NULL,
    agent_id character varying NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: operations_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations_alerts (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    type character varying(60) NOT NULL,
    severity character varying(20) DEFAULT 'warning'::character varying NOT NULL,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    call_session_id character varying(64),
    agent_id character varying(64),
    acknowledged boolean DEFAULT false NOT NULL,
    acknowledged_at timestamp with time zone,
    acknowledged_by character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    notified_at timestamp with time zone,
    notification_kind character varying(64)
);


--
-- Name: outbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_events (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    idempotency_key character varying(200) NOT NULL,
    event_type character varying(100) NOT NULL,
    integration_id character varying,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.outbox_event_status DEFAULT 'pending'::public.outbox_event_status NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    last_error text,
    next_attempt_at timestamp without time zone DEFAULT now(),
    delivered_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    archived_at timestamp without time zone,
    claimed_at timestamp without time zone,
    lease_expires_at timestamp without time zone
);


--
-- Name: outbox_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_messages (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    idempotency_key character varying(300),
    call_sid character varying(60),
    call_log_id character varying,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    max_retries integer DEFAULT 5 NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    last_error text,
    lease_expires_at timestamp without time zone,
    next_retry_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    CONSTRAINT outbox_messages_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sending'::character varying, 'sent'::character varying, 'retry'::character varying, 'dead_letter'::character varying])::text[])))
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    user_id character varying NOT NULL,
    token character varying(255) NOT NULL,
    used_at timestamp without time zone,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: phone_endpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phone_endpoints (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    phone_number character varying(20) NOT NULL,
    friendly_name character varying(255),
    provider character varying(50) DEFAULT 'twilio'::character varying,
    is_active boolean DEFAULT true NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: phone_numbers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phone_numbers (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    phone_number character varying(20) NOT NULL,
    friendly_name character varying(255),
    twilio_sid character varying(50),
    capabilities jsonb DEFAULT '{"sms": true, "voice": true}'::jsonb,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    provisioned_at timestamp without time zone,
    released_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    is_demo boolean DEFAULT false,
    is_free_number boolean DEFAULT false,
    monthly_cost_cents integer DEFAULT 200,
    provisioned_via character varying(20) DEFAULT 'manual'::character varying,
    scheduling_provider character varying(60)
);


--
-- Name: platform_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_settings (
    key character varying(100) NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_by character varying
);


--
-- Name: prompt_improvement_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_improvement_suggestions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    agent_id character varying NOT NULL,
    source_call_session_id character varying,
    status text DEFAULT 'pending'::text NOT NULL,
    weakness_category text NOT NULL,
    weakness_description text NOT NULL,
    affected_turns jsonb DEFAULT '[]'::jsonb,
    current_prompt_section text NOT NULL,
    suggested_prompt_section text NOT NULL,
    rationale text NOT NULL,
    simulation_score_before numeric(4,2),
    simulation_score_after numeric(4,2),
    simulation_details jsonb DEFAULT '{}'::jsonb,
    accepted_by character varying,
    accepted_at timestamp with time zone,
    dismissed_by character varying,
    dismissed_at timestamp with time zone,
    applied_prompt_version integer,
    quality_score_before numeric(4,2),
    quality_score_after numeric(4,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prompt_improvement_suggestions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'dismissed'::text]))),
    CONSTRAINT prompt_improvement_suggestions_weakness_category_check CHECK ((weakness_category = ANY (ARRAY['prompt_structure'::text, 'question_ordering'::text, 'objection_handling'::text, 'workflow_efficiency'::text, 'tone'::text, 'accuracy'::text, 'resolution'::text])))
);


--
-- Name: prompt_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_versions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    agent_id character varying,
    version integer DEFAULT 1 NOT NULL,
    system_prompt text,
    is_active boolean DEFAULT true NOT NULL,
    created_by character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: push_delivery_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_delivery_attempts (
    id bigint NOT NULL,
    tenant_id character varying(255) NOT NULL,
    event character varying(64),
    attempted integer DEFAULT 0 NOT NULL,
    accepted integer DEFAULT 0 NOT NULL,
    retired integer DEFAULT 0 NOT NULL,
    dropped integer DEFAULT 0 NOT NULL,
    failure_reason character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: push_delivery_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.push_delivery_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: push_delivery_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.push_delivery_attempts_id_seq OWNED BY public.push_delivery_attempts.id;


--
-- Name: response_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.response_cache (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    cache_key character varying(512) NOT NULL,
    intent character varying(100) NOT NULL,
    response_text text NOT NULL,
    hit_count integer DEFAULT 0 NOT NULL,
    last_hit_at timestamp without time zone,
    ttl_seconds integer DEFAULT 3600 NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: retry_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retry_attempts (
    key text NOT NULL,
    last_attempt_at timestamp with time zone NOT NULL
);


--
-- Name: roadmap_recommendations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roadmap_recommendations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    opportunity_id uuid,
    title character varying(500) NOT NULL,
    problem_detected text NOT NULL,
    evidence_summary text,
    affected_segments jsonb DEFAULT '[]'::jsonb,
    expected_business_impact jsonb DEFAULT '{}'::jsonb,
    implementation_complexity character varying(50) DEFAULT 'medium'::character varying,
    recommended_priority character varying(50) DEFAULT 'medium'::character varying,
    estimated_revenue_impact_cents bigint DEFAULT 0,
    estimated_effort_days integer DEFAULT 0,
    ai_explanation text,
    status public.evolution_recommendation_status DEFAULT 'proposed'::public.evolution_recommendation_status,
    status_changed_by character varying(255),
    status_changed_at timestamp with time zone,
    status_reason text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduling_appointment_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_appointment_types (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description text DEFAULT ''::text,
    duration_minutes integer DEFAULT 30 NOT NULL,
    buffer_minutes integer DEFAULT 0 NOT NULL,
    capacity integer DEFAULT 1 NOT NULL,
    color character varying(20) DEFAULT '#3b82f6'::character varying,
    required_resources jsonb DEFAULT '[]'::jsonb,
    intake_fields jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    allow_self_scheduling boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduling_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_audit_log (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    booking_id character varying(255),
    action character varying(50) NOT NULL,
    previous_status character varying(30) DEFAULT NULL::character varying,
    new_status character varying(30) DEFAULT NULL::character varying,
    changed_by character varying(255),
    details jsonb DEFAULT '{}'::jsonb,
    override_reason text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduling_booking_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_booking_rules (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    appointment_type_id character varying(255),
    min_lead_time_hours integer DEFAULT 0 NOT NULL,
    max_lead_time_days integer DEFAULT 90 NOT NULL,
    allow_same_day boolean DEFAULT true NOT NULL,
    allow_double_book boolean DEFAULT false NOT NULL,
    max_daily_bookings integer,
    max_per_slot integer DEFAULT 1 NOT NULL,
    cancellation_window_hours integer DEFAULT 24 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduling_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_overrides (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    provider_id character varying(255),
    override_date date NOT NULL,
    start_time time without time zone,
    end_time time without time zone,
    is_available boolean DEFAULT false NOT NULL,
    reason character varying(500) DEFAULT ''::character varying,
    created_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduling_provider_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_provider_schedules (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    provider_id character varying(255) NOT NULL,
    day_of_week integer NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    location character varying(255) DEFAULT ''::character varying,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduling_provider_schedules_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6)))
);


--
-- Name: scheduling_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_providers (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    specialty character varying(255) DEFAULT ''::character varying,
    email character varying(255) DEFAULT ''::character varying,
    phone character varying(50) DEFAULT ''::character varying,
    location character varying(255) DEFAULT ''::character varying,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduling_recurring_series; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_recurring_series (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    title character varying(500) NOT NULL,
    provider_id character varying(255),
    appointment_type_id character varying(255),
    resource_id character varying(255),
    recurrence_pattern character varying(30) DEFAULT 'weekly'::character varying NOT NULL,
    recurrence_day_of_week integer,
    recurrence_time time without time zone NOT NULL,
    duration_minutes integer DEFAULT 30 NOT NULL,
    series_start date NOT NULL,
    series_end date,
    contact_name character varying(255) DEFAULT ''::character varying,
    contact_phone character varying(50) DEFAULT ''::character varying,
    contact_email character varying(255) DEFAULT ''::character varying,
    is_active boolean DEFAULT true NOT NULL,
    created_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduling_recurring_series_recurrence_day_of_week_check CHECK (((recurrence_day_of_week >= 0) AND (recurrence_day_of_week <= 6))),
    CONSTRAINT scheduling_recurring_series_recurrence_pattern_check CHECK (((recurrence_pattern)::text = ANY ((ARRAY['daily'::character varying, 'weekly'::character varying, 'biweekly'::character varying, 'monthly'::character varying])::text[])))
);


--
-- Name: scheduling_reminder_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_reminder_configs (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    appointment_type_id character varying(255),
    reminder_type character varying(30) DEFAULT 'reminder'::character varying NOT NULL,
    channel character varying(20) DEFAULT 'sms'::character varying NOT NULL,
    timing_minutes integer DEFAULT 1440 NOT NULL,
    template text DEFAULT ''::text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduling_reminder_configs_channel_check CHECK (((channel)::text = ANY ((ARRAY['sms'::character varying, 'email'::character varying, 'both'::character varying])::text[]))),
    CONSTRAINT scheduling_reminder_configs_reminder_type_check CHECK (((reminder_type)::text = ANY ((ARRAY['confirmation'::character varying, 'reminder'::character varying, 'cancellation_followup'::character varying, 'reschedule_prompt'::character varying])::text[])))
);


--
-- Name: scheduling_reminder_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_reminder_log (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    booking_id character varying(255) NOT NULL,
    reminder_config_id character varying(255),
    channel character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    sent_at timestamp with time zone,
    error_message text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduling_reminder_log_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sent'::character varying, 'delivered'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: scheduling_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_resources (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(50) DEFAULT 'room'::character varying NOT NULL,
    location character varying(255) DEFAULT ''::character varying,
    capacity integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduling_resources_type_check CHECK (((type)::text = ANY ((ARRAY['room'::character varying, 'equipment'::character varying, 'other'::character varying])::text[])))
);


--
-- Name: scheduling_waitlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_waitlist (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    contact_name character varying(255) NOT NULL,
    contact_phone character varying(50) DEFAULT ''::character varying,
    contact_email character varying(255) DEFAULT ''::character varying,
    appointment_type_id character varying(255),
    provider_id character varying(255),
    preferred_date_start date,
    preferred_date_end date,
    preferred_time_start time without time zone,
    preferred_time_end time without time zone,
    status character varying(30) DEFAULT 'waiting'::character varying NOT NULL,
    notes text DEFAULT ''::text,
    notified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduling_waitlist_status_check CHECK (((status)::text = ANY ((ARRAY['waiting'::character varying, 'offered'::character varying, 'booked'::character varying, 'expired'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: scheduling_workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_workflows (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    name character varying(255) NOT NULL,
    workflow_type character varying(60) NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    id integer NOT NULL,
    filename character varying(255) NOT NULL,
    applied_at timestamp without time zone DEFAULT now()
);


--
-- Name: schema_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schema_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schema_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schema_migrations_id_seq OWNED BY public.schema_migrations.id;


--
-- Name: simulation_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.simulation_results (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    run_id character varying NOT NULL,
    scenario_id character varying NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    transcript jsonb DEFAULT '[]'::jsonb NOT NULL,
    scores jsonb,
    reasoning_trace jsonb DEFAULT '[]'::jsonb NOT NULL,
    tool_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    outcome text,
    failure_reason text,
    turn_count integer DEFAULT 0 NOT NULL,
    duration_ms integer,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: simulation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.simulation_runs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    agent_id character varying NOT NULL,
    name text,
    status text DEFAULT 'pending'::text NOT NULL,
    scenario_ids character varying[] DEFAULT '{}'::character varying[] NOT NULL,
    total_scenarios integer DEFAULT 0 NOT NULL,
    completed_scenarios integer DEFAULT 0 NOT NULL,
    failed_scenarios integer DEFAULT 0 NOT NULL,
    aggregate_scores jsonb,
    prompt_version_label text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: simulation_scenarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.simulation_scenarios (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    name text NOT NULL,
    description text,
    category text DEFAULT 'custom'::text NOT NULL,
    persona jsonb DEFAULT '{}'::jsonb NOT NULL,
    goals jsonb DEFAULT '[]'::jsonb NOT NULL,
    expected_outcomes jsonb DEFAULT '{}'::jsonb NOT NULL,
    difficulty text DEFAULT 'medium'::text NOT NULL,
    max_turns integer DEFAULT 20 NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_assignment_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_assignment_rules (
    id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    name character varying(255) NOT NULL,
    rule_type character varying(30) NOT NULL,
    match_field character varying(50) NOT NULL,
    match_value character varying(255) NOT NULL,
    assign_to_user_id character varying,
    assign_to_team character varying(100),
    enabled boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_auto_reply_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_auto_reply_rules (
    id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    name character varying(255) NOT NULL,
    rule_type character varying(30) DEFAULT 'keyword'::character varying NOT NULL,
    keyword character varying(255),
    match_type character varying(20) DEFAULT 'exact'::character varying,
    reply_body text NOT NULL,
    is_business_hours boolean,
    business_hours_start character varying(5),
    business_hours_end character varying(5),
    business_days integer[] DEFAULT '{1,2,3,4,5}'::integer[],
    timezone character varying(100) DEFAULT 'America/Chicago'::character varying,
    enabled boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    phone_number_id character varying,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_canned_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_canned_responses (
    id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    title character varying(255) NOT NULL,
    body text NOT NULL,
    category character varying(100),
    variables text[] DEFAULT '{}'::text[],
    shortcut character varying(50),
    created_by character varying,
    is_global boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_consent_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_consent_log (
    id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    phone_number character varying(20) NOT NULL,
    action character varying(20) NOT NULL,
    keyword character varying(50),
    source character varying(30) NOT NULL,
    twilio_sid character varying(50),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sms_consent_action_check CHECK (((action)::text = ANY ((ARRAY['opt_in'::character varying, 'opt_out'::character varying, 'help_request'::character varying])::text[])))
);


--
-- Name: sms_conversation_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_conversation_activity_log (
    id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    conversation_id character varying NOT NULL,
    action character varying(50) NOT NULL,
    actor_user_id character varying,
    actor_name character varying(255),
    details jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sms_activity_action_check CHECK (((action)::text = ANY ((ARRAY['status_changed'::character varying, 'assigned'::character varying, 'note_added'::character varying, 'message_sent'::character varying, 'message_received'::character varying, 'message_scheduled'::character varying, 'priority_changed'::character varying, 'pinned'::character varying, 'unpinned'::character varying, 'tagged'::character varying, 'follow_up_set'::character varying])::text[])))
);


--
-- Name: sms_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_conversations (
    id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    phone_number_id character varying NOT NULL,
    remote_number character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    assignee_user_id character varying,
    assignee_team character varying(100),
    priority character varying(10) DEFAULT 'normal'::character varying NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    unread_count integer DEFAULT 0 NOT NULL,
    follow_up boolean DEFAULT false NOT NULL,
    follow_up_at timestamp without time zone,
    last_message_at timestamp without time zone,
    last_message_preview text,
    closed_at timestamp without time zone,
    escalated_at timestamp without time zone,
    contact_name character varying(255),
    contact_email character varying(255),
    contact_location character varying(255),
    tags text[] DEFAULT '{}'::text[],
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sms_conv_priority_check CHECK (((priority)::text = ANY ((ARRAY['normal'::character varying, 'high'::character varying, 'urgent'::character varying])::text[]))),
    CONSTRAINT sms_conv_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'pending'::character varying, 'closed'::character varying, 'escalated'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: sms_internal_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_internal_notes (
    id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    conversation_id character varying NOT NULL,
    user_id character varying NOT NULL,
    user_name character varying(255),
    body text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: sms_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_logs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    direction character varying(10) DEFAULT 'outbound'::character varying NOT NULL,
    from_number character varying(20),
    to_number character varying(20),
    body text,
    status character varying(30),
    twilio_sid character varying(50),
    cost_cents integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: sms_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_messages (
    id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    conversation_id character varying NOT NULL,
    direction character varying(10) NOT NULL,
    from_number character varying(20) NOT NULL,
    to_number character varying(20) NOT NULL,
    body text NOT NULL,
    status character varying(20) DEFAULT 'queued'::character varying NOT NULL,
    twilio_sid character varying(50),
    scheduled_at timestamp without time zone,
    sent_at timestamp without time zone,
    delivered_at timestamp without time zone,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT sms_msg_direction_check CHECK (((direction)::text = ANY ((ARRAY['inbound'::character varying, 'outbound'::character varying])::text[])))
);


--
-- Name: subprocessors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subprocessors (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    purpose text NOT NULL,
    data_types text NOT NULL,
    location text DEFAULT 'United States'::text NOT NULL,
    website text,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    display_order integer DEFAULT 0 NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    plan character varying(50) DEFAULT 'starter'::character varying NOT NULL,
    status public.subscription_status DEFAULT 'trialing'::public.subscription_status NOT NULL,
    billing_interval public.billing_interval DEFAULT 'monthly'::public.billing_interval NOT NULL,
    stripe_customer_id character varying(60),
    stripe_subscription_id character varying(60),
    stripe_price_id character varying(60),
    current_period_start timestamp without time zone,
    current_period_end timestamp without time zone,
    trial_end timestamp without time zone,
    cancelled_at timestamp without time zone,
    monthly_call_limit integer,
    monthly_sms_limit integer,
    monthly_ai_minute_limit integer,
    overage_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    downgrade_completed_at timestamp without time zone,
    downgrade_completed_to_plan character varying(50)
);


--
-- Name: support_email_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_email_suppressions (
    email_lower text NOT NULL,
    reason text NOT NULL,
    source text,
    last_error text,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    added_by_user_id text,
    notes text
);


--
-- Name: support_email_unsubscribe_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_email_unsubscribe_audit (
    id bigint NOT NULL,
    email_lower text NOT NULL,
    resubscribed_source text,
    previous_unsubscribed_at timestamp with time zone,
    previous_source text,
    resubscribed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_email_unsubscribe_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_email_unsubscribe_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_email_unsubscribe_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_email_unsubscribe_audit_id_seq OWNED BY public.support_email_unsubscribe_audit.id;


--
-- Name: support_email_unsubscribes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_email_unsubscribes (
    email_lower text NOT NULL,
    source text,
    unsubscribed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_recipient_bounce_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_recipient_bounce_alerts (
    email_lower text NOT NULL,
    reply_id integer,
    ticket_id character varying(64),
    tenant_id character varying(64),
    last_error text,
    first_alerted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_routing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_routing (
    id integer NOT NULL,
    plan character varying(50) NOT NULL,
    topic character varying(50) NOT NULL,
    destination character varying(255) NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    notes text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_routing_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_routing_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_routing_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_routing_id_seq OWNED BY public.support_routing.id;


--
-- Name: support_ticket_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_ticket_replies (
    id integer NOT NULL,
    ticket_id character varying(64) NOT NULL,
    direction character varying(16) NOT NULL,
    author_user_id character varying(64),
    author_email character varying(255),
    body text NOT NULL,
    email_message_id character varying(255),
    email_error text,
    source character varying(32),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    last_retry_at timestamp with time zone,
    retry_skipped_reason text,
    CONSTRAINT support_ticket_replies_direction_check CHECK (((direction)::text = ANY ((ARRAY['outbound'::character varying, 'inbound'::character varying, 'system'::character varying])::text[])))
);


--
-- Name: support_ticket_replies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_ticket_replies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_ticket_replies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_ticket_replies_id_seq OWNED BY public.support_ticket_replies.id;


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id character varying(64) NOT NULL,
    tenant_id character varying(64),
    user_id character varying(64),
    user_email character varying(255),
    plan character varying(50),
    topic character varying(50) NOT NULL,
    message text NOT NULL,
    recent_errors text,
    context jsonb DEFAULT '{}'::jsonb,
    routed_to character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    email_message_id character varying(255),
    email_error text,
    inbound_token character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    retry_skipped_reason text
);


--
-- Name: system_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_metrics (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    host character varying(100),
    metric_name character varying(100) NOT NULL,
    metric_value numeric NOT NULL,
    tags jsonb DEFAULT '{}'::jsonb,
    recorded_at timestamp without time zone DEFAULT now()
);


--
-- Name: template_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_categories (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    display_name character varying(255) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    icon character varying(50),
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: template_category_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_category_map (
    template_id character varying NOT NULL,
    category_id character varying NOT NULL
);


--
-- Name: template_changelogs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_changelogs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    template_id character varying NOT NULL,
    version character varying(20) NOT NULL,
    change_type character varying(20) DEFAULT 'added'::character varying NOT NULL,
    summary text NOT NULL,
    details text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT template_changelogs_change_type_check CHECK (((change_type)::text = ANY ((ARRAY['added'::character varying, 'changed'::character varying, 'fixed'::character varying, 'removed'::character varying, 'deprecated'::character varying, 'security'::character varying])::text[])))
);


--
-- Name: template_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_entitlements (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    template_id character varying NOT NULL,
    plan_tier character varying(50) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT template_entitlements_plan_tier_check CHECK (((plan_tier)::text = ANY ((ARRAY['starter'::character varying, 'pro'::character varying, 'enterprise'::character varying])::text[])))
);


--
-- Name: template_install_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_install_events (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    template_id character varying NOT NULL,
    event_type character varying(30) NOT NULL,
    version character varying(20),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT template_install_events_event_type_check CHECK (((event_type)::text = ANY ((ARRAY['installed'::character varying, 'upgraded'::character varying, 'downgraded'::character varying, 'uninstalled'::character varying, 'configured'::character varying, 'error'::character varying])::text[])))
);


--
-- Name: template_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_registry (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    slug character varying(100) NOT NULL,
    display_name character varying(255) NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    short_description character varying(500) DEFAULT ''::character varying NOT NULL,
    icon_url character varying(500),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    current_version character varying(20) DEFAULT '1.0.0'::character varying NOT NULL,
    min_plan character varying(50) DEFAULT 'starter'::character varying NOT NULL,
    agent_type character varying(50) DEFAULT 'inbound'::character varying NOT NULL,
    default_voice character varying(50) DEFAULT 'sage'::character varying NOT NULL,
    default_language character varying(10) DEFAULT 'en'::character varying NOT NULL,
    supported_channels jsonb DEFAULT '["voice"]'::jsonb NOT NULL,
    required_tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    optional_tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    config_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    install_count integer DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    marketplace_category public.marketplace_category DEFAULT 'vertical_agent'::public.marketplace_category,
    price_model public.price_model DEFAULT 'free'::public.price_model,
    price_cents integer DEFAULT 0,
    stripe_price_id text,
    developer_id text,
    developer_name text,
    developer_revenue_share_pct numeric(5,2) DEFAULT 70.00,
    avg_rating numeric(3,2) DEFAULT 0,
    review_count integer DEFAULT 0,
    featured boolean DEFAULT false,
    stripe_meter_event_name text,
    CONSTRAINT template_registry_agent_type_check CHECK (((agent_type)::text = ANY ((ARRAY['inbound'::character varying, 'outbound'::character varying])::text[]))),
    CONSTRAINT template_registry_min_plan_check CHECK (((min_plan)::text = ANY ((ARRAY['starter'::character varying, 'pro'::character varying, 'enterprise'::character varying])::text[]))),
    CONSTRAINT template_registry_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'draft'::character varying, 'deprecated'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: template_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_versions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    template_id character varying NOT NULL,
    version character varying(20) NOT NULL,
    changelog text DEFAULT ''::text NOT NULL,
    package_ref character varying(500) DEFAULT ''::character varying NOT NULL,
    release_notes text DEFAULT ''::text NOT NULL,
    is_latest boolean DEFAULT false NOT NULL,
    published_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    status character varying(20) DEFAULT 'published'::character varying NOT NULL,
    created_by character varying,
    CONSTRAINT template_versions_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'published'::character varying, 'deprecated'::character varying])::text[])))
);


--
-- Name: tenant_agent_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_agent_installations (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    template_id character varying NOT NULL,
    installed_version character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    agent_id character varying,
    installed_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    installed_by text,
    rollback_version character varying(20),
    previous_config jsonb,
    upgraded_at timestamp without time zone,
    checklist_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    customization_overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT tenant_agent_installations_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'upgrading'::character varying, 'error'::character varying])::text[])))
);


--
-- Name: tenant_deletion_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_deletion_requests (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    requested_by character varying NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    cancelled_at timestamp with time zone,
    cancelled_by character varying,
    status text DEFAULT 'pending'::text NOT NULL,
    reason text,
    confirmation_text text NOT NULL,
    CONSTRAINT tenant_deletion_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'cancelled'::text, 'completed'::text])))
);


--
-- Name: tenant_isolation_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_isolation_tests (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    test_name character varying(200) NOT NULL,
    test_result character varying(20) NOT NULL,
    details jsonb DEFAULT '{}'::jsonb,
    run_at timestamp without time zone DEFAULT now(),
    source character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    run_id character varying,
    CONSTRAINT tenant_isolation_tests_source_check CHECK (((source)::text = ANY ((ARRAY['manual'::character varying, 'scheduled'::character varying])::text[]))),
    CONSTRAINT tenant_isolation_tests_test_result_check CHECK (((test_result)::text = ANY ((ARRAY['pass'::character varying, 'fail'::character varying])::text[])))
);


--
-- Name: tenant_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_notifications (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    type character varying(50) NOT NULL,
    title character varying(200) NOT NULL,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    read boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    user_id character varying
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    domain character varying(255),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    plan character varying(50) DEFAULT 'starter'::character varying NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb,
    feature_flags jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    is_demo boolean DEFAULT false,
    demo_call_count integer DEFAULT 0,
    trial_started_at timestamp without time zone,
    trial_expires_at timestamp without time zone,
    suspended_at timestamp without time zone,
    suspension_reason text,
    gin_participation boolean DEFAULT false NOT NULL,
    gin_opted_in_at timestamp with time zone,
    gin_data_usage_accepted boolean DEFAULT false NOT NULL,
    sms_alerts_disabled boolean DEFAULT false NOT NULL,
    scheduling_drift_alert_sent_at timestamp without time zone,
    billing_currency character varying(3) DEFAULT 'usd'::character varying NOT NULL,
    dispatch_bad_arrival_threshold_m integer DEFAULT 250 NOT NULL,
    dispatch_long_en_route_threshold_minutes integer DEFAULT 30 NOT NULL,
    dispatch_sms_segment_limit integer,
    csat_survey_enabled boolean DEFAULT false NOT NULL,
    csat_survey_channel character varying(16) DEFAULT 'sms'::character varying NOT NULL,
    csat_survey_scale integer DEFAULT 5 NOT NULL,
    csat_survey_min_duration_seconds integer DEFAULT 30 NOT NULL,
    csat_survey_sms_template text,
    timezone character varying(64) DEFAULT 'America/New_York'::character varying NOT NULL,
    dispatch_completion_photo_email_enabled boolean DEFAULT true NOT NULL,
    encryption_reminder_paused boolean DEFAULT false NOT NULL,
    encryption_reminder_paused_at timestamp without time zone,
    encryption_reminder_paused_by_user_id character varying,
    encryption_reminder_paused_reason text,
    sms_quiet_hours_start time without time zone,
    sms_quiet_hours_end time without time zone,
    CONSTRAINT tenants_csat_survey_channel_check CHECK (((csat_survey_channel)::text = ANY ((ARRAY['sms'::character varying, 'web'::character varying, 'email'::character varying])::text[]))),
    CONSTRAINT tenants_csat_survey_min_duration_seconds_check CHECK (((csat_survey_min_duration_seconds >= 5) AND (csat_survey_min_duration_seconds <= 600))),
    CONSTRAINT tenants_csat_survey_scale_check CHECK (((csat_survey_scale >= 2) AND (csat_survey_scale <= 10))),
    CONSTRAINT tenants_csat_survey_sms_template_check CHECK (((csat_survey_sms_template IS NULL) OR (length(csat_survey_sms_template) <= 320))),
    CONSTRAINT tenants_dispatch_bad_arrival_threshold_m_range CHECK (((dispatch_bad_arrival_threshold_m >= 10) AND (dispatch_bad_arrival_threshold_m <= 5000))),
    CONSTRAINT tenants_dispatch_long_en_route_threshold_minutes_range CHECK (((dispatch_long_en_route_threshold_minutes >= 5) AND (dispatch_long_en_route_threshold_minutes <= 480))),
    CONSTRAINT tenants_dispatch_sms_segment_limit_range CHECK (((dispatch_sms_segment_limit IS NULL) OR ((dispatch_sms_segment_limit >= 1) AND (dispatch_sms_segment_limit <= 10)))),
    CONSTRAINT tenants_sms_quiet_hours_window_order CHECK (((sms_quiet_hours_start IS NULL) OR (sms_quiet_hours_end IS NULL) OR (sms_quiet_hours_start < sms_quiet_hours_end)))
);


--
-- Name: ticket_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_activity_log (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ticket_id character varying(255) NOT NULL,
    user_id character varying(255),
    activity_type character varying(50) NOT NULL,
    content text DEFAULT ''::text,
    old_value text DEFAULT ''::text,
    new_value text DEFAULT ''::text,
    field_name character varying(100) DEFAULT ''::character varying,
    metadata jsonb DEFAULT '{}'::jsonb,
    is_internal boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_activity_log_activity_type_check CHECK (((activity_type)::text = ANY ((ARRAY['created'::character varying, 'status_change'::character varying, 'priority_change'::character varying, 'assigned'::character varying, 'unassigned'::character varying, 'note'::character varying, 'internal_note'::character varying, 'field_change'::character varying, 'escalated'::character varying, 'reopened'::character varying, 'sla_breach'::character varying, 'sla_breached'::character varying, 'sla_warning'::character varying, 'watcher_added'::character varying, 'watcher_removed'::character varying, 'linked'::character varying, 'unlinked'::character varying, 'category_change'::character varying, 'department_change'::character varying, 'macro_applied'::character varying, 'auto_closed'::character varying, 'merged'::character varying, 'template_response'::character varying, 'attachment_added'::character varying, 'attachment_removed'::character varying])::text[])))
);


--
-- Name: ticket_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_attachments (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ticket_id character varying(255) NOT NULL,
    file_name character varying(500) NOT NULL,
    file_size integer DEFAULT 0,
    file_type character varying(100) DEFAULT 'application/octet-stream'::character varying,
    file_url character varying(2000) DEFAULT ''::character varying,
    uploaded_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_categories (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description text DEFAULT ''::text,
    parent_id character varying(255),
    sort_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_custom_field_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_custom_field_values (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ticket_id character varying(255) NOT NULL,
    field_id character varying(255) NOT NULL,
    value text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_custom_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_custom_fields (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    field_key character varying(100) NOT NULL,
    field_type character varying(30) NOT NULL,
    options jsonb DEFAULT '[]'::jsonb,
    is_required boolean DEFAULT false,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_custom_fields_field_type_check CHECK (((field_type)::text = ANY ((ARRAY['text'::character varying, 'number'::character varying, 'select'::character varying, 'multi_select'::character varying, 'date'::character varying, 'boolean'::character varying, 'url'::character varying])::text[])))
);


--
-- Name: ticket_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_links (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    source_ticket_id character varying(255) NOT NULL,
    target_ticket_id character varying(255) NOT NULL,
    link_type character varying(30) DEFAULT 'related'::character varying,
    created_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_links_link_type_check CHECK (((link_type)::text = ANY ((ARRAY['related'::character varying, 'blocks'::character varying, 'blocked_by'::character varying, 'duplicate'::character varying, 'parent'::character varying, 'child'::character varying])::text[])))
);


--
-- Name: ticket_macros; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_macros (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description text DEFAULT ''::text,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true,
    created_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_notifications (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ticket_id character varying(255) NOT NULL,
    user_id character varying(255) NOT NULL,
    notification_type character varying(50) NOT NULL,
    channel character varying(20) DEFAULT 'in_app'::character varying NOT NULL,
    subject text DEFAULT ''::text,
    body text DEFAULT ''::text,
    is_read boolean DEFAULT false,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_notifications_channel_check CHECK (((channel)::text = ANY ((ARRAY['in_app'::character varying, 'email'::character varying, 'sms'::character varying])::text[]))),
    CONSTRAINT ticket_notifications_notification_type_check CHECK (((notification_type)::text = ANY ((ARRAY['assignment'::character varying, 'escalation'::character varying, 'sla_breach'::character varying, 'mention'::character varying, 'status_change'::character varying, 'comment'::character varying])::text[])))
);


--
-- Name: ticket_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_outbox (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    event_type character varying(100) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: ticket_queue_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_queue_configs (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description text DEFAULT ''::text,
    assignment_strategy character varying(50) DEFAULT 'manual'::character varying NOT NULL,
    eligible_user_ids text[] DEFAULT '{}'::text[],
    filter_priority text[] DEFAULT '{}'::text[],
    filter_category_id character varying(255),
    filter_department character varying(100) DEFAULT ''::character varying,
    max_tickets_per_agent integer DEFAULT 0,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    last_assigned_user_index integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_queue_configs_assignment_strategy_check CHECK (((assignment_strategy)::text = ANY ((ARRAY['manual'::character varying, 'round_robin'::character varying, 'least_loaded'::character varying])::text[])))
);


--
-- Name: ticket_retention_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_retention_policies (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description text DEFAULT ''::text,
    target_status character varying(50) DEFAULT 'closed'::character varying NOT NULL,
    days_after_close integer DEFAULT 90 NOT NULL,
    action character varying(50) DEFAULT 'archive'::character varying NOT NULL,
    is_active boolean DEFAULT true,
    last_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_retention_policies_action_check CHECK (((action)::text = ANY ((ARRAY['archive'::character varying, 'delete'::character varying, 'anonymize'::character varying])::text[])))
);


--
-- Name: ticket_saved_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_saved_views (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort_by character varying(100) DEFAULT 'created_at'::character varying,
    sort_order character varying(4) DEFAULT 'desc'::character varying,
    is_shared boolean DEFAULT false,
    created_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_sla_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_sla_instances (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ticket_id character varying(255) NOT NULL,
    policy_id character varying(255) NOT NULL,
    response_due_at timestamp with time zone,
    resolution_due_at timestamp with time zone,
    response_met boolean,
    resolution_met boolean,
    response_breached_at timestamp with time zone,
    resolution_breached_at timestamp with time zone,
    paused_at timestamp with time zone,
    total_paused_minutes integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_sla_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_sla_policies (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description text DEFAULT ''::text,
    priority character varying(20) NOT NULL,
    category_id character varying(255),
    first_response_minutes integer DEFAULT 480 NOT NULL,
    resolution_minutes integer DEFAULT 2880 NOT NULL,
    escalation_minutes integer,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_sla_policies_priority_check CHECK (((priority)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'urgent'::character varying])::text[])))
);


--
-- Name: ticket_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_templates (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    subject character varying(500) DEFAULT ''::character varying,
    body text DEFAULT ''::text NOT NULL,
    category_id character varying(255),
    variables jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true,
    created_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_watchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_watchers (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    ticket_id character varying(255) NOT NULL,
    user_id character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_workflow_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_workflow_rules (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    description text DEFAULT ''::text,
    trigger_event character varying(50) NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_workflow_rules_trigger_event_check CHECK (((trigger_event)::text = ANY ((ARRAY['ticket_created'::character varying, 'status_change'::character varying, 'status_changed'::character varying, 'priority_change'::character varying, 'priority_changed'::character varying, 'assigned'::character varying, 'sla_breach'::character varying, 'time_based'::character varying])::text[])))
);


--
-- Name: tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tickets (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    call_id character varying(255),
    subject character varying(500) NOT NULL,
    description text DEFAULT ''::text,
    status character varying(30) DEFAULT 'open'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    assignee_user_id character varying(255),
    notes text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category_id character varying(255),
    department character varying(100) DEFAULT ''::character varying,
    tags text[] DEFAULT '{}'::text[],
    source character varying(50) DEFAULT 'manual'::character varying,
    ticket_number integer NOT NULL,
    first_response_at timestamp with time zone,
    resolved_at timestamp with time zone,
    closed_at timestamp with time zone,
    reopened_count integer DEFAULT 0,
    parent_ticket_id character varying(255),
    contact_name character varying(255) DEFAULT ''::character varying,
    contact_email character varying(255) DEFAULT ''::character varying,
    contact_phone character varying(50) DEFAULT ''::character varying,
    created_by_user_id character varying(255),
    archived_at timestamp with time zone,
    CONSTRAINT tickets_priority_check CHECK (((priority)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'urgent'::character varying])::text[]))),
    CONSTRAINT tickets_source_check CHECK (((source)::text = ANY ((ARRAY['manual'::character varying, 'api'::character varying, 'ai_agent'::character varying, 'email'::character varying, 'phone'::character varying])::text[]))),
    CONSTRAINT tickets_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'in_progress'::character varying, 'pending'::character varying, 'escalated'::character varying, 'resolved'::character varying, 'closed'::character varying, 'reopened'::character varying])::text[])))
);


--
-- Name: tickets_ticket_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tickets_ticket_number_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tickets_ticket_number_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tickets_ticket_number_seq OWNED BY public.tickets.ticket_number;


--
-- Name: tool_failure_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_failure_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    tool_name text NOT NULL,
    call_session_id text NOT NULL,
    agent_slug text,
    error text,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 0,
    final_failure boolean DEFAULT false,
    fallback_attempted boolean DEFAULT false,
    fallback_success boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: tool_invocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_invocations (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying,
    tool_name character varying(100) NOT NULL,
    input jsonb DEFAULT '{}'::jsonb,
    output jsonb,
    status public.tool_invocation_status DEFAULT 'pending'::public.tool_invocation_status NOT NULL,
    error_message text,
    duration_ms integer,
    invoked_at timestamp without time zone DEFAULT now(),
    completed_at timestamp without time zone,
    agent_id character varying(255),
    agent_slug character varying(255),
    parameters_redacted jsonb DEFAULT '{}'::jsonb,
    result jsonb,
    recovery_action text
);


--
-- Name: tool_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_rate_limits (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    tool_name character varying(100) NOT NULL,
    max_per_minute integer DEFAULT 60 NOT NULL,
    max_per_hour integer DEFAULT 600 NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: tooltip_dismissals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tooltip_dismissals (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    user_id character varying NOT NULL,
    tooltip_key text NOT NULL,
    dismissed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: twilio_webhook_replay_nonces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.twilio_webhook_replay_nonces (
    nonce text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usage_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_metrics (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    metric_type public.usage_metric_type NOT NULL,
    period_start timestamp without time zone NOT NULL,
    period_end timestamp without time zone NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    unit_cost_cents integer,
    total_cost_cents integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_devices (
    id character varying(255) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(255) NOT NULL,
    resource_id character varying(255),
    user_id character varying(255),
    push_token text NOT NULL,
    platform character varying(16) DEFAULT 'expo'::character varying NOT NULL,
    push_enabled boolean DEFAULT true NOT NULL,
    device_label text DEFAULT ''::text NOT NULL,
    app_version character varying(64) DEFAULT ''::character varying NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    device_secret_hash text
);


--
-- Name: COLUMN user_devices.device_secret_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_devices.device_secret_hash IS 'SHA-256 hex hash of the device-issued secret used to bind mobile location pings to a single resource_id (see migration 084).';


--
-- Name: user_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_invitations (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    email character varying(255) NOT NULL,
    role character varying(60),
    token character varying(255) NOT NULL,
    invited_by character varying,
    accepted_at timestamp without time zone,
    expires_at timestamp without time zone NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notification_preferences (
    user_id character varying NOT NULL,
    category character varying(32) NOT NULL,
    channel character varying(16) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    user_id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    role public.tenant_role DEFAULT 'support_reviewer'::public.tenant_role NOT NULL,
    granted_by character varying,
    granted_at timestamp without time zone DEFAULT now(),
    revoked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_tenant_roles; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.user_tenant_roles AS
 SELECT id,
    user_id,
    tenant_id,
    role,
    granted_by,
    granted_at,
    revoked_at,
    created_at,
    updated_at
   FROM public.user_roles;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    email character varying(255) NOT NULL,
    username character varying(100),
    first_name character varying(100),
    last_name character varying(100),
    password_hash character varying(255),
    role character varying(50) DEFAULT 'user'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    last_login_at timestamp without time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    is_platform_admin boolean DEFAULT false NOT NULL,
    email_verification_token character varying(128),
    email_verification_sent_at timestamp without time zone,
    phone_number character varying(20),
    phone_verified boolean DEFAULT false NOT NULL,
    phone_verification_code character varying(10),
    phone_verification_sent_at timestamp without time zone,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: verified_caller_alert_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verified_caller_alert_recipients (
    id bigint NOT NULL,
    tenant_id character varying NOT NULL,
    caller_id character varying NOT NULL,
    dispatch_id character varying(64) NOT NULL,
    health_status character varying(32) NOT NULL,
    user_id character varying,
    recipient_name text,
    recipient_email text NOT NULL,
    delivery_status text NOT NULL,
    delivery_error text,
    permanent_failure boolean DEFAULT false NOT NULL,
    source text DEFAULT 'scheduler'::text NOT NULL,
    triggered_by_user_id character varying,
    dispatched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: verified_caller_alert_recipients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.verified_caller_alert_recipients_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: verified_caller_alert_recipients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.verified_caller_alert_recipients_id_seq OWNED BY public.verified_caller_alert_recipients.id;


--
-- Name: verified_caller_ids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verified_caller_ids (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    phone_number character varying(32) NOT NULL,
    friendly_name character varying(255),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attestation_level character varying(1),
    twilio_validation_sid character varying(64),
    twilio_caller_sid character varying(64),
    trust_hub_profile_sid character varying(64),
    trust_product_sid character varying(64),
    brand_sid character varying(64),
    verification_code character varying(16),
    verification_expires_at timestamp with time zone,
    verified_at timestamp with time zone,
    rotated_at timestamp with time zone,
    rotated_to_id character varying,
    registered_by_user_id character varying,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    last_health_check_at timestamp with time zone,
    last_health_status character varying(32),
    last_health_message text,
    expiry_alert_sent_at timestamp with time zone,
    verified_notification_sent_at timestamp with time zone
);


--
-- Name: vertical_demo_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vertical_demo_flows (
    id integer NOT NULL,
    vertical_id character varying(100) NOT NULL,
    scenario_name character varying(255) NOT NULL,
    caller_request text NOT NULL,
    expected_agent_path jsonb DEFAULT '[]'::jsonb NOT NULL,
    expected_tool_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vertical_demo_flows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vertical_demo_flows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vertical_demo_flows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vertical_demo_flows_id_seq OWNED BY public.vertical_demo_flows.id;


--
-- Name: vertical_expansion_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vertical_expansion_scores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vertical_name character varying(255) NOT NULL,
    current_tenant_count integer DEFAULT 0,
    growth_rate double precision DEFAULT 0,
    revenue_per_tenant_cents bigint DEFAULT 0,
    market_size_estimate character varying(100),
    expansion_score double precision DEFAULT 0,
    demand_signals jsonb DEFAULT '[]'::jsonb,
    opportunity_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vertical_prompt_library; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vertical_prompt_library (
    id integer NOT NULL,
    vertical_id character varying(100) NOT NULL,
    category character varying(50) NOT NULL,
    prompt_text text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vertical_prompt_library_category_check CHECK (((category)::text = ANY ((ARRAY['greeting'::character varying, 'qualification'::character varying, 'scheduling'::character varying, 'troubleshooting'::character varying, 'escalation'::character varying])::text[])))
);


--
-- Name: vertical_prompt_library_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vertical_prompt_library_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vertical_prompt_library_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vertical_prompt_library_id_seq OWNED BY public.vertical_prompt_library.id;


--
-- Name: vertical_starter_knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vertical_starter_knowledge (
    id integer NOT NULL,
    vertical_id character varying(100) NOT NULL,
    title character varying(500) NOT NULL,
    content text NOT NULL,
    category_type character varying(50) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vertical_starter_knowledge_category_type_check CHECK (((category_type)::text = ANY ((ARRAY['FAQ'::character varying, 'Services'::character varying, 'Procedures'::character varying, 'Troubleshooting'::character varying])::text[])))
);


--
-- Name: vertical_starter_knowledge_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vertical_starter_knowledge_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vertical_starter_knowledge_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vertical_starter_knowledge_id_seq OWNED BY public.vertical_starter_knowledge.id;


--
-- Name: webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_events (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    source character varying(50),
    event_type character varying(100),
    payload jsonb DEFAULT '{}'::jsonb,
    processed boolean DEFAULT false NOT NULL,
    processed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: website_agent_analytics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.website_agent_analytics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    conversation_id text,
    source_page text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: website_agent_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.website_agent_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id text NOT NULL,
    source_page text,
    messages jsonb DEFAULT '[]'::jsonb,
    lead_id uuid,
    demos_launched text[] DEFAULT '{}'::text[],
    pages_navigated text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: website_conversion_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.website_conversion_events (
    id character varying DEFAULT (gen_random_uuid())::text NOT NULL,
    visitor_id character varying(100) NOT NULL,
    stage character varying(50) NOT NULL,
    landing_page character varying(500) DEFAULT '/'::character varying NOT NULL,
    utm_source character varying(200),
    utm_medium character varying(200),
    utm_campaign character varying(200),
    utm_content character varying(200),
    utm_term character varying(200),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: website_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.website_leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text,
    email text,
    phone text,
    company text,
    industry text,
    business_size text,
    recommended_plan text,
    source_page text,
    conversation_id text,
    qualification_score integer DEFAULT 0,
    status text DEFAULT 'new'::text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: weekly_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weekly_reports (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    week_start date NOT NULL,
    week_end date NOT NULL,
    summary text NOT NULL,
    metrics_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    top_issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    prioritized_actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    insights_generated integer DEFAULT 0 NOT NULL,
    insights_accepted integer DEFAULT 0 NOT NULL,
    insights_dismissed integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: widget_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.widget_configs (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    agent_id character varying,
    enabled boolean DEFAULT false NOT NULL,
    greeting text DEFAULT 'Hello! How can I help you today?'::text,
    lead_capture_fields jsonb DEFAULT '["name", "email"]'::jsonb,
    primary_color character varying(7) DEFAULT '#6366f1'::character varying,
    allowed_domains text[] DEFAULT '{}'::text[],
    text_chat_enabled boolean DEFAULT true NOT NULL,
    voice_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: widget_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.widget_tokens (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    token_hash character varying(128) NOT NULL,
    label character varying(255) DEFAULT 'Default'::character varying,
    revoked_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: workflow_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_executions (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying,
    workflow_name character varying(100) NOT NULL,
    trigger_event character varying(60),
    status public.workflow_execution_status DEFAULT 'pending'::public.workflow_execution_status NOT NULL,
    context jsonb DEFAULT '{}'::jsonb,
    result jsonb,
    error_message text,
    started_at timestamp without time zone DEFAULT now(),
    completed_at timestamp without time zone,
    duration_ms integer
);


--
-- Name: workflow_performance_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_performance_metrics (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    industry_vertical character varying(60),
    workflow_type character varying(60) NOT NULL,
    metric_name character varying(80) NOT NULL,
    metric_value numeric(12,4) NOT NULL,
    sample_size integer DEFAULT 0 NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    aggregation_run_id character varying(64),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_steps (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    workflow_execution_id character varying NOT NULL,
    step_name character varying(100) NOT NULL,
    step_index integer DEFAULT 0 NOT NULL,
    status public.workflow_execution_status DEFAULT 'pending'::public.workflow_execution_status NOT NULL,
    input jsonb DEFAULT '{}'::jsonb,
    output jsonb,
    error_message text,
    started_at timestamp without time zone DEFAULT now(),
    completed_at timestamp without time zone,
    duration_ms integer
);


--
-- Name: workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflows (
    id character varying DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workforce_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workforce_members (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    team_id character varying NOT NULL,
    agent_id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    role character varying(50) DEFAULT 'specialist'::character varying NOT NULL,
    is_receptionist boolean DEFAULT false NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: workforce_optimization_insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workforce_optimization_insights (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    team_id character varying NOT NULL,
    category character varying(60) NOT NULL,
    title character varying(255) NOT NULL,
    description text NOT NULL,
    impact_estimate text,
    difficulty character varying(20) DEFAULT 'medium'::character varying,
    estimated_revenue_impact_cents integer,
    status character varying(20) DEFAULT 'new'::character varying NOT NULL,
    action_type character varying(60),
    action_payload jsonb DEFAULT '{}'::jsonb,
    source_data jsonb DEFAULT '{}'::jsonb,
    analysis_period_start timestamp with time zone,
    analysis_period_end timestamp with time zone,
    acknowledged_at timestamp with time zone,
    acknowledged_by character varying(64),
    dismissed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workforce_outbound_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workforce_outbound_tasks (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    team_id character varying NOT NULL,
    campaign_type character varying(60) NOT NULL,
    name character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    config jsonb DEFAULT '{}'::jsonb,
    campaign_id character varying(64),
    scheduled_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    total_contacts integer DEFAULT 0 NOT NULL,
    contacts_reached integer DEFAULT 0 NOT NULL,
    created_by character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workforce_revenue_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workforce_revenue_metrics (
    id character varying(64) DEFAULT (gen_random_uuid())::text NOT NULL,
    tenant_id character varying(64) NOT NULL,
    team_id character varying NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    calls_handled integer DEFAULT 0 NOT NULL,
    bookings_generated integer DEFAULT 0 NOT NULL,
    missed_calls_recovered integer DEFAULT 0 NOT NULL,
    estimated_revenue_cents integer DEFAULT 0 NOT NULL,
    missed_revenue_cents integer DEFAULT 0 NOT NULL,
    avg_ticket_value_cents integer DEFAULT 15000 NOT NULL,
    agent_breakdown jsonb DEFAULT '[]'::jsonb,
    daily_breakdown jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workforce_routing_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workforce_routing_history (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    team_id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    call_session_id character varying NOT NULL,
    from_agent_id character varying NOT NULL,
    to_agent_id character varying NOT NULL,
    intent character varying(100),
    routing_rule_id character varying,
    reason text,
    context_summary text,
    duration_ms integer,
    outcome character varying(50),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: workforce_routing_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workforce_routing_rules (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    team_id character varying NOT NULL,
    tenant_id character varying NOT NULL,
    intent character varying(100) NOT NULL,
    target_member_id character varying NOT NULL,
    fallback_member_id character varying,
    priority integer DEFAULT 0 NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: workforce_teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workforce_teams (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: workforce_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workforce_templates (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    tenant_id character varying,
    name character varying(255) NOT NULL,
    description text,
    vertical character varying(100),
    is_system boolean DEFAULT false NOT NULL,
    template_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: call_events_2026_03; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events ATTACH PARTITION public.call_events_2026_03 FOR VALUES FROM ('2026-03-01 00:00:00') TO ('2026-04-01 00:00:00');


--
-- Name: call_events_2026_04; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events ATTACH PARTITION public.call_events_2026_04 FOR VALUES FROM ('2026-04-01 00:00:00') TO ('2026-05-01 00:00:00');


--
-- Name: call_events_2026_05; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events ATTACH PARTITION public.call_events_2026_05 FOR VALUES FROM ('2026-05-01 00:00:00') TO ('2026-06-01 00:00:00');


--
-- Name: call_events_2026_06; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events ATTACH PARTITION public.call_events_2026_06 FOR VALUES FROM ('2026-06-01 00:00:00') TO ('2026-07-01 00:00:00');


--
-- Name: call_events_retention_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events_retention_runs ALTER COLUMN id SET DEFAULT nextval('public.call_events_retention_runs_id_seq'::regclass);


--
-- Name: connector_alert_recipients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_alert_recipients ALTER COLUMN id SET DEFAULT nextval('public.connector_alert_recipients_id_seq'::regclass);


--
-- Name: connector_stale_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_stale_alerts ALTER COLUMN id SET DEFAULT nextval('public.connector_stale_alerts_id_seq'::regclass);


--
-- Name: crm_stale_cache_scrubs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_stale_cache_scrubs ALTER COLUMN id SET DEFAULT nextval('public.crm_stale_cache_scrubs_id_seq'::regclass);


--
-- Name: dispatch_resource_location_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_location_history ALTER COLUMN id SET DEFAULT nextval('public.dispatch_resource_location_history_id_seq'::regclass);


--
-- Name: docs_feedback id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs_feedback ALTER COLUMN id SET DEFAULT nextval('public.docs_feedback_id_seq'::regclass);


--
-- Name: docs_feedback_replies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs_feedback_replies ALTER COLUMN id SET DEFAULT nextval('public.docs_feedback_replies_id_seq'::regclass);


--
-- Name: knowledge_articles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_articles ALTER COLUMN id SET DEFAULT nextval('public.knowledge_articles_id_seq'::regclass);


--
-- Name: knowledge_chunks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks ALTER COLUMN id SET DEFAULT nextval('public.knowledge_chunks_id_seq'::regclass);


--
-- Name: knowledge_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents ALTER COLUMN id SET DEFAULT nextval('public.knowledge_documents_id_seq'::regclass);


--
-- Name: marketing_lead_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_lead_events ALTER COLUMN id SET DEFAULT nextval('public.marketing_lead_events_id_seq'::regclass);


--
-- Name: marketing_leads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_leads ALTER COLUMN id SET DEFAULT nextval('public.marketing_leads_id_seq'::regclass);


--
-- Name: marketing_search_empty_queries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_search_empty_queries ALTER COLUMN id SET DEFAULT nextval('public.marketing_search_empty_queries_id_seq'::regclass);


--
-- Name: push_delivery_attempts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_delivery_attempts ALTER COLUMN id SET DEFAULT nextval('public.push_delivery_attempts_id_seq'::regclass);


--
-- Name: schema_migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations ALTER COLUMN id SET DEFAULT nextval('public.schema_migrations_id_seq'::regclass);


--
-- Name: support_email_unsubscribe_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_email_unsubscribe_audit ALTER COLUMN id SET DEFAULT nextval('public.support_email_unsubscribe_audit_id_seq'::regclass);


--
-- Name: support_routing id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_routing ALTER COLUMN id SET DEFAULT nextval('public.support_routing_id_seq'::regclass);


--
-- Name: support_ticket_replies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_replies ALTER COLUMN id SET DEFAULT nextval('public.support_ticket_replies_id_seq'::regclass);


--
-- Name: tickets ticket_number; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets ALTER COLUMN ticket_number SET DEFAULT nextval('public.tickets_ticket_number_seq'::regclass);


--
-- Name: verified_caller_alert_recipients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_caller_alert_recipients ALTER COLUMN id SET DEFAULT nextval('public.verified_caller_alert_recipients_id_seq'::regclass);


--
-- Name: vertical_demo_flows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vertical_demo_flows ALTER COLUMN id SET DEFAULT nextval('public.vertical_demo_flows_id_seq'::regclass);


--
-- Name: vertical_prompt_library id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vertical_prompt_library ALTER COLUMN id SET DEFAULT nextval('public.vertical_prompt_library_id_seq'::regclass);


--
-- Name: vertical_starter_knowledge id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vertical_starter_knowledge ALTER COLUMN id SET DEFAULT nextval('public.vertical_starter_knowledge_id_seq'::regclass);


--
-- Name: activation_events activation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_events
    ADD CONSTRAINT activation_events_pkey PRIMARY KEY (id);


--
-- Name: active_call_sessions active_call_sessions_call_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_call_sessions
    ADD CONSTRAINT active_call_sessions_call_sid_key UNIQUE (call_sid);


--
-- Name: active_call_sessions active_call_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_call_sessions
    ADD CONSTRAINT active_call_sessions_pkey PRIMARY KEY (id);


--
-- Name: legacy_agent_prompt_versions agent_prompt_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legacy_agent_prompt_versions
    ADD CONSTRAINT agent_prompt_versions_pkey PRIMARY KEY (id);


--
-- Name: agent_prompt_versions agent_prompt_versions_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_prompt_versions
    ADD CONSTRAINT agent_prompt_versions_pkey1 PRIMARY KEY (id);


--
-- Name: agent_prompts agent_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_prompts
    ADD CONSTRAINT agent_prompts_pkey PRIMARY KEY (id);


--
-- Name: agent_templates agent_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_templates
    ADD CONSTRAINT agent_templates_pkey PRIMARY KEY (id);


--
-- Name: agent_tools agent_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tools
    ADD CONSTRAINT agent_tools_pkey PRIMARY KEY (id);


--
-- Name: agent_versions agent_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_pkey PRIMARY KEY (id);


--
-- Name: agent_versions agent_versions_tenant_id_agent_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_tenant_id_agent_id_version_key UNIQUE (tenant_id, agent_id, version);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: agents agents_tenant_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_tenant_name_unique UNIQUE (tenant_id, name);


--
-- Name: ai_insights ai_insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_insights
    ADD CONSTRAINT ai_insights_pkey PRIMARY KEY (id);


--
-- Name: analytics_metrics analytics_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_metrics
    ADD CONSTRAINT analytics_metrics_pkey PRIMARY KEY (id);


--
-- Name: answering_service_logs answering_service_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.answering_service_logs
    ADD CONSTRAINT answering_service_logs_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: appointment_scheduling_dispatch appointment_scheduling_dispatch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_scheduling_dispatch
    ADD CONSTRAINT appointment_scheduling_dispatch_pkey PRIMARY KEY (tenant_id, lookup_key);


--
-- Name: assistant_actions assistant_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_actions
    ADD CONSTRAINT assistant_actions_pkey PRIMARY KEY (id);


--
-- Name: assistant_sessions assistant_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_sessions
    ADD CONSTRAINT assistant_sessions_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: autopilot_actions autopilot_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_actions
    ADD CONSTRAINT autopilot_actions_pkey PRIMARY KEY (id);


--
-- Name: autopilot_approvals autopilot_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_approvals
    ADD CONSTRAINT autopilot_approvals_pkey PRIMARY KEY (id);


--
-- Name: autopilot_impact_reports autopilot_impact_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_impact_reports
    ADD CONSTRAINT autopilot_impact_reports_pkey PRIMARY KEY (id);


--
-- Name: autopilot_insights autopilot_insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_insights
    ADD CONSTRAINT autopilot_insights_pkey PRIMARY KEY (id);


--
-- Name: autopilot_notifications autopilot_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_notifications
    ADD CONSTRAINT autopilot_notifications_pkey PRIMARY KEY (id);


--
-- Name: autopilot_policies autopilot_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_policies
    ADD CONSTRAINT autopilot_policies_pkey PRIMARY KEY (id);


--
-- Name: autopilot_recommendations autopilot_recommendations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_recommendations
    ADD CONSTRAINT autopilot_recommendations_pkey PRIMARY KEY (id);


--
-- Name: autopilot_runs autopilot_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_runs
    ADD CONSTRAINT autopilot_runs_pkey PRIMARY KEY (id);


--
-- Name: billing_events billing_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_events
    ADD CONSTRAINT billing_events_pkey PRIMARY KEY (id);


--
-- Name: billing_recommendation_events billing_recommendation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_recommendation_events
    ADD CONSTRAINT billing_recommendation_events_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: call_conversion_stages call_conversion_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_conversion_stages
    ADD CONSTRAINT call_conversion_stages_pkey PRIMARY KEY (id);


--
-- Name: call_csat_responses call_csat_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_csat_responses
    ADD CONSTRAINT call_csat_responses_pkey PRIMARY KEY (id);


--
-- Name: call_events call_events_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events
    ADD CONSTRAINT call_events_pkey1 PRIMARY KEY (id, occurred_at);


--
-- Name: call_events_2026_03 call_events_2026_03_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events_2026_03
    ADD CONSTRAINT call_events_2026_03_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: call_events_2026_04 call_events_2026_04_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events_2026_04
    ADD CONSTRAINT call_events_2026_04_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: call_events_2026_05 call_events_2026_05_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events_2026_05
    ADD CONSTRAINT call_events_2026_05_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: call_events_2026_06 call_events_2026_06_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events_2026_06
    ADD CONSTRAINT call_events_2026_06_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: call_events_retention_runs call_events_retention_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_events_retention_runs
    ADD CONSTRAINT call_events_retention_runs_pkey PRIMARY KEY (id);


--
-- Name: call_logs call_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_pkey PRIMARY KEY (id);


--
-- Name: call_quality_scores call_quality_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_quality_scores
    ADD CONSTRAINT call_quality_scores_pkey PRIMARY KEY (id);


--
-- Name: call_saved_view_pins call_saved_view_pins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_saved_view_pins
    ADD CONSTRAINT call_saved_view_pins_pkey PRIMARY KEY (user_id, view_id);


--
-- Name: call_saved_views call_saved_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_saved_views
    ADD CONSTRAINT call_saved_views_pkey PRIMARY KEY (id);


--
-- Name: call_sentiment_scores call_sentiment_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sentiment_scores
    ADD CONSTRAINT call_sentiment_scores_pkey PRIMARY KEY (id);


--
-- Name: call_sessions call_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT call_sessions_pkey PRIMARY KEY (id);


--
-- Name: call_topic_classifications call_topic_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_topic_classifications
    ADD CONSTRAINT call_topic_classifications_pkey PRIMARY KEY (id);


--
-- Name: call_transcripts call_transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_transcripts
    ADD CONSTRAINT call_transcripts_pkey PRIMARY KEY (id);


--
-- Name: callback_queue callback_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.callback_queue
    ADD CONSTRAINT callback_queue_pkey PRIMARY KEY (id);


--
-- Name: campaign_contact_attempts campaign_contact_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_contact_attempts
    ADD CONSTRAINT campaign_contact_attempts_pkey PRIMARY KEY (id);


--
-- Name: campaign_contacts campaign_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_contacts
    ADD CONSTRAINT campaign_contacts_pkey PRIMARY KEY (id);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: case_studies case_studies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_studies
    ADD CONSTRAINT case_studies_pkey PRIMARY KEY (id);


--
-- Name: case_studies case_studies_tenant_id_milestone_type_milestone_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_studies
    ADD CONSTRAINT case_studies_tenant_id_milestone_type_milestone_value_key UNIQUE (tenant_id, milestone_type, milestone_value);


--
-- Name: changelog_entries changelog_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.changelog_entries
    ADD CONSTRAINT changelog_entries_pkey PRIMARY KEY (id);


--
-- Name: changelog_reads changelog_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.changelog_reads
    ADD CONSTRAINT changelog_reads_pkey PRIMARY KEY (user_id, entry_id);


--
-- Name: connector_alert_mutes connector_alert_mutes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_alert_mutes
    ADD CONSTRAINT connector_alert_mutes_pkey PRIMARY KEY (tenant_id, scope, target);


--
-- Name: connector_alert_recipients connector_alert_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_alert_recipients
    ADD CONSTRAINT connector_alert_recipients_pkey PRIMARY KEY (id);


--
-- Name: connector_alert_settings connector_alert_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_alert_settings
    ADD CONSTRAINT connector_alert_settings_pkey PRIMARY KEY (tenant_id);


--
-- Name: connector_configs connector_configs_integration_id_config_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_configs
    ADD CONSTRAINT connector_configs_integration_id_config_key_key UNIQUE (integration_id, config_key);


--
-- Name: connector_configs connector_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_configs
    ADD CONSTRAINT connector_configs_pkey PRIMARY KEY (id);


--
-- Name: connector_stale_alerts connector_stale_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_stale_alerts
    ADD CONSTRAINT connector_stale_alerts_pkey PRIMARY KEY (id);


--
-- Name: connector_stale_alerts connector_stale_alerts_tenant_id_integration_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_stale_alerts
    ADD CONSTRAINT connector_stale_alerts_tenant_id_integration_id_key UNIQUE (tenant_id, integration_id);


--
-- Name: conversation_costs conversation_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_costs
    ADD CONSTRAINT conversation_costs_pkey PRIMARY KEY (id);


--
-- Name: conversation_costs conversation_costs_tenant_id_call_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_costs
    ADD CONSTRAINT conversation_costs_tenant_id_call_session_id_key UNIQUE (tenant_id, call_session_id);


--
-- Name: cost_budget_settings cost_budget_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_budget_settings
    ADD CONSTRAINT cost_budget_settings_pkey PRIMARY KEY (id);


--
-- Name: cost_budget_settings cost_budget_settings_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_budget_settings
    ADD CONSTRAINT cost_budget_settings_tenant_id_key UNIQUE (tenant_id);


--
-- Name: crm_caller_identities crm_caller_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_caller_identities
    ADD CONSTRAINT crm_caller_identities_pkey PRIMARY KEY (id);


--
-- Name: crm_caller_identities crm_caller_identities_tenant_id_provider_phone_e164_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_caller_identities
    ADD CONSTRAINT crm_caller_identities_tenant_id_provider_phone_e164_key UNIQUE (tenant_id, provider, phone_e164);


--
-- Name: crm_stale_cache_scrubs crm_stale_cache_scrubs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_stale_cache_scrubs
    ADD CONSTRAINT crm_stale_cache_scrubs_pkey PRIMARY KEY (id);


--
-- Name: daily_openai_costs daily_openai_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_openai_costs
    ADD CONSTRAINT daily_openai_costs_pkey PRIMARY KEY (id);


--
-- Name: daily_openai_costs daily_openai_costs_tenant_id_date_model_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_openai_costs
    ADD CONSTRAINT daily_openai_costs_tenant_id_date_model_key UNIQUE (tenant_id, date, model);


--
-- Name: daily_org_usage daily_org_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_org_usage
    ADD CONSTRAINT daily_org_usage_pkey PRIMARY KEY (id);


--
-- Name: daily_org_usage daily_org_usage_tenant_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_org_usage
    ADD CONSTRAINT daily_org_usage_tenant_id_date_key UNIQUE (tenant_id, date);


--
-- Name: daily_reconciliation daily_reconciliation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_reconciliation
    ADD CONSTRAINT daily_reconciliation_pkey PRIMARY KEY (id);


--
-- Name: demo_agents demo_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_agents
    ADD CONSTRAINT demo_agents_pkey PRIMARY KEY (id);


--
-- Name: demo_agents demo_agents_tenant_template_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_agents
    ADD CONSTRAINT demo_agents_tenant_template_unique UNIQUE (tenant_id, agent_template);


--
-- Name: demo_analytics demo_analytics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_analytics
    ADD CONSTRAINT demo_analytics_pkey PRIMARY KEY (id);


--
-- Name: demo_sessions demo_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_sessions
    ADD CONSTRAINT demo_sessions_pkey PRIMARY KEY (id);


--
-- Name: developer_submissions developer_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.developer_submissions
    ADD CONSTRAINT developer_submissions_pkey PRIMARY KEY (id);


--
-- Name: digital_twin_models digital_twin_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_twin_models
    ADD CONSTRAINT digital_twin_models_pkey PRIMARY KEY (id);


--
-- Name: digital_twin_results digital_twin_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_twin_results
    ADD CONSTRAINT digital_twin_results_pkey PRIMARY KEY (id);


--
-- Name: digital_twin_scenarios digital_twin_scenarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_twin_scenarios
    ADD CONSTRAINT digital_twin_scenarios_pkey PRIMARY KEY (id);


--
-- Name: digital_twin_simulation_runs digital_twin_simulation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_twin_simulation_runs
    ADD CONSTRAINT digital_twin_simulation_runs_pkey PRIMARY KEY (id);


--
-- Name: dispatch_assignment_rules dispatch_assignment_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_assignment_rules
    ADD CONSTRAINT dispatch_assignment_rules_pkey PRIMARY KEY (id);


--
-- Name: dispatch_job_attachments dispatch_job_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_job_attachments
    ADD CONSTRAINT dispatch_job_attachments_pkey PRIMARY KEY (id);


--
-- Name: dispatch_job_events dispatch_job_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_job_events
    ADD CONSTRAINT dispatch_job_events_pkey PRIMARY KEY (id);


--
-- Name: dispatch_job_exceptions dispatch_job_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_job_exceptions
    ADD CONSTRAINT dispatch_job_exceptions_pkey PRIMARY KEY (id);


--
-- Name: dispatch_jobs dispatch_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_jobs
    ADD CONSTRAINT dispatch_jobs_pkey PRIMARY KEY (id);


--
-- Name: dispatch_notification_templates dispatch_notification_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_notification_templates
    ADD CONSTRAINT dispatch_notification_templates_pkey PRIMARY KEY (id);


--
-- Name: dispatch_notifications_log dispatch_notifications_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_notifications_log
    ADD CONSTRAINT dispatch_notifications_log_pkey PRIMARY KEY (id);


--
-- Name: dispatch_resource_location_history dispatch_resource_location_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_location_history
    ADD CONSTRAINT dispatch_resource_location_history_pkey PRIMARY KEY (id);


--
-- Name: dispatch_resource_locations dispatch_resource_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_locations
    ADD CONSTRAINT dispatch_resource_locations_pkey PRIMARY KEY (resource_id);


--
-- Name: dispatch_resource_pairing_codes dispatch_resource_pairing_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_pairing_codes
    ADD CONSTRAINT dispatch_resource_pairing_codes_pkey PRIMARY KEY (id);


--
-- Name: dispatch_resource_skills dispatch_resource_skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_skills
    ADD CONSTRAINT dispatch_resource_skills_pkey PRIMARY KEY (id);


--
-- Name: dispatch_resource_skills dispatch_resource_skills_resource_id_skill_type_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_skills
    ADD CONSTRAINT dispatch_resource_skills_resource_id_skill_type_id_key UNIQUE (resource_id, skill_type_id);


--
-- Name: dispatch_resources dispatch_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resources
    ADD CONSTRAINT dispatch_resources_pkey PRIMARY KEY (id);


--
-- Name: dispatch_route_export_jobs dispatch_route_export_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_route_export_jobs
    ADD CONSTRAINT dispatch_route_export_jobs_pkey PRIMARY KEY (id);


--
-- Name: dispatch_skill_types dispatch_skill_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_skill_types
    ADD CONSTRAINT dispatch_skill_types_pkey PRIMARY KEY (id);


--
-- Name: dispatch_skill_types dispatch_skill_types_tenant_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_skill_types
    ADD CONSTRAINT dispatch_skill_types_tenant_id_name_key UNIQUE (tenant_id, name);


--
-- Name: dispatch_territories dispatch_territories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_territories
    ADD CONSTRAINT dispatch_territories_pkey PRIMARY KEY (id);


--
-- Name: dispatch_territories dispatch_territories_tenant_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_territories
    ADD CONSTRAINT dispatch_territories_tenant_id_name_key UNIQUE (tenant_id, name);


--
-- Name: distributed_locks distributed_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.distributed_locks
    ADD CONSTRAINT distributed_locks_pkey PRIMARY KEY (lock_name);


--
-- Name: dnc_list dnc_list_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dnc_list
    ADD CONSTRAINT dnc_list_pkey PRIMARY KEY (id);


--
-- Name: docs_feedback_alerts docs_feedback_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs_feedback_alerts
    ADD CONSTRAINT docs_feedback_alerts_pkey PRIMARY KEY (article_slug);


--
-- Name: docs_feedback docs_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs_feedback
    ADD CONSTRAINT docs_feedback_pkey PRIMARY KEY (id);


--
-- Name: docs_feedback_replies docs_feedback_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs_feedback_replies
    ADD CONSTRAINT docs_feedback_replies_pkey PRIMARY KEY (id);


--
-- Name: encrypted_fields encrypted_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encrypted_fields
    ADD CONSTRAINT encrypted_fields_pkey PRIMARY KEY (id);


--
-- Name: encryption_keys encryption_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_keys
    ADD CONSTRAINT encryption_keys_pkey PRIMARY KEY (id);


--
-- Name: error_logs error_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_logs
    ADD CONSTRAINT error_logs_pkey PRIMARY KEY (id);


--
-- Name: escalation_tasks escalation_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.escalation_tasks
    ADD CONSTRAINT escalation_tasks_pkey PRIMARY KEY (id);


--
-- Name: evolution_audit_log evolution_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evolution_audit_log
    ADD CONSTRAINT evolution_audit_log_pkey PRIMARY KEY (id);


--
-- Name: evolution_opportunities evolution_opportunities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evolution_opportunities
    ADD CONSTRAINT evolution_opportunities_pkey PRIMARY KEY (id);


--
-- Name: evolution_signals evolution_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evolution_signals
    ADD CONSTRAINT evolution_signals_pkey PRIMARY KEY (id);


--
-- Name: execution_traces execution_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_traces
    ADD CONSTRAINT execution_traces_pkey PRIMARY KEY (id);


--
-- Name: experiment_results experiment_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.experiment_results
    ADD CONSTRAINT experiment_results_pkey PRIMARY KEY (id);


--
-- Name: feature_request_clusters feature_request_clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_request_clusters
    ADD CONSTRAINT feature_request_clusters_pkey PRIMARY KEY (id);


--
-- Name: federal_dnc_numbers federal_dnc_numbers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federal_dnc_numbers
    ADD CONSTRAINT federal_dnc_numbers_pkey PRIMARY KEY (phone_number);


--
-- Name: federal_dnc_sync_state federal_dnc_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federal_dnc_sync_state
    ADD CONSTRAINT federal_dnc_sync_state_pkey PRIMARY KEY (id);


--
-- Name: forecast_models forecast_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_models
    ADD CONSTRAINT forecast_models_pkey PRIMARY KEY (id);


--
-- Name: gdpr_requests gdpr_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_requests
    ADD CONSTRAINT gdpr_requests_pkey PRIMARY KEY (id);


--
-- Name: gin_aggregation_runs gin_aggregation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gin_aggregation_runs
    ADD CONSTRAINT gin_aggregation_runs_pkey PRIMARY KEY (id);


--
-- Name: gin_policy_acceptance_records gin_policy_acceptance_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gin_policy_acceptance_records
    ADD CONSTRAINT gin_policy_acceptance_records_pkey PRIMARY KEY (id);


--
-- Name: global_insight_patterns global_insight_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_insight_patterns
    ADD CONSTRAINT global_insight_patterns_pkey PRIMARY KEY (id);


--
-- Name: global_prompt_patterns global_prompt_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_prompt_patterns
    ADD CONSTRAINT global_prompt_patterns_pkey PRIMARY KEY (id);


--
-- Name: handoff_states handoff_states_call_sid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.handoff_states
    ADD CONSTRAINT handoff_states_call_sid_key UNIQUE (call_sid);


--
-- Name: handoff_states handoff_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.handoff_states
    ADD CONSTRAINT handoff_states_pkey PRIMARY KEY (id);


--
-- Name: improvement_metrics improvement_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.improvement_metrics
    ADD CONSTRAINT improvement_metrics_pkey PRIMARY KEY (id);


--
-- Name: improvement_metrics improvement_metrics_tenant_id_agent_id_period_start_period__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.improvement_metrics
    ADD CONSTRAINT improvement_metrics_tenant_id_agent_id_period_start_period__key UNIQUE (tenant_id, agent_id, period_start, period_end);


--
-- Name: industry_benchmarks industry_benchmarks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.industry_benchmarks
    ADD CONSTRAINT industry_benchmarks_pkey PRIMARY KEY (id);


--
-- Name: ingest_events ingest_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_events
    ADD CONSTRAINT ingest_events_pkey PRIMARY KEY (id);


--
-- Name: integration_demand_scores integration_demand_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_demand_scores
    ADD CONSTRAINT integration_demand_scores_pkey PRIMARY KEY (id);


--
-- Name: integration_event_logs integration_event_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_event_logs
    ADD CONSTRAINT integration_event_logs_pkey PRIMARY KEY (id);


--
-- Name: integrations integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);


--
-- Name: integrations integrations_tenant_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_tenant_id_provider_key UNIQUE (tenant_id, provider);


--
-- Name: knowledge_articles knowledge_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_articles
    ADD CONSTRAINT knowledge_articles_pkey PRIMARY KEY (id);


--
-- Name: knowledge_chunks knowledge_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_pkey PRIMARY KEY (id);


--
-- Name: knowledge_documents knowledge_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_pkey PRIMARY KEY (id);


--
-- Name: marketing_lead_events marketing_lead_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_lead_events
    ADD CONSTRAINT marketing_lead_events_pkey PRIMARY KEY (id);


--
-- Name: marketing_leads marketing_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_leads
    ADD CONSTRAINT marketing_leads_pkey PRIMARY KEY (id);


--
-- Name: marketing_search_empty_queries marketing_search_empty_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_search_empty_queries
    ADD CONSTRAINT marketing_search_empty_queries_pkey PRIMARY KEY (id);


--
-- Name: marketplace_opportunity_scores marketplace_opportunity_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_opportunity_scores
    ADD CONSTRAINT marketplace_opportunity_scores_pkey PRIMARY KEY (id);


--
-- Name: marketplace_purchases marketplace_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_purchases
    ADD CONSTRAINT marketplace_purchases_pkey PRIMARY KEY (id);


--
-- Name: marketplace_revenue_events marketplace_revenue_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_revenue_events
    ADD CONSTRAINT marketplace_revenue_events_pkey PRIMARY KEY (id);


--
-- Name: marketplace_reviews marketplace_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reviews
    ADD CONSTRAINT marketplace_reviews_pkey PRIMARY KEY (id);


--
-- Name: marketplace_reviews marketplace_reviews_tenant_id_user_id_template_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reviews
    ADD CONSTRAINT marketplace_reviews_tenant_id_user_id_template_id_key UNIQUE (tenant_id, user_id, template_id);


--
-- Name: milestone_thresholds milestone_thresholds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.milestone_thresholds
    ADD CONSTRAINT milestone_thresholds_pkey PRIMARY KEY (id);


--
-- Name: milestone_thresholds milestone_thresholds_tenant_id_milestone_type_milestone_val_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.milestone_thresholds
    ADD CONSTRAINT milestone_thresholds_tenant_id_milestone_type_milestone_val_key UNIQUE (tenant_id, milestone_type, milestone_value);


--
-- Name: model_routing_log model_routing_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_routing_log
    ADD CONSTRAINT model_routing_log_pkey PRIMARY KEY (id);


--
-- Name: network_recommendations network_recommendations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_recommendations
    ADD CONSTRAINT network_recommendations_pkey PRIMARY KEY (id);


--
-- Name: number_routing number_routing_phone_number_id_agent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_routing
    ADD CONSTRAINT number_routing_phone_number_id_agent_id_key UNIQUE (phone_number_id, agent_id);


--
-- Name: number_routing number_routing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_routing
    ADD CONSTRAINT number_routing_pkey PRIMARY KEY (id);


--
-- Name: operations_alerts operations_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_alerts
    ADD CONSTRAINT operations_alerts_pkey PRIMARY KEY (id);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);


--
-- Name: outbox_events outbox_events_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: outbox_messages outbox_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_messages
    ADD CONSTRAINT outbox_messages_pkey PRIMARY KEY (id);


--
-- Name: outbox_messages outbox_messages_tenant_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_messages
    ADD CONSTRAINT outbox_messages_tenant_id_idempotency_key_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_key UNIQUE (token);


--
-- Name: phone_endpoints phone_endpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_endpoints
    ADD CONSTRAINT phone_endpoints_pkey PRIMARY KEY (id);


--
-- Name: phone_numbers phone_numbers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_numbers
    ADD CONSTRAINT phone_numbers_pkey PRIMARY KEY (id);


--
-- Name: phone_numbers phone_numbers_tenant_id_phone_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_numbers
    ADD CONSTRAINT phone_numbers_tenant_id_phone_number_key UNIQUE (tenant_id, phone_number);


--
-- Name: platform_settings platform_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (key);


--
-- Name: prompt_improvement_suggestions prompt_improvement_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_improvement_suggestions
    ADD CONSTRAINT prompt_improvement_suggestions_pkey PRIMARY KEY (id);


--
-- Name: prompt_versions prompt_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_pkey PRIMARY KEY (id);


--
-- Name: push_delivery_attempts push_delivery_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_delivery_attempts
    ADD CONSTRAINT push_delivery_attempts_pkey PRIMARY KEY (id);


--
-- Name: response_cache response_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response_cache
    ADD CONSTRAINT response_cache_pkey PRIMARY KEY (id);


--
-- Name: response_cache response_cache_tenant_id_cache_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response_cache
    ADD CONSTRAINT response_cache_tenant_id_cache_key_key UNIQUE (tenant_id, cache_key);


--
-- Name: retry_attempts retry_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retry_attempts
    ADD CONSTRAINT retry_attempts_pkey PRIMARY KEY (key);


--
-- Name: roadmap_recommendations roadmap_recommendations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roadmap_recommendations
    ADD CONSTRAINT roadmap_recommendations_pkey PRIMARY KEY (id);


--
-- Name: scheduling_appointment_types scheduling_appointment_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_appointment_types
    ADD CONSTRAINT scheduling_appointment_types_pkey PRIMARY KEY (id);


--
-- Name: scheduling_audit_log scheduling_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_audit_log
    ADD CONSTRAINT scheduling_audit_log_pkey PRIMARY KEY (id);


--
-- Name: scheduling_booking_rules scheduling_booking_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_booking_rules
    ADD CONSTRAINT scheduling_booking_rules_pkey PRIMARY KEY (id);


--
-- Name: scheduling_overrides scheduling_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_overrides
    ADD CONSTRAINT scheduling_overrides_pkey PRIMARY KEY (id);


--
-- Name: scheduling_provider_schedules scheduling_provider_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_provider_schedules
    ADD CONSTRAINT scheduling_provider_schedules_pkey PRIMARY KEY (id);


--
-- Name: scheduling_providers scheduling_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_providers
    ADD CONSTRAINT scheduling_providers_pkey PRIMARY KEY (id);


--
-- Name: scheduling_recurring_series scheduling_recurring_series_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_recurring_series
    ADD CONSTRAINT scheduling_recurring_series_pkey PRIMARY KEY (id);


--
-- Name: scheduling_reminder_configs scheduling_reminder_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_reminder_configs
    ADD CONSTRAINT scheduling_reminder_configs_pkey PRIMARY KEY (id);


--
-- Name: scheduling_reminder_log scheduling_reminder_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_reminder_log
    ADD CONSTRAINT scheduling_reminder_log_pkey PRIMARY KEY (id);


--
-- Name: scheduling_resources scheduling_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_resources
    ADD CONSTRAINT scheduling_resources_pkey PRIMARY KEY (id);


--
-- Name: scheduling_waitlist scheduling_waitlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_waitlist
    ADD CONSTRAINT scheduling_waitlist_pkey PRIMARY KEY (id);


--
-- Name: scheduling_workflows scheduling_workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_workflows
    ADD CONSTRAINT scheduling_workflows_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_filename_key UNIQUE (filename);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);


--
-- Name: simulation_results simulation_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_results
    ADD CONSTRAINT simulation_results_pkey PRIMARY KEY (id);


--
-- Name: simulation_runs simulation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_runs
    ADD CONSTRAINT simulation_runs_pkey PRIMARY KEY (id);


--
-- Name: simulation_scenarios simulation_scenarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_scenarios
    ADD CONSTRAINT simulation_scenarios_pkey PRIMARY KEY (id);


--
-- Name: sms_assignment_rules sms_assignment_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_assignment_rules
    ADD CONSTRAINT sms_assignment_rules_pkey PRIMARY KEY (id);


--
-- Name: sms_auto_reply_rules sms_auto_reply_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_auto_reply_rules
    ADD CONSTRAINT sms_auto_reply_rules_pkey PRIMARY KEY (id);


--
-- Name: sms_canned_responses sms_canned_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_canned_responses
    ADD CONSTRAINT sms_canned_responses_pkey PRIMARY KEY (id);


--
-- Name: sms_consent_log sms_consent_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_consent_log
    ADD CONSTRAINT sms_consent_log_pkey PRIMARY KEY (id);


--
-- Name: sms_conversation_activity_log sms_conversation_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_conversation_activity_log
    ADD CONSTRAINT sms_conversation_activity_log_pkey PRIMARY KEY (id);


--
-- Name: sms_conversations sms_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_conversations
    ADD CONSTRAINT sms_conversations_pkey PRIMARY KEY (id);


--
-- Name: sms_internal_notes sms_internal_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_internal_notes
    ADD CONSTRAINT sms_internal_notes_pkey PRIMARY KEY (id);


--
-- Name: sms_logs sms_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_logs
    ADD CONSTRAINT sms_logs_pkey PRIMARY KEY (id);


--
-- Name: sms_messages sms_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_pkey PRIMARY KEY (id);


--
-- Name: subprocessors subprocessors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subprocessors
    ADD CONSTRAINT subprocessors_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_tenant_id_key UNIQUE (tenant_id);


--
-- Name: support_email_suppressions support_email_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_email_suppressions
    ADD CONSTRAINT support_email_suppressions_pkey PRIMARY KEY (email_lower);


--
-- Name: support_email_unsubscribe_audit support_email_unsubscribe_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_email_unsubscribe_audit
    ADD CONSTRAINT support_email_unsubscribe_audit_pkey PRIMARY KEY (id);


--
-- Name: support_email_unsubscribes support_email_unsubscribes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_email_unsubscribes
    ADD CONSTRAINT support_email_unsubscribes_pkey PRIMARY KEY (email_lower);


--
-- Name: support_recipient_bounce_alerts support_recipient_bounce_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_recipient_bounce_alerts
    ADD CONSTRAINT support_recipient_bounce_alerts_pkey PRIMARY KEY (email_lower);


--
-- Name: support_routing support_routing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_routing
    ADD CONSTRAINT support_routing_pkey PRIMARY KEY (id);


--
-- Name: support_routing support_routing_plan_topic_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_routing
    ADD CONSTRAINT support_routing_plan_topic_key UNIQUE (plan, topic);


--
-- Name: support_ticket_replies support_ticket_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_replies
    ADD CONSTRAINT support_ticket_replies_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: system_metrics system_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_metrics
    ADD CONSTRAINT system_metrics_pkey PRIMARY KEY (id);


--
-- Name: template_categories template_categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_categories
    ADD CONSTRAINT template_categories_name_key UNIQUE (name);


--
-- Name: template_categories template_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_categories
    ADD CONSTRAINT template_categories_pkey PRIMARY KEY (id);


--
-- Name: template_category_map template_category_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_category_map
    ADD CONSTRAINT template_category_map_pkey PRIMARY KEY (template_id, category_id);


--
-- Name: template_changelogs template_changelogs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_changelogs
    ADD CONSTRAINT template_changelogs_pkey PRIMARY KEY (id);


--
-- Name: template_entitlements template_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_entitlements
    ADD CONSTRAINT template_entitlements_pkey PRIMARY KEY (id);


--
-- Name: template_entitlements template_entitlements_template_id_plan_tier_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_entitlements
    ADD CONSTRAINT template_entitlements_template_id_plan_tier_key UNIQUE (template_id, plan_tier);


--
-- Name: template_install_events template_install_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_install_events
    ADD CONSTRAINT template_install_events_pkey PRIMARY KEY (id);


--
-- Name: template_registry template_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_registry
    ADD CONSTRAINT template_registry_pkey PRIMARY KEY (id);


--
-- Name: template_registry template_registry_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_registry
    ADD CONSTRAINT template_registry_slug_key UNIQUE (slug);


--
-- Name: template_versions template_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_versions
    ADD CONSTRAINT template_versions_pkey PRIMARY KEY (id);


--
-- Name: template_versions template_versions_template_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_versions
    ADD CONSTRAINT template_versions_template_id_version_key UNIQUE (template_id, version);


--
-- Name: tenant_agent_installations tenant_agent_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_agent_installations
    ADD CONSTRAINT tenant_agent_installations_pkey PRIMARY KEY (id);


--
-- Name: tenant_agent_installations tenant_agent_installations_tenant_id_template_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_agent_installations
    ADD CONSTRAINT tenant_agent_installations_tenant_id_template_id_key UNIQUE (tenant_id, template_id);


--
-- Name: tenant_deletion_requests tenant_deletion_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_deletion_requests
    ADD CONSTRAINT tenant_deletion_requests_pkey PRIMARY KEY (id);


--
-- Name: tenant_isolation_tests tenant_isolation_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_isolation_tests
    ADD CONSTRAINT tenant_isolation_tests_pkey PRIMARY KEY (id);


--
-- Name: tenant_notifications tenant_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_notifications
    ADD CONSTRAINT tenant_notifications_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_slug_key UNIQUE (slug);


--
-- Name: ticket_activity_log ticket_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_activity_log
    ADD CONSTRAINT ticket_activity_log_pkey PRIMARY KEY (id);


--
-- Name: ticket_attachments ticket_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_pkey PRIMARY KEY (id);


--
-- Name: ticket_categories ticket_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_categories
    ADD CONSTRAINT ticket_categories_pkey PRIMARY KEY (id);


--
-- Name: ticket_custom_field_values ticket_custom_field_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_custom_field_values
    ADD CONSTRAINT ticket_custom_field_values_pkey PRIMARY KEY (id);


--
-- Name: ticket_custom_field_values ticket_custom_field_values_ticket_id_field_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_custom_field_values
    ADD CONSTRAINT ticket_custom_field_values_ticket_id_field_id_key UNIQUE (ticket_id, field_id);


--
-- Name: ticket_custom_fields ticket_custom_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_custom_fields
    ADD CONSTRAINT ticket_custom_fields_pkey PRIMARY KEY (id);


--
-- Name: ticket_custom_fields ticket_custom_fields_tenant_id_field_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_custom_fields
    ADD CONSTRAINT ticket_custom_fields_tenant_id_field_key_key UNIQUE (tenant_id, field_key);


--
-- Name: ticket_links ticket_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_links
    ADD CONSTRAINT ticket_links_pkey PRIMARY KEY (id);


--
-- Name: ticket_links ticket_links_source_ticket_id_target_ticket_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_links
    ADD CONSTRAINT ticket_links_source_ticket_id_target_ticket_id_key UNIQUE (source_ticket_id, target_ticket_id);


--
-- Name: ticket_macros ticket_macros_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_macros
    ADD CONSTRAINT ticket_macros_pkey PRIMARY KEY (id);


--
-- Name: ticket_notifications ticket_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notifications
    ADD CONSTRAINT ticket_notifications_pkey PRIMARY KEY (id);


--
-- Name: ticket_outbox ticket_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_outbox
    ADD CONSTRAINT ticket_outbox_pkey PRIMARY KEY (id);


--
-- Name: ticket_queue_configs ticket_queue_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_queue_configs
    ADD CONSTRAINT ticket_queue_configs_pkey PRIMARY KEY (id);


--
-- Name: ticket_retention_policies ticket_retention_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_retention_policies
    ADD CONSTRAINT ticket_retention_policies_pkey PRIMARY KEY (id);


--
-- Name: ticket_saved_views ticket_saved_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_saved_views
    ADD CONSTRAINT ticket_saved_views_pkey PRIMARY KEY (id);


--
-- Name: ticket_sla_instances ticket_sla_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_sla_instances
    ADD CONSTRAINT ticket_sla_instances_pkey PRIMARY KEY (id);


--
-- Name: ticket_sla_policies ticket_sla_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_sla_policies
    ADD CONSTRAINT ticket_sla_policies_pkey PRIMARY KEY (id);


--
-- Name: ticket_templates ticket_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_templates
    ADD CONSTRAINT ticket_templates_pkey PRIMARY KEY (id);


--
-- Name: ticket_watchers ticket_watchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_watchers
    ADD CONSTRAINT ticket_watchers_pkey PRIMARY KEY (id);


--
-- Name: ticket_watchers ticket_watchers_ticket_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_watchers
    ADD CONSTRAINT ticket_watchers_ticket_id_user_id_key UNIQUE (ticket_id, user_id);


--
-- Name: ticket_workflow_rules ticket_workflow_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_workflow_rules
    ADD CONSTRAINT ticket_workflow_rules_pkey PRIMARY KEY (id);


--
-- Name: tickets tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);


--
-- Name: tool_failure_events tool_failure_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_failure_events
    ADD CONSTRAINT tool_failure_events_pkey PRIMARY KEY (id);


--
-- Name: tool_invocations tool_invocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_invocations
    ADD CONSTRAINT tool_invocations_pkey PRIMARY KEY (id);


--
-- Name: tool_rate_limits tool_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_rate_limits
    ADD CONSTRAINT tool_rate_limits_pkey PRIMARY KEY (id);


--
-- Name: tool_rate_limits tool_rate_limits_tenant_id_tool_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_rate_limits
    ADD CONSTRAINT tool_rate_limits_tenant_id_tool_name_key UNIQUE (tenant_id, tool_name);


--
-- Name: tooltip_dismissals tooltip_dismissals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooltip_dismissals
    ADD CONSTRAINT tooltip_dismissals_pkey PRIMARY KEY (id);


--
-- Name: tooltip_dismissals tooltip_dismissals_user_id_tooltip_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooltip_dismissals
    ADD CONSTRAINT tooltip_dismissals_user_id_tooltip_key_key UNIQUE (user_id, tooltip_key);


--
-- Name: twilio_webhook_replay_nonces twilio_webhook_replay_nonces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twilio_webhook_replay_nonces
    ADD CONSTRAINT twilio_webhook_replay_nonces_pkey PRIMARY KEY (nonce);


--
-- Name: call_conversion_stages uq_conversion_stage_per_call; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_conversion_stages
    ADD CONSTRAINT uq_conversion_stage_per_call UNIQUE (tenant_id, call_session_id, stage);


--
-- Name: call_sentiment_scores uq_sentiment_per_call; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sentiment_scores
    ADD CONSTRAINT uq_sentiment_per_call UNIQUE (tenant_id, call_session_id);


--
-- Name: call_topic_classifications uq_topic_per_call; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_topic_classifications
    ADD CONSTRAINT uq_topic_per_call UNIQUE (tenant_id, call_session_id);


--
-- Name: usage_metrics usage_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_metrics
    ADD CONSTRAINT usage_metrics_pkey PRIMARY KEY (id);


--
-- Name: usage_metrics usage_metrics_tenant_id_metric_type_period_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_metrics
    ADD CONSTRAINT usage_metrics_tenant_id_metric_type_period_start_key UNIQUE (tenant_id, metric_type, period_start);


--
-- Name: user_devices user_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_pkey PRIMARY KEY (id);


--
-- Name: user_devices user_devices_tenant_id_push_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_tenant_id_push_token_key UNIQUE (tenant_id, push_token);


--
-- Name: user_invitations user_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invitations
    ADD CONSTRAINT user_invitations_pkey PRIMARY KEY (id);


--
-- Name: user_invitations user_invitations_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invitations
    ADD CONSTRAINT user_invitations_token_key UNIQUE (token);


--
-- Name: user_notification_preferences user_notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_preferences
    ADD CONSTRAINT user_notification_preferences_pkey PRIMARY KEY (user_id, category, channel);


--
-- Name: user_roles user_tenant_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_tenant_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_tenant_roles_user_id_tenant_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_tenant_roles_user_id_tenant_id_role_key UNIQUE (user_id, tenant_id, role);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verified_caller_alert_recipients verified_caller_alert_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_caller_alert_recipients
    ADD CONSTRAINT verified_caller_alert_recipients_pkey PRIMARY KEY (id);


--
-- Name: verified_caller_ids verified_caller_ids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_caller_ids
    ADD CONSTRAINT verified_caller_ids_pkey PRIMARY KEY (id);


--
-- Name: verified_caller_ids verified_caller_ids_tenant_id_phone_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_caller_ids
    ADD CONSTRAINT verified_caller_ids_tenant_id_phone_number_key UNIQUE (tenant_id, phone_number);


--
-- Name: vertical_demo_flows vertical_demo_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vertical_demo_flows
    ADD CONSTRAINT vertical_demo_flows_pkey PRIMARY KEY (id);


--
-- Name: vertical_expansion_scores vertical_expansion_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vertical_expansion_scores
    ADD CONSTRAINT vertical_expansion_scores_pkey PRIMARY KEY (id);


--
-- Name: vertical_prompt_library vertical_prompt_library_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vertical_prompt_library
    ADD CONSTRAINT vertical_prompt_library_pkey PRIMARY KEY (id);


--
-- Name: vertical_prompt_library vertical_prompt_library_vertical_id_category_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vertical_prompt_library
    ADD CONSTRAINT vertical_prompt_library_vertical_id_category_version_key UNIQUE (vertical_id, category, version);


--
-- Name: vertical_starter_knowledge vertical_starter_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vertical_starter_knowledge
    ADD CONSTRAINT vertical_starter_knowledge_pkey PRIMARY KEY (id);


--
-- Name: webhook_events webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);


--
-- Name: website_agent_analytics website_agent_analytics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_agent_analytics
    ADD CONSTRAINT website_agent_analytics_pkey PRIMARY KEY (id);


--
-- Name: website_agent_conversations website_agent_conversations_conversation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_agent_conversations
    ADD CONSTRAINT website_agent_conversations_conversation_id_key UNIQUE (conversation_id);


--
-- Name: website_agent_conversations website_agent_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_agent_conversations
    ADD CONSTRAINT website_agent_conversations_pkey PRIMARY KEY (id);


--
-- Name: website_conversion_events website_conversion_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_conversion_events
    ADD CONSTRAINT website_conversion_events_pkey PRIMARY KEY (id);


--
-- Name: website_leads website_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_leads
    ADD CONSTRAINT website_leads_pkey PRIMARY KEY (id);


--
-- Name: weekly_reports weekly_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_reports
    ADD CONSTRAINT weekly_reports_pkey PRIMARY KEY (id);


--
-- Name: widget_configs widget_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.widget_configs
    ADD CONSTRAINT widget_configs_pkey PRIMARY KEY (id);


--
-- Name: widget_configs widget_configs_tenant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.widget_configs
    ADD CONSTRAINT widget_configs_tenant_id_key UNIQUE (tenant_id);


--
-- Name: widget_tokens widget_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.widget_tokens
    ADD CONSTRAINT widget_tokens_pkey PRIMARY KEY (id);


--
-- Name: widget_tokens widget_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.widget_tokens
    ADD CONSTRAINT widget_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: workflow_executions workflow_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_executions
    ADD CONSTRAINT workflow_executions_pkey PRIMARY KEY (id);


--
-- Name: workflow_performance_metrics workflow_performance_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_performance_metrics
    ADD CONSTRAINT workflow_performance_metrics_pkey PRIMARY KEY (id);


--
-- Name: workflow_steps workflow_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_steps
    ADD CONSTRAINT workflow_steps_pkey PRIMARY KEY (id);


--
-- Name: workflows workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);


--
-- Name: workforce_members workforce_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_members
    ADD CONSTRAINT workforce_members_pkey PRIMARY KEY (id);


--
-- Name: workforce_members workforce_members_team_id_agent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_members
    ADD CONSTRAINT workforce_members_team_id_agent_id_key UNIQUE (team_id, agent_id);


--
-- Name: workforce_optimization_insights workforce_optimization_insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_optimization_insights
    ADD CONSTRAINT workforce_optimization_insights_pkey PRIMARY KEY (id);


--
-- Name: workforce_outbound_tasks workforce_outbound_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_outbound_tasks
    ADD CONSTRAINT workforce_outbound_tasks_pkey PRIMARY KEY (id);


--
-- Name: workforce_revenue_metrics workforce_revenue_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_revenue_metrics
    ADD CONSTRAINT workforce_revenue_metrics_pkey PRIMARY KEY (id);


--
-- Name: workforce_routing_history workforce_routing_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_routing_history
    ADD CONSTRAINT workforce_routing_history_pkey PRIMARY KEY (id);


--
-- Name: workforce_routing_rules workforce_routing_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_routing_rules
    ADD CONSTRAINT workforce_routing_rules_pkey PRIMARY KEY (id);


--
-- Name: workforce_teams workforce_teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_teams
    ADD CONSTRAINT workforce_teams_pkey PRIMARY KEY (id);


--
-- Name: workforce_templates workforce_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_templates
    ADD CONSTRAINT workforce_templates_pkey PRIMARY KEY (id);


--
-- Name: billing_events_stripe_event_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX billing_events_stripe_event_id_unique ON public.billing_events USING btree (stripe_event_id) WHERE (stripe_event_id IS NOT NULL);


--
-- Name: idx_call_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_session ON ONLY public.call_events USING btree (call_session_id);


--
-- Name: call_events_2026_03_call_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_03_call_session_id_idx ON public.call_events_2026_03 USING btree (call_session_id);


--
-- Name: idx_call_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_type ON ONLY public.call_events USING btree (event_type);


--
-- Name: call_events_2026_03_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_03_event_type_idx ON public.call_events_2026_03 USING btree (event_type);


--
-- Name: idx_call_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_tenant ON ONLY public.call_events USING btree (tenant_id);


--
-- Name: call_events_2026_03_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_03_tenant_id_idx ON public.call_events_2026_03 USING btree (tenant_id);


--
-- Name: idx_call_events_tenant_occurred_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_tenant_occurred_type ON ONLY public.call_events USING btree (tenant_id, occurred_at DESC, event_type);


--
-- Name: call_events_2026_03_tenant_id_occurred_at_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_03_tenant_id_occurred_at_event_type_idx ON public.call_events_2026_03 USING btree (tenant_id, occurred_at DESC, event_type);


--
-- Name: idx_call_events_tenant_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_tenant_occurred ON ONLY public.call_events USING btree (tenant_id, occurred_at DESC);


--
-- Name: call_events_2026_03_tenant_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_03_tenant_id_occurred_at_idx ON public.call_events_2026_03 USING btree (tenant_id, occurred_at DESC);


--
-- Name: call_events_2026_04_call_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_04_call_session_id_idx ON public.call_events_2026_04 USING btree (call_session_id);


--
-- Name: call_events_2026_04_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_04_event_type_idx ON public.call_events_2026_04 USING btree (event_type);


--
-- Name: call_events_2026_04_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_04_tenant_id_idx ON public.call_events_2026_04 USING btree (tenant_id);


--
-- Name: call_events_2026_04_tenant_id_occurred_at_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_04_tenant_id_occurred_at_event_type_idx ON public.call_events_2026_04 USING btree (tenant_id, occurred_at DESC, event_type);


--
-- Name: call_events_2026_04_tenant_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_04_tenant_id_occurred_at_idx ON public.call_events_2026_04 USING btree (tenant_id, occurred_at DESC);


--
-- Name: call_events_2026_05_call_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_05_call_session_id_idx ON public.call_events_2026_05 USING btree (call_session_id);


--
-- Name: call_events_2026_05_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_05_event_type_idx ON public.call_events_2026_05 USING btree (event_type);


--
-- Name: call_events_2026_05_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_05_tenant_id_idx ON public.call_events_2026_05 USING btree (tenant_id);


--
-- Name: call_events_2026_05_tenant_id_occurred_at_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_05_tenant_id_occurred_at_event_type_idx ON public.call_events_2026_05 USING btree (tenant_id, occurred_at DESC, event_type);


--
-- Name: call_events_2026_05_tenant_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_05_tenant_id_occurred_at_idx ON public.call_events_2026_05 USING btree (tenant_id, occurred_at DESC);


--
-- Name: call_events_2026_06_call_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_06_call_session_id_idx ON public.call_events_2026_06 USING btree (call_session_id);


--
-- Name: call_events_2026_06_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_06_event_type_idx ON public.call_events_2026_06 USING btree (event_type);


--
-- Name: call_events_2026_06_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_06_tenant_id_idx ON public.call_events_2026_06 USING btree (tenant_id);


--
-- Name: call_events_2026_06_tenant_id_occurred_at_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_06_tenant_id_occurred_at_event_type_idx ON public.call_events_2026_06 USING btree (tenant_id, occurred_at DESC, event_type);


--
-- Name: call_events_2026_06_tenant_id_occurred_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_events_2026_06_tenant_id_occurred_at_idx ON public.call_events_2026_06 USING btree (tenant_id, occurred_at DESC);


--
-- Name: docs_feedback_alerts_last_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX docs_feedback_alerts_last_idx ON public.docs_feedback_alerts USING btree (last_alerted_at DESC);


--
-- Name: docs_feedback_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX docs_feedback_created_idx ON public.docs_feedback USING btree (created_at DESC);


--
-- Name: docs_feedback_pending_reply_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX docs_feedback_pending_reply_idx ON public.docs_feedback USING btree (created_at) WHERE ((reply_email IS NOT NULL) AND (reply_count = 0) AND ((status)::text <> 'hidden'::text));


--
-- Name: docs_feedback_replies_failed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX docs_feedback_replies_failed_idx ON public.docs_feedback_replies USING btree (created_at DESC) WHERE (email_error IS NOT NULL);


--
-- Name: docs_feedback_replies_feedback_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX docs_feedback_replies_feedback_idx ON public.docs_feedback_replies USING btree (feedback_id, created_at DESC);


--
-- Name: docs_feedback_replies_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX docs_feedback_replies_retry_idx ON public.docs_feedback_replies USING btree (created_at) WHERE (email_error IS NOT NULL);


--
-- Name: docs_feedback_replies_retry_of_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX docs_feedback_replies_retry_of_idx ON public.docs_feedback_replies USING btree (retry_of) WHERE (retry_of IS NOT NULL);


--
-- Name: docs_feedback_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX docs_feedback_slug_idx ON public.docs_feedback USING btree (article_slug);


--
-- Name: docs_feedback_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX docs_feedback_status_idx ON public.docs_feedback USING btree (status);


--
-- Name: idx_activation_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activation_events_tenant ON public.activation_events USING btree (tenant_id);


--
-- Name: idx_activation_events_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_activation_events_unique ON public.activation_events USING btree (tenant_id, event_type);


--
-- Name: idx_active_call_sessions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_active_call_sessions_tenant ON public.active_call_sessions USING btree (tenant_id);


--
-- Name: idx_agent_prompt_versions_prompt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_prompt_versions_prompt ON public.legacy_agent_prompt_versions USING btree (agent_prompt_id);


--
-- Name: idx_agent_prompts_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_prompts_agent ON public.agent_prompts USING btree (agent_id);


--
-- Name: idx_agent_templates_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_templates_tenant_created ON public.agent_templates USING btree (tenant_id, created_at DESC);


--
-- Name: idx_agent_templates_tenant_shared; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_templates_tenant_shared ON public.agent_templates USING btree (tenant_id) WHERE (is_shared = true);


--
-- Name: idx_agent_tools_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tools_agent ON public.agent_tools USING btree (agent_id);


--
-- Name: idx_agent_tools_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tools_tenant ON public.agent_tools USING btree (tenant_id);


--
-- Name: idx_agent_versions_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_versions_agent ON public.agent_versions USING btree (agent_id, tenant_id);


--
-- Name: idx_agent_versions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_versions_status ON public.agent_versions USING btree (tenant_id, status);


--
-- Name: idx_agents_remote; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_remote ON public.agents USING btree (tenant_id, remote_system, remote_agent_id) WHERE ((execution_mode)::text = 'federated'::text);


--
-- Name: idx_agents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_status ON public.agents USING btree (status);


--
-- Name: idx_agents_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_tenant ON public.agents USING btree (tenant_id);


--
-- Name: idx_agents_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_agents_tenant_id ON public.agents USING btree (tenant_id, id);


--
-- Name: idx_agents_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_tenant_status ON public.agents USING btree (tenant_id, status);


--
-- Name: idx_agents_tenant_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_tenant_type ON public.agents USING btree (tenant_id, type);


--
-- Name: idx_agents_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agents_type ON public.agents USING btree (type);


--
-- Name: idx_ai_insights_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_insights_category ON public.ai_insights USING btree (tenant_id, category);


--
-- Name: idx_ai_insights_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_insights_status ON public.ai_insights USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_ai_insights_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_insights_tenant ON public.ai_insights USING btree (tenant_id, created_at DESC);


--
-- Name: idx_analytics_metrics_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_metrics_recorded ON public.analytics_metrics USING btree (recorded_at);


--
-- Name: idx_analytics_metrics_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_metrics_tenant ON public.analytics_metrics USING btree (tenant_id);


--
-- Name: idx_analytics_metrics_tenant_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_metrics_tenant_name ON public.analytics_metrics USING btree (tenant_id, metric_name);


--
-- Name: idx_analytics_metrics_tenant_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_metrics_tenant_recorded ON public.analytics_metrics USING btree (tenant_id, recorded_at DESC);


--
-- Name: idx_analytics_metrics_tenant_recorded_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analytics_metrics_tenant_recorded_name ON public.analytics_metrics USING btree (tenant_id, recorded_at DESC, metric_name);


--
-- Name: idx_answering_service_logs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_answering_service_logs_tenant ON public.answering_service_logs USING btree (tenant_id);


--
-- Name: idx_api_keys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_api_keys_hash ON public.api_keys USING btree (key_hash);


--
-- Name: idx_api_keys_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_tenant ON public.api_keys USING btree (tenant_id);


--
-- Name: idx_appt_sched_dispatch_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appt_sched_dispatch_tenant ON public.appointment_scheduling_dispatch USING btree (tenant_id);


--
-- Name: idx_assistant_actions_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assistant_actions_session ON public.assistant_actions USING btree (session_id);


--
-- Name: idx_assistant_actions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assistant_actions_tenant ON public.assistant_actions USING btree (tenant_id);


--
-- Name: idx_assistant_actions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assistant_actions_type ON public.assistant_actions USING btree (action_type);


--
-- Name: idx_assistant_sessions_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assistant_sessions_created ON public.assistant_sessions USING btree (created_at DESC);


--
-- Name: idx_assistant_sessions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assistant_sessions_tenant ON public.assistant_sessions USING btree (tenant_id);


--
-- Name: idx_assistant_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assistant_sessions_user ON public.assistant_sessions USING btree (user_id);


--
-- Name: idx_audit_logs_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_action ON public.audit_logs USING btree (tenant_id, action);


--
-- Name: idx_audit_logs_action_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_action_occurred ON public.audit_logs USING btree (tenant_id, action, occurred_at DESC);


--
-- Name: idx_audit_logs_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_actor ON public.audit_logs USING btree (actor_user_id);


--
-- Name: idx_audit_logs_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_occurred ON public.audit_logs USING btree (action, occurred_at DESC);


--
-- Name: idx_audit_logs_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_resource ON public.audit_logs USING btree (resource_type, resource_id);


--
-- Name: idx_audit_logs_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_severity ON public.audit_logs USING btree (severity);


--
-- Name: idx_audit_logs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_tenant ON public.audit_logs USING btree (tenant_id);


--
-- Name: idx_audit_logs_tenant_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_tenant_occurred ON public.audit_logs USING btree (tenant_id, occurred_at);


--
-- Name: idx_audit_logs_tenant_occurred_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_tenant_occurred_action ON public.audit_logs USING btree (tenant_id, occurred_at DESC, action);


--
-- Name: idx_autopilot_actions_rec; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_actions_rec ON public.autopilot_actions USING btree (recommendation_id);


--
-- Name: idx_autopilot_actions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_actions_status ON public.autopilot_actions USING btree (tenant_id, status);


--
-- Name: idx_autopilot_actions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_actions_tenant ON public.autopilot_actions USING btree (tenant_id, created_at DESC);


--
-- Name: idx_autopilot_approvals_rec; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_approvals_rec ON public.autopilot_approvals USING btree (recommendation_id);


--
-- Name: idx_autopilot_approvals_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_approvals_tenant ON public.autopilot_approvals USING btree (tenant_id, created_at DESC);


--
-- Name: idx_autopilot_impact_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_impact_action ON public.autopilot_impact_reports USING btree (action_id);


--
-- Name: idx_autopilot_impact_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_impact_tenant ON public.autopilot_impact_reports USING btree (tenant_id, created_at DESC);


--
-- Name: idx_autopilot_insights_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_insights_category ON public.autopilot_insights USING btree (tenant_id, category);


--
-- Name: idx_autopilot_insights_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_insights_severity ON public.autopilot_insights USING btree (tenant_id, severity);


--
-- Name: idx_autopilot_insights_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_insights_status ON public.autopilot_insights USING btree (tenant_id, status);


--
-- Name: idx_autopilot_insights_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_insights_tenant ON public.autopilot_insights USING btree (tenant_id, created_at DESC);


--
-- Name: idx_autopilot_notif_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_notif_tenant ON public.autopilot_notifications USING btree (tenant_id, created_at DESC);


--
-- Name: idx_autopilot_notif_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_notif_unread ON public.autopilot_notifications USING btree (tenant_id, read, created_at DESC);


--
-- Name: idx_autopilot_policies_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_policies_action ON public.autopilot_policies USING btree (tenant_id, action_type);


--
-- Name: idx_autopilot_policies_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_policies_tenant ON public.autopilot_policies USING btree (tenant_id);


--
-- Name: idx_autopilot_recs_insight; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_recs_insight ON public.autopilot_recommendations USING btree (insight_id);


--
-- Name: idx_autopilot_recs_risk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_recs_risk ON public.autopilot_recommendations USING btree (tenant_id, risk_tier);


--
-- Name: idx_autopilot_recs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_recs_status ON public.autopilot_recommendations USING btree (tenant_id, status);


--
-- Name: idx_autopilot_recs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_recs_tenant ON public.autopilot_recommendations USING btree (tenant_id, created_at DESC);


--
-- Name: idx_autopilot_runs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_autopilot_runs_tenant ON public.autopilot_runs USING btree (tenant_id, created_at DESC);


--
-- Name: idx_billing_events_stripe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_events_stripe ON public.billing_events USING btree (stripe_event_id);


--
-- Name: idx_billing_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_events_tenant ON public.billing_events USING btree (tenant_id);


--
-- Name: idx_billing_events_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_events_tenant_created ON public.billing_events USING btree (tenant_id, created_at);


--
-- Name: idx_billing_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_events_type ON public.billing_events USING btree (tenant_id, event_type);


--
-- Name: idx_billing_recommendation_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_recommendation_events_created ON public.billing_recommendation_events USING btree (created_at DESC);


--
-- Name: idx_billing_recommendation_events_discount; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_recommendation_events_discount ON public.billing_recommendation_events USING btree (coupon_id, promotion_code, created_at DESC) WHERE ((event_type)::text = ANY ((ARRAY['discount_impression'::character varying, 'discount_click'::character varying, 'discount_switch_completed'::character varying])::text[]));


--
-- Name: idx_billing_recommendation_events_pitch_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_recommendation_events_pitch_created ON public.billing_recommendation_events USING btree (pitch, created_at DESC);


--
-- Name: idx_billing_recommendation_events_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_recommendation_events_tenant_created ON public.billing_recommendation_events USING btree (tenant_id, created_at DESC);


--
-- Name: idx_billing_recommendation_events_type_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_recommendation_events_type_created ON public.billing_recommendation_events USING btree (event_type, created_at DESC);


--
-- Name: idx_bookings_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_provider ON public.bookings USING btree (provider_id);


--
-- Name: idx_bookings_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_resource ON public.bookings USING btree (resource_id);


--
-- Name: idx_bookings_series; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_series ON public.bookings USING btree (recurring_series_id);


--
-- Name: idx_bookings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_status ON public.bookings USING btree (tenant_id, status);


--
-- Name: idx_bookings_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_tenant ON public.bookings USING btree (tenant_id);


--
-- Name: idx_bookings_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_time ON public.bookings USING btree (tenant_id, start_time);


--
-- Name: idx_bookings_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_type ON public.bookings USING btree (appointment_type_id);


--
-- Name: idx_call_conversion_stages_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_conversion_stages_session ON public.call_conversion_stages USING btree (call_session_id);


--
-- Name: idx_call_conversion_stages_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_conversion_stages_stage ON public.call_conversion_stages USING btree (tenant_id, stage, reached_at);


--
-- Name: idx_call_conversion_stages_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_conversion_stages_tenant ON public.call_conversion_stages USING btree (tenant_id);


--
-- Name: idx_call_csat_dispatch_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_call_csat_dispatch_token ON public.call_csat_responses USING btree (dispatch_token) WHERE (dispatch_token IS NOT NULL);


--
-- Name: idx_call_csat_one_active_per_session; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_call_csat_one_active_per_session ON public.call_csat_responses USING btree (call_session_id) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'responded'::character varying])::text[]));


--
-- Name: idx_call_csat_pending_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_csat_pending_expiry ON public.call_csat_responses USING btree (expires_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_call_csat_pending_sms_dispatch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_csat_pending_sms_dispatch ON public.call_csat_responses USING btree (tenant_id, dispatch_to) WHERE (((status)::text = 'pending'::text) AND ((request_channel)::text = 'sms'::text));


--
-- Name: idx_call_csat_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_csat_session ON public.call_csat_responses USING btree (call_session_id);


--
-- Name: idx_call_csat_tenant_responded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_csat_tenant_responded ON public.call_csat_responses USING btree (tenant_id, responded_at DESC) WHERE ((status)::text = 'responded'::text);


--
-- Name: idx_call_events_retention_runs_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_events_retention_runs_started_at ON public.call_events_retention_runs USING btree (started_at DESC);


--
-- Name: idx_call_logs_call_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_logs_call_sid ON public.call_logs USING btree (call_sid);


--
-- Name: idx_call_logs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_logs_tenant ON public.call_logs USING btree (tenant_id);


--
-- Name: idx_call_logs_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_logs_tenant_created ON public.call_logs USING btree (tenant_id, created_at);


--
-- Name: idx_call_quality_scored_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_quality_scored_at ON public.call_quality_scores USING btree (tenant_id, scored_at);


--
-- Name: idx_call_quality_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_quality_session ON public.call_quality_scores USING btree (call_session_id);


--
-- Name: idx_call_quality_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_quality_tenant ON public.call_quality_scores USING btree (tenant_id);


--
-- Name: idx_call_saved_view_pins_tenant_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_saved_view_pins_tenant_user ON public.call_saved_view_pins USING btree (tenant_id, user_id);


--
-- Name: idx_call_saved_view_pins_user_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_saved_view_pins_user_order ON public.call_saved_view_pins USING btree (user_id, pin_order);


--
-- Name: idx_call_saved_view_pins_view; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_saved_view_pins_view ON public.call_saved_view_pins USING btree (view_id);


--
-- Name: idx_call_saved_views_digest_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_saved_views_digest_enabled ON public.call_saved_views USING btree (tenant_id) WHERE (digest_enabled = true);


--
-- Name: idx_call_saved_views_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_saved_views_owner ON public.call_saved_views USING btree (tenant_id, created_by);


--
-- Name: idx_call_saved_views_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_saved_views_tenant ON public.call_saved_views USING btree (tenant_id);


--
-- Name: idx_call_sentiment_scores_scored_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sentiment_scores_scored_at ON public.call_sentiment_scores USING btree (tenant_id, scored_at);


--
-- Name: idx_call_sentiment_scores_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sentiment_scores_session ON public.call_sentiment_scores USING btree (call_session_id);


--
-- Name: idx_call_sentiment_scores_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sentiment_scores_tenant ON public.call_sentiment_scores USING btree (tenant_id);


--
-- Name: idx_call_sessions_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_agent ON public.call_sessions USING btree (agent_id);


--
-- Name: idx_call_sessions_call_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_call_id ON public.call_sessions USING btree (call_id);


--
-- Name: idx_call_sessions_call_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_call_sid ON public.call_sessions USING btree (call_sid);


--
-- Name: idx_call_sessions_caller; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_caller ON public.call_sessions USING btree (tenant_id, caller_number);


--
-- Name: idx_call_sessions_direction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_direction ON public.call_sessions USING btree (tenant_id, direction);


--
-- Name: idx_call_sessions_external_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_call_sessions_external_unique ON public.call_sessions USING btree (tenant_id, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: idx_call_sessions_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_state ON public.call_sessions USING btree (lifecycle_state);


--
-- Name: idx_call_sessions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_tenant ON public.call_sessions USING btree (tenant_id);


--
-- Name: idx_call_sessions_tenant_call_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_tenant_call_id ON public.call_sessions USING btree (tenant_id, call_id) WHERE (call_id IS NOT NULL);


--
-- Name: idx_call_sessions_tenant_created_language; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_tenant_created_language ON public.call_sessions USING btree (tenant_id, created_at DESC, language);


--
-- Name: idx_call_sessions_tenant_created_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_tenant_created_state ON public.call_sessions USING btree (tenant_id, created_at DESC, lifecycle_state);


--
-- Name: idx_call_sessions_tenant_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_tenant_start ON public.call_sessions USING btree (tenant_id, start_time);


--
-- Name: idx_call_sessions_tenant_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_tenant_state ON public.call_sessions USING btree (tenant_id, lifecycle_state);


--
-- Name: idx_call_sessions_tenant_workflow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_tenant_workflow ON public.call_sessions USING btree (tenant_id, workflow_id) WHERE (workflow_id IS NOT NULL);


--
-- Name: idx_call_sessions_workflow_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_sessions_workflow_id ON public.call_sessions USING btree (workflow_id);


--
-- Name: idx_call_topic_classifications_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_topic_classifications_session ON public.call_topic_classifications USING btree (call_session_id);


--
-- Name: idx_call_topic_classifications_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_topic_classifications_tenant ON public.call_topic_classifications USING btree (tenant_id);


--
-- Name: idx_call_topic_classifications_topic; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_topic_classifications_topic ON public.call_topic_classifications USING btree (tenant_id, primary_topic);


--
-- Name: idx_call_transcripts_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_transcripts_session ON public.call_transcripts USING btree (call_session_id);


--
-- Name: idx_call_transcripts_session_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_transcripts_session_seq ON public.call_transcripts USING btree (call_session_id, sequence_number);


--
-- Name: idx_call_transcripts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_call_transcripts_tenant ON public.call_transcripts USING btree (tenant_id);


--
-- Name: idx_callback_queue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_callback_queue_status ON public.callback_queue USING btree (status);


--
-- Name: idx_callback_queue_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_callback_queue_tenant ON public.callback_queue USING btree (tenant_id);


--
-- Name: idx_campaign_contact_attempts_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_contact_attempts_contact ON public.campaign_contact_attempts USING btree (campaign_contact_id);


--
-- Name: idx_campaign_contacts_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_contacts_campaign ON public.campaign_contacts USING btree (campaign_id);


--
-- Name: idx_campaign_contacts_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_contacts_phone ON public.campaign_contacts USING btree (phone_number);


--
-- Name: idx_campaign_contacts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_contacts_status ON public.campaign_contacts USING btree (status);


--
-- Name: idx_campaign_contacts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_contacts_tenant ON public.campaign_contacts USING btree (tenant_id);


--
-- Name: idx_campaigns_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaigns_status ON public.campaigns USING btree (status);


--
-- Name: idx_campaigns_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaigns_tenant ON public.campaigns USING btree (tenant_id);


--
-- Name: idx_case_studies_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_case_studies_slug ON public.case_studies USING btree (public_slug) WHERE (public_slug IS NOT NULL);


--
-- Name: idx_case_studies_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_studies_status ON public.case_studies USING btree (status);


--
-- Name: idx_case_studies_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_studies_tenant ON public.case_studies USING btree (tenant_id);


--
-- Name: idx_changelog_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_changelog_published ON public.changelog_entries USING btree (published_at DESC);


--
-- Name: idx_connector_alert_mutes_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_alert_mutes_tenant ON public.connector_alert_mutes USING btree (tenant_id);


--
-- Name: idx_connector_alert_recipients_dispatch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_alert_recipients_dispatch ON public.connector_alert_recipients USING btree (tenant_id, dispatch_id);


--
-- Name: idx_connector_alert_recipients_email_msgid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connector_alert_recipients_email_msgid ON public.connector_alert_recipients USING btree (email_message_id) WHERE (email_message_id IS NOT NULL);


--
-- Name: idx_connector_alert_recipients_integration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_alert_recipients_integration ON public.connector_alert_recipients USING btree (tenant_id, integration_id, dispatched_at DESC);


--
-- Name: idx_connector_alert_recipients_twilio_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_connector_alert_recipients_twilio_sid ON public.connector_alert_recipients USING btree (twilio_message_sid) WHERE (twilio_message_sid IS NOT NULL);


--
-- Name: idx_connector_configs_integration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_configs_integration ON public.connector_configs USING btree (integration_id);


--
-- Name: idx_connector_configs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_configs_tenant ON public.connector_configs USING btree (tenant_id);


--
-- Name: idx_connector_stale_alerts_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connector_stale_alerts_unresolved ON public.connector_stale_alerts USING btree (last_alerted_at DESC) WHERE (resolved_at IS NULL);


--
-- Name: idx_conversation_costs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_costs_created ON public.conversation_costs USING btree (tenant_id, created_at);


--
-- Name: idx_conversation_costs_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_costs_session ON public.conversation_costs USING btree (call_session_id);


--
-- Name: idx_conversation_costs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_costs_tenant ON public.conversation_costs USING btree (tenant_id);


--
-- Name: idx_conversation_costs_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_costs_tier ON public.conversation_costs USING btree (tenant_id, model_tier);


--
-- Name: idx_cost_budget_settings_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cost_budget_settings_tenant ON public.cost_budget_settings USING btree (tenant_id);


--
-- Name: idx_crm_caller_identities_provider_validated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_caller_identities_provider_validated ON public.crm_caller_identities USING btree (provider, last_validated_at NULLS FIRST);


--
-- Name: idx_crm_caller_identities_tenant_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_caller_identities_tenant_phone ON public.crm_caller_identities USING btree (tenant_id, phone_e164);


--
-- Name: idx_crm_caller_identities_tenant_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_caller_identities_tenant_provider ON public.crm_caller_identities USING btree (tenant_id, provider);


--
-- Name: idx_crm_stale_cache_scrubs_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_stale_cache_scrubs_lookup ON public.crm_stale_cache_scrubs USING btree (tenant_id, provider, caller_phone, occurred_at DESC);


--
-- Name: idx_crm_stale_cache_scrubs_tenant_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_stale_cache_scrubs_tenant_recent ON public.crm_stale_cache_scrubs USING btree (tenant_id, occurred_at DESC);


--
-- Name: idx_daily_openai_costs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_openai_costs_tenant ON public.daily_openai_costs USING btree (tenant_id);


--
-- Name: idx_daily_org_usage_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_org_usage_tenant ON public.daily_org_usage USING btree (tenant_id);


--
-- Name: idx_daily_reconciliation_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_reconciliation_tenant ON public.daily_reconciliation USING btree (tenant_id);


--
-- Name: idx_demo_agents_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_agents_tenant ON public.demo_agents USING btree (tenant_id);


--
-- Name: idx_demo_analytics_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_analytics_created_at ON public.demo_analytics USING btree (created_at);


--
-- Name: idx_demo_analytics_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_analytics_event_type ON public.demo_analytics USING btree (event_type);


--
-- Name: idx_demo_analytics_ip_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_analytics_ip_hash ON public.demo_analytics USING btree (ip_hash);


--
-- Name: idx_demo_sessions_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_sessions_agent ON public.demo_sessions USING btree (demo_agent_id);


--
-- Name: idx_demo_sessions_converted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_sessions_converted ON public.demo_sessions USING btree (tenant_id, converted);


--
-- Name: idx_demo_sessions_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_sessions_started ON public.demo_sessions USING btree (started_at);


--
-- Name: idx_demo_sessions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_demo_sessions_tenant ON public.demo_sessions USING btree (tenant_id);


--
-- Name: idx_developer_submissions_developer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_developer_submissions_developer ON public.developer_submissions USING btree (developer_id);


--
-- Name: idx_developer_submissions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_developer_submissions_status ON public.developer_submissions USING btree (status);


--
-- Name: idx_digital_twin_models_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digital_twin_models_status ON public.digital_twin_models USING btree (tenant_id, status);


--
-- Name: idx_digital_twin_models_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digital_twin_models_tenant ON public.digital_twin_models USING btree (tenant_id);


--
-- Name: idx_digital_twin_results_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digital_twin_results_run ON public.digital_twin_results USING btree (run_id);


--
-- Name: idx_digital_twin_results_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digital_twin_results_tenant ON public.digital_twin_results USING btree (tenant_id);


--
-- Name: idx_digital_twin_scenarios_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digital_twin_scenarios_category ON public.digital_twin_scenarios USING btree (tenant_id, category);


--
-- Name: idx_digital_twin_scenarios_predefined; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digital_twin_scenarios_predefined ON public.digital_twin_scenarios USING btree (is_predefined);


--
-- Name: idx_digital_twin_scenarios_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_digital_twin_scenarios_tenant ON public.digital_twin_scenarios USING btree (tenant_id);


--
-- Name: idx_dispatch_assignment_rules_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_assignment_rules_tenant ON public.dispatch_assignment_rules USING btree (tenant_id);


--
-- Name: idx_dispatch_job_attachments_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_job_attachments_job ON public.dispatch_job_attachments USING btree (job_id);


--
-- Name: idx_dispatch_job_attachments_object_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_job_attachments_object_path ON public.dispatch_job_attachments USING btree (object_path);


--
-- Name: idx_dispatch_job_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_job_events_created ON public.dispatch_job_events USING btree (tenant_id, created_at DESC);


--
-- Name: idx_dispatch_job_events_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_job_events_job ON public.dispatch_job_events USING btree (job_id);


--
-- Name: idx_dispatch_job_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_job_events_tenant ON public.dispatch_job_events USING btree (tenant_id);


--
-- Name: idx_dispatch_job_exceptions_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_job_exceptions_job ON public.dispatch_job_exceptions USING btree (job_id);


--
-- Name: idx_dispatch_job_exceptions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_job_exceptions_tenant ON public.dispatch_job_exceptions USING btree (tenant_id);


--
-- Name: idx_dispatch_job_exceptions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_job_exceptions_type ON public.dispatch_job_exceptions USING btree (tenant_id, exception_type);


--
-- Name: idx_dispatch_jobs_address_geocoded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_jobs_address_geocoded ON public.dispatch_jobs USING btree (tenant_id, address_geocoded_at) WHERE ((address_lat IS NOT NULL) AND (address_lon IS NOT NULL));


--
-- Name: idx_dispatch_jobs_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_jobs_assignee ON public.dispatch_jobs USING btree (tenant_id, assignee_user_id);


--
-- Name: idx_dispatch_jobs_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_jobs_parent ON public.dispatch_jobs USING btree (parent_job_id);


--
-- Name: idx_dispatch_jobs_priority_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_jobs_priority_status ON public.dispatch_jobs USING btree (tenant_id, priority, status);


--
-- Name: idx_dispatch_jobs_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_jobs_resource ON public.dispatch_jobs USING btree (tenant_id, resource_id);


--
-- Name: idx_dispatch_jobs_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_jobs_scheduled ON public.dispatch_jobs USING btree (tenant_id, scheduled_at);


--
-- Name: idx_dispatch_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_jobs_status ON public.dispatch_jobs USING btree (tenant_id, status);


--
-- Name: idx_dispatch_jobs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_jobs_tenant ON public.dispatch_jobs USING btree (tenant_id);


--
-- Name: idx_dispatch_jobs_territory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_jobs_territory ON public.dispatch_jobs USING btree (tenant_id, territory_id);


--
-- Name: idx_dispatch_location_history_resource_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_location_history_resource_time ON public.dispatch_resource_location_history USING btree (resource_id, recorded_at DESC);


--
-- Name: idx_dispatch_location_history_tenant_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_location_history_tenant_job ON public.dispatch_resource_location_history USING btree (tenant_id, active_job_id) WHERE (active_job_id IS NOT NULL);


--
-- Name: idx_dispatch_location_history_tenant_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_location_history_tenant_time ON public.dispatch_resource_location_history USING btree (tenant_id, recorded_at DESC);


--
-- Name: idx_dispatch_notification_templates_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_notification_templates_event ON public.dispatch_notification_templates USING btree (tenant_id, trigger_event);


--
-- Name: idx_dispatch_notification_templates_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_notification_templates_tenant ON public.dispatch_notification_templates USING btree (tenant_id);


--
-- Name: idx_dispatch_notifications_log_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_notifications_log_job ON public.dispatch_notifications_log USING btree (job_id);


--
-- Name: idx_dispatch_notifications_log_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_notifications_log_tenant ON public.dispatch_notifications_log USING btree (tenant_id);


--
-- Name: idx_dispatch_resource_locations_active_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_resource_locations_active_job ON public.dispatch_resource_locations USING btree (tenant_id, active_job_id) WHERE (active_job_id IS NOT NULL);


--
-- Name: idx_dispatch_resource_locations_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_resource_locations_tenant ON public.dispatch_resource_locations USING btree (tenant_id, received_at DESC);


--
-- Name: idx_dispatch_resource_skills_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_resource_skills_resource ON public.dispatch_resource_skills USING btree (resource_id);


--
-- Name: idx_dispatch_resource_skills_skill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_resource_skills_skill ON public.dispatch_resource_skills USING btree (skill_type_id);


--
-- Name: idx_dispatch_resources_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_resources_status ON public.dispatch_resources USING btree (tenant_id, current_status);


--
-- Name: idx_dispatch_resources_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_resources_tenant ON public.dispatch_resources USING btree (tenant_id);


--
-- Name: idx_dispatch_resources_territory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_resources_territory ON public.dispatch_resources USING btree (territory_id);


--
-- Name: idx_dispatch_resources_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_resources_user ON public.dispatch_resources USING btree (user_id);


--
-- Name: idx_dispatch_route_export_jobs_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_route_export_jobs_tenant_created ON public.dispatch_route_export_jobs USING btree (tenant_id, created_at DESC);


--
-- Name: idx_dispatch_skill_types_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_skill_types_tenant ON public.dispatch_skill_types USING btree (tenant_id);


--
-- Name: idx_dispatch_territories_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dispatch_territories_tenant ON public.dispatch_territories USING btree (tenant_id);


--
-- Name: idx_distributed_locks_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_distributed_locks_expires ON public.distributed_locks USING btree (expires_at);


--
-- Name: idx_dnc_list_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dnc_list_tenant ON public.dnc_list USING btree (tenant_id);


--
-- Name: idx_dnc_list_tenant_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_dnc_list_tenant_phone ON public.dnc_list USING btree (tenant_id, phone_number);


--
-- Name: idx_dt_results_recommendation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dt_results_recommendation ON public.digital_twin_results USING btree (recommendation_id) WHERE (recommendation_id IS NOT NULL);


--
-- Name: idx_dt_simulation_runs_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dt_simulation_runs_model ON public.digital_twin_simulation_runs USING btree (model_id);


--
-- Name: idx_dt_simulation_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dt_simulation_runs_status ON public.digital_twin_simulation_runs USING btree (tenant_id, status);


--
-- Name: idx_dt_simulation_runs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dt_simulation_runs_tenant ON public.digital_twin_simulation_runs USING btree (tenant_id);


--
-- Name: idx_encrypted_fields_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encrypted_fields_tenant ON public.encrypted_fields USING btree (tenant_id);


--
-- Name: idx_encryption_keys_alias; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_encryption_keys_alias ON public.encryption_keys USING btree (tenant_id, key_alias) WHERE (is_active = true);


--
-- Name: idx_encryption_keys_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encryption_keys_tenant ON public.encryption_keys USING btree (tenant_id);


--
-- Name: idx_error_logs_occurred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_error_logs_occurred ON public.error_logs USING btree (occurred_at);


--
-- Name: idx_error_logs_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_error_logs_session ON public.error_logs USING btree (call_session_id);


--
-- Name: idx_error_logs_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_error_logs_severity ON public.error_logs USING btree (severity);


--
-- Name: idx_error_logs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_error_logs_tenant ON public.error_logs USING btree (tenant_id);


--
-- Name: idx_error_logs_tenant_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_error_logs_tenant_severity ON public.error_logs USING btree (tenant_id, severity, occurred_at DESC);


--
-- Name: idx_error_logs_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_error_logs_unresolved ON public.error_logs USING btree (tenant_id, occurred_at) WHERE (resolved_at IS NULL);


--
-- Name: idx_escalation_tasks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_escalation_tasks_status ON public.escalation_tasks USING btree (tenant_id, status);


--
-- Name: idx_escalation_tasks_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_escalation_tasks_tenant ON public.escalation_tasks USING btree (tenant_id);


--
-- Name: idx_evolution_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evolution_audit_created ON public.evolution_audit_log USING btree (created_at DESC);


--
-- Name: idx_evolution_audit_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evolution_audit_entity ON public.evolution_audit_log USING btree (entity_type, entity_id);


--
-- Name: idx_evolution_opportunities_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_evolution_opportunities_dedup ON public.evolution_opportunities USING btree (opportunity_type, title);


--
-- Name: idx_evolution_opportunities_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evolution_opportunities_score ON public.evolution_opportunities USING btree (composite_score DESC);


--
-- Name: idx_evolution_opportunities_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evolution_opportunities_status ON public.evolution_opportunities USING btree (status);


--
-- Name: idx_evolution_opportunities_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evolution_opportunities_type ON public.evolution_opportunities USING btree (opportunity_type);


--
-- Name: idx_evolution_signals_collected; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evolution_signals_collected ON public.evolution_signals USING btree (collected_at DESC);


--
-- Name: idx_evolution_signals_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_evolution_signals_dedup ON public.evolution_signals USING btree (source, signal_type, COALESCE(tenant_id, '__global__'::character varying), COALESCE(period_start, '1970-01-01 00:00:00+00'::timestamp with time zone), md5((title)::text));


--
-- Name: idx_evolution_signals_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evolution_signals_source ON public.evolution_signals USING btree (source);


--
-- Name: idx_evolution_signals_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evolution_signals_tenant ON public.evolution_signals USING btree (tenant_id);


--
-- Name: idx_evolution_signals_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evolution_signals_type ON public.evolution_signals USING btree (signal_type);


--
-- Name: idx_execution_traces_call_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_execution_traces_call_session ON public.execution_traces USING btree (call_session_id);


--
-- Name: idx_execution_traces_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_execution_traces_started ON public.execution_traces USING btree (started_at);


--
-- Name: idx_execution_traces_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_execution_traces_tenant ON public.execution_traces USING btree (tenant_id);


--
-- Name: idx_execution_traces_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_execution_traces_type ON public.execution_traces USING btree (trace_type);


--
-- Name: idx_experiment_results_opp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_experiment_results_opp ON public.experiment_results USING btree (opportunity_id);


--
-- Name: idx_experiment_results_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_experiment_results_state ON public.experiment_results USING btree (state);


--
-- Name: idx_experiment_results_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_experiment_results_type ON public.experiment_results USING btree (experiment_type);


--
-- Name: idx_feature_request_clusters_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feature_request_clusters_count ON public.feature_request_clusters USING btree (request_count DESC);


--
-- Name: idx_feature_request_clusters_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_feature_request_clusters_dedup ON public.feature_request_clusters USING btree (cluster_name);


--
-- Name: idx_feature_request_clusters_opp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feature_request_clusters_opp ON public.feature_request_clusters USING btree (opportunity_id);


--
-- Name: idx_federal_dnc_numbers_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federal_dnc_numbers_version ON public.federal_dnc_numbers USING btree (registry_version);


--
-- Name: idx_forecast_models_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_forecast_models_model ON public.forecast_models USING btree (model_id);


--
-- Name: idx_forecast_models_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_forecast_models_tenant ON public.forecast_models USING btree (tenant_id);


--
-- Name: idx_forecast_models_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_forecast_models_type ON public.forecast_models USING btree (tenant_id, forecast_type);


--
-- Name: idx_gdpr_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gdpr_requests_status ON public.gdpr_requests USING btree (tenant_id, status);


--
-- Name: idx_gdpr_requests_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gdpr_requests_tenant ON public.gdpr_requests USING btree (tenant_id);


--
-- Name: idx_gin_aggregation_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gin_aggregation_runs_status ON public.gin_aggregation_runs USING btree (status, started_at DESC);


--
-- Name: idx_gin_policy_acceptance_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gin_policy_acceptance_tenant ON public.gin_policy_acceptance_records USING btree (tenant_id, created_at DESC);


--
-- Name: idx_global_insight_patterns_industry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_global_insight_patterns_industry ON public.global_insight_patterns USING btree (industry_vertical, is_active);


--
-- Name: idx_global_insight_patterns_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_global_insight_patterns_type ON public.global_insight_patterns USING btree (pattern_type, is_active);


--
-- Name: idx_global_prompt_patterns_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_global_prompt_patterns_category ON public.global_prompt_patterns USING btree (prompt_category, is_active);


--
-- Name: idx_global_prompt_patterns_industry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_global_prompt_patterns_industry ON public.global_prompt_patterns USING btree (industry_vertical, is_active);


--
-- Name: idx_handoff_states_call_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_handoff_states_call_sid ON public.handoff_states USING btree (call_sid);


--
-- Name: idx_handoff_states_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_handoff_states_tenant ON public.handoff_states USING btree (tenant_id);


--
-- Name: idx_im_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_im_period ON public.improvement_metrics USING btree (period_start, period_end);


--
-- Name: idx_im_tenant_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_im_tenant_agent ON public.improvement_metrics USING btree (tenant_id, agent_id);


--
-- Name: idx_industry_benchmarks_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_industry_benchmarks_unique ON public.industry_benchmarks USING btree (industry_vertical, metric_name, period_start, period_end);


--
-- Name: idx_industry_benchmarks_vertical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_industry_benchmarks_vertical ON public.industry_benchmarks USING btree (industry_vertical, metric_name, period_end DESC);


--
-- Name: idx_ingest_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingest_events_created ON public.ingest_events USING btree (created_at);


--
-- Name: idx_ingest_events_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ingest_events_idempotency ON public.ingest_events USING btree (org_id, idempotency_key);


--
-- Name: idx_ingest_events_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingest_events_org ON public.ingest_events USING btree (org_id);


--
-- Name: idx_ingest_events_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingest_events_status ON public.ingest_events USING btree (status);


--
-- Name: idx_ingest_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ingest_events_type ON public.ingest_events USING btree (event_type);


--
-- Name: idx_integration_demand_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_integration_demand_dedup ON public.integration_demand_scores USING btree (integration_name);


--
-- Name: idx_integration_demand_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_demand_name ON public.integration_demand_scores USING btree (integration_name);


--
-- Name: idx_integration_demand_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_demand_score ON public.integration_demand_scores USING btree (demand_score DESC);


--
-- Name: idx_integration_events_call_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_events_call_session ON public.integration_event_logs USING btree (call_session_id);


--
-- Name: idx_integration_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_events_created ON public.integration_event_logs USING btree (created_at);


--
-- Name: idx_integration_events_service; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_events_service ON public.integration_event_logs USING btree (service_name);


--
-- Name: idx_integration_events_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_events_status ON public.integration_event_logs USING btree (response_status);


--
-- Name: idx_integration_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_events_tenant ON public.integration_event_logs USING btree (tenant_id);


--
-- Name: idx_integrations_auth_alert_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integrations_auth_alert_pending ON public.integrations USING btree (tenant_id, last_sync_status) WHERE (auth_alert_sent_at IS NULL);


--
-- Name: idx_integrations_expiry_warning_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integrations_expiry_warning_pending ON public.integrations USING btree (tenant_id, last_sync_status) WHERE (expiry_warning_sent_at IS NULL);


--
-- Name: idx_integrations_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integrations_tenant ON public.integrations USING btree (tenant_id);


--
-- Name: idx_integrations_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integrations_type ON public.integrations USING btree (integration_type);


--
-- Name: idx_knowledge_articles_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_articles_category ON public.knowledge_articles USING btree (tenant_id, category);


--
-- Name: idx_knowledge_articles_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_articles_status ON public.knowledge_articles USING btree (tenant_id, status);


--
-- Name: idx_knowledge_articles_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_articles_tenant ON public.knowledge_articles USING btree (tenant_id);


--
-- Name: idx_knowledge_chunks_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_chunks_document ON public.knowledge_chunks USING btree (document_id);


--
-- Name: idx_knowledge_chunks_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_chunks_tenant ON public.knowledge_chunks USING btree (tenant_id);


--
-- Name: idx_knowledge_documents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_documents_status ON public.knowledge_documents USING btree (tenant_id, status);


--
-- Name: idx_knowledge_documents_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_documents_tenant ON public.knowledge_documents USING btree (tenant_id);


--
-- Name: idx_knowledge_documents_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_documents_type ON public.knowledge_documents USING btree (tenant_id, source_type);


--
-- Name: idx_marketing_search_empty_queries_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_search_empty_queries_created ON public.marketing_search_empty_queries USING btree (created_at DESC);


--
-- Name: idx_marketing_search_empty_queries_group_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_search_empty_queries_group_recent ON public.marketing_search_empty_queries USING btree (source, locale, query_normalized, created_at DESC);


--
-- Name: idx_marketplace_opp_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_opp_category ON public.marketplace_opportunity_scores USING btree (template_category);


--
-- Name: idx_marketplace_opp_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_marketplace_opp_dedup ON public.marketplace_opportunity_scores USING btree (template_category);


--
-- Name: idx_marketplace_opp_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_opp_score ON public.marketplace_opportunity_scores USING btree (demand_score DESC);


--
-- Name: idx_marketplace_purchases_stripe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_purchases_stripe ON public.marketplace_purchases USING btree (stripe_checkout_session_id);


--
-- Name: idx_marketplace_purchases_subscription; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_purchases_subscription ON public.marketplace_purchases USING btree (stripe_subscription_id);


--
-- Name: idx_marketplace_purchases_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_purchases_template ON public.marketplace_purchases USING btree (template_id);


--
-- Name: idx_marketplace_purchases_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_purchases_tenant ON public.marketplace_purchases USING btree (tenant_id);


--
-- Name: idx_marketplace_revenue_developer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_revenue_developer ON public.marketplace_revenue_events USING btree (developer_id);


--
-- Name: idx_marketplace_revenue_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_revenue_template ON public.marketplace_revenue_events USING btree (template_id);


--
-- Name: idx_marketplace_reviews_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_reviews_template ON public.marketplace_reviews USING btree (template_id);


--
-- Name: idx_marketplace_reviews_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketplace_reviews_tenant ON public.marketplace_reviews USING btree (tenant_id);


--
-- Name: idx_milestone_thresholds_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_milestone_thresholds_tenant ON public.milestone_thresholds USING btree (tenant_id);


--
-- Name: idx_model_routing_log_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_model_routing_log_tenant ON public.model_routing_log USING btree (tenant_id, created_at);


--
-- Name: idx_network_recommendations_industry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_network_recommendations_industry ON public.network_recommendations USING btree (industry_vertical, recommendation_type);


--
-- Name: idx_network_recommendations_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_network_recommendations_tenant ON public.network_recommendations USING btree (tenant_id, status, created_at DESC);


--
-- Name: idx_number_routing_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_number_routing_agent ON public.number_routing USING btree (agent_id);


--
-- Name: idx_number_routing_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_number_routing_phone ON public.number_routing USING btree (phone_number_id);


--
-- Name: idx_number_routing_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_number_routing_tenant ON public.number_routing USING btree (tenant_id);


--
-- Name: idx_operations_alerts_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_operations_alerts_tenant ON public.operations_alerts USING btree (tenant_id, created_at DESC);


--
-- Name: idx_operations_alerts_unack; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_operations_alerts_unack ON public.operations_alerts USING btree (tenant_id, acknowledged, created_at DESC);


--
-- Name: idx_outbox_events_active_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_events_active_status ON public.outbox_events USING btree (tenant_id, status, next_attempt_at) WHERE (archived_at IS NULL);


--
-- Name: idx_outbox_events_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_events_pending ON public.outbox_events USING btree (status, next_attempt_at) WHERE (status = ANY (ARRAY['pending'::public.outbox_event_status, 'processing'::public.outbox_event_status]));


--
-- Name: idx_outbox_events_processing_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_events_processing_lease ON public.outbox_events USING btree (lease_expires_at) WHERE ((status = 'processing'::public.outbox_event_status) AND (archived_at IS NULL));


--
-- Name: idx_outbox_events_status_next; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_events_status_next ON public.outbox_events USING btree (status, next_attempt_at);


--
-- Name: idx_outbox_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_events_tenant ON public.outbox_events USING btree (tenant_id);


--
-- Name: idx_outbox_events_tenant_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_events_tenant_type ON public.outbox_events USING btree (tenant_id, event_type);


--
-- Name: idx_outbox_messages_call_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_messages_call_sid ON public.outbox_messages USING btree (call_sid) WHERE (call_sid IS NOT NULL);


--
-- Name: idx_outbox_messages_status_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_messages_status_retry ON public.outbox_messages USING btree (status, next_retry_at) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'retry'::character varying])::text[]));


--
-- Name: idx_outbox_messages_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_messages_tenant ON public.outbox_messages USING btree (tenant_id);


--
-- Name: idx_pairing_codes_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_pairing_codes_hash ON public.dispatch_resource_pairing_codes USING btree (code_hash);


--
-- Name: idx_pairing_codes_tenant_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pairing_codes_tenant_resource ON public.dispatch_resource_pairing_codes USING btree (tenant_id, resource_id, created_at DESC);


--
-- Name: idx_password_reset_tokens_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_tokens_token ON public.password_reset_tokens USING btree (token);


--
-- Name: idx_phone_endpoints_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_endpoints_tenant ON public.phone_endpoints USING btree (tenant_id);


--
-- Name: idx_phone_numbers_demo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_numbers_demo ON public.phone_numbers USING btree (is_demo) WHERE (is_demo = true);


--
-- Name: idx_phone_numbers_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_numbers_number ON public.phone_numbers USING btree (phone_number);


--
-- Name: idx_phone_numbers_one_free_per_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_phone_numbers_one_free_per_tenant ON public.phone_numbers USING btree (tenant_id) WHERE (is_free_number = true);


--
-- Name: idx_phone_numbers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_numbers_status ON public.phone_numbers USING btree (status);


--
-- Name: idx_phone_numbers_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_numbers_tenant ON public.phone_numbers USING btree (tenant_id);


--
-- Name: idx_phone_numbers_tenant_free; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_numbers_tenant_free ON public.phone_numbers USING btree (tenant_id, is_free_number);


--
-- Name: idx_pis_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pis_created_at ON public.prompt_improvement_suggestions USING btree (created_at);


--
-- Name: idx_pis_tenant_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pis_tenant_agent ON public.prompt_improvement_suggestions USING btree (tenant_id, agent_id);


--
-- Name: idx_pis_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pis_tenant_status ON public.prompt_improvement_suggestions USING btree (tenant_id, status);


--
-- Name: idx_prompt_versions_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompt_versions_agent ON public.prompt_versions USING btree (agent_id);


--
-- Name: idx_prompt_versions_agent_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_prompt_versions_agent_version ON public.agent_prompt_versions USING btree (agent_id, version);


--
-- Name: idx_prompt_versions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompt_versions_tenant ON public.prompt_versions USING btree (tenant_id);


--
-- Name: idx_push_delivery_attempts_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_delivery_attempts_created ON public.push_delivery_attempts USING btree (created_at DESC);


--
-- Name: idx_push_delivery_attempts_failures; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_delivery_attempts_failures ON public.push_delivery_attempts USING btree (created_at DESC) WHERE ((failure_reason IS NOT NULL) OR (dropped > 0));


--
-- Name: idx_push_delivery_attempts_tenant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_push_delivery_attempts_tenant_created ON public.push_delivery_attempts USING btree (tenant_id, created_at DESC);


--
-- Name: idx_response_cache_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_response_cache_expires ON public.response_cache USING btree (expires_at);


--
-- Name: idx_response_cache_tenant_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_response_cache_tenant_key ON public.response_cache USING btree (tenant_id, cache_key);


--
-- Name: idx_roadmap_recommendations_opp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roadmap_recommendations_opp ON public.roadmap_recommendations USING btree (opportunity_id);


--
-- Name: idx_roadmap_recommendations_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roadmap_recommendations_priority ON public.roadmap_recommendations USING btree (recommended_priority);


--
-- Name: idx_roadmap_recommendations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roadmap_recommendations_status ON public.roadmap_recommendations USING btree (status);


--
-- Name: idx_sched_appt_types_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_appt_types_tenant ON public.scheduling_appointment_types USING btree (tenant_id);


--
-- Name: idx_sched_audit_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_audit_booking ON public.scheduling_audit_log USING btree (booking_id);


--
-- Name: idx_sched_audit_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_audit_tenant ON public.scheduling_audit_log USING btree (tenant_id);


--
-- Name: idx_sched_audit_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_audit_time ON public.scheduling_audit_log USING btree (tenant_id, created_at);


--
-- Name: idx_sched_overrides_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_overrides_provider ON public.scheduling_overrides USING btree (provider_id, override_date);


--
-- Name: idx_sched_overrides_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_overrides_tenant ON public.scheduling_overrides USING btree (tenant_id, override_date);


--
-- Name: idx_sched_prov_sched_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_prov_sched_provider ON public.scheduling_provider_schedules USING btree (provider_id);


--
-- Name: idx_sched_prov_sched_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_prov_sched_tenant ON public.scheduling_provider_schedules USING btree (tenant_id);


--
-- Name: idx_sched_providers_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_providers_active ON public.scheduling_providers USING btree (tenant_id, is_active);


--
-- Name: idx_sched_providers_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_providers_tenant ON public.scheduling_providers USING btree (tenant_id);


--
-- Name: idx_sched_recurring_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_recurring_tenant ON public.scheduling_recurring_series USING btree (tenant_id);


--
-- Name: idx_sched_reminder_log_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_reminder_log_booking ON public.scheduling_reminder_log USING btree (booking_id);


--
-- Name: idx_sched_reminder_log_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_reminder_log_tenant ON public.scheduling_reminder_log USING btree (tenant_id);


--
-- Name: idx_sched_reminders_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_reminders_tenant ON public.scheduling_reminder_configs USING btree (tenant_id);


--
-- Name: idx_sched_resources_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_resources_tenant ON public.scheduling_resources USING btree (tenant_id);


--
-- Name: idx_sched_rules_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_rules_tenant ON public.scheduling_booking_rules USING btree (tenant_id);


--
-- Name: idx_sched_rules_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_rules_type ON public.scheduling_booking_rules USING btree (appointment_type_id);


--
-- Name: idx_sched_waitlist_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_waitlist_status ON public.scheduling_waitlist USING btree (tenant_id, status);


--
-- Name: idx_sched_waitlist_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_waitlist_tenant ON public.scheduling_waitlist USING btree (tenant_id);


--
-- Name: idx_scheduling_workflows_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduling_workflows_tenant ON public.scheduling_workflows USING btree (tenant_id);


--
-- Name: idx_simulation_results_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_simulation_results_run ON public.simulation_results USING btree (run_id);


--
-- Name: idx_simulation_results_scenario; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_simulation_results_scenario ON public.simulation_results USING btree (scenario_id);


--
-- Name: idx_simulation_results_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_simulation_results_tenant ON public.simulation_results USING btree (tenant_id);


--
-- Name: idx_simulation_runs_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_simulation_runs_agent ON public.simulation_runs USING btree (tenant_id, agent_id);


--
-- Name: idx_simulation_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_simulation_runs_status ON public.simulation_runs USING btree (tenant_id, status);


--
-- Name: idx_simulation_runs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_simulation_runs_tenant ON public.simulation_runs USING btree (tenant_id);


--
-- Name: idx_simulation_scenarios_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_simulation_scenarios_category ON public.simulation_scenarios USING btree (tenant_id, category);


--
-- Name: idx_simulation_scenarios_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_simulation_scenarios_tenant ON public.simulation_scenarios USING btree (tenant_id);


--
-- Name: idx_sms_activity_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_activity_conv ON public.sms_conversation_activity_log USING btree (conversation_id, created_at DESC);


--
-- Name: idx_sms_activity_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_activity_tenant ON public.sms_conversation_activity_log USING btree (tenant_id, created_at DESC);


--
-- Name: idx_sms_assign_rules_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_assign_rules_tenant ON public.sms_assignment_rules USING btree (tenant_id, enabled);


--
-- Name: idx_sms_auto_reply_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_auto_reply_tenant ON public.sms_auto_reply_rules USING btree (tenant_id, enabled);


--
-- Name: idx_sms_canned_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_canned_tenant ON public.sms_canned_responses USING btree (tenant_id);


--
-- Name: idx_sms_consent_tenant_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_consent_tenant_phone ON public.sms_consent_log USING btree (tenant_id, phone_number, created_at DESC);


--
-- Name: idx_sms_conv_remote; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_remote ON public.sms_conversations USING btree (tenant_id, phone_number_id, remote_number);


--
-- Name: idx_sms_conv_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_tenant ON public.sms_conversations USING btree (tenant_id);


--
-- Name: idx_sms_conv_tenant_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_tenant_assignee ON public.sms_conversations USING btree (tenant_id, assignee_user_id);


--
-- Name: idx_sms_conv_tenant_last_msg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_tenant_last_msg ON public.sms_conversations USING btree (tenant_id, last_message_at DESC);


--
-- Name: idx_sms_conv_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_tenant_status ON public.sms_conversations USING btree (tenant_id, status);


--
-- Name: idx_sms_conv_tenant_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_conv_tenant_unread ON public.sms_conversations USING btree (tenant_id) WHERE (unread_count > 0);


--
-- Name: idx_sms_conv_unique_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_sms_conv_unique_thread ON public.sms_conversations USING btree (tenant_id, phone_number_id, remote_number);


--
-- Name: idx_sms_logs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_logs_tenant ON public.sms_logs USING btree (tenant_id);


--
-- Name: idx_sms_msg_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_msg_conv ON public.sms_messages USING btree (conversation_id, created_at);


--
-- Name: idx_sms_msg_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_msg_scheduled ON public.sms_messages USING btree (tenant_id, scheduled_at) WHERE ((scheduled_at IS NOT NULL) AND ((status)::text = 'scheduled'::text));


--
-- Name: idx_sms_msg_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_msg_tenant ON public.sms_messages USING btree (tenant_id);


--
-- Name: idx_sms_msg_twilio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_msg_twilio ON public.sms_messages USING btree (twilio_sid);


--
-- Name: idx_sms_notes_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_notes_conv ON public.sms_internal_notes USING btree (conversation_id, created_at);


--
-- Name: idx_subprocessors_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subprocessors_active ON public.subprocessors USING btree (is_active, display_order);


--
-- Name: idx_subscriptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_status ON public.subscriptions USING btree (status);


--
-- Name: idx_subscriptions_stripe_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_stripe_customer ON public.subscriptions USING btree (stripe_customer_id);


--
-- Name: idx_subscriptions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_tenant ON public.subscriptions USING btree (tenant_id);


--
-- Name: idx_system_metrics_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_metrics_name ON public.system_metrics USING btree (metric_name);


--
-- Name: idx_system_metrics_name_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_metrics_name_recorded ON public.system_metrics USING btree (metric_name, recorded_at DESC);


--
-- Name: idx_system_metrics_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_metrics_recorded ON public.system_metrics USING btree (recorded_at);


--
-- Name: idx_template_category_map_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_category_map_category ON public.template_category_map USING btree (category_id);


--
-- Name: idx_template_category_map_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_category_map_template ON public.template_category_map USING btree (template_id);


--
-- Name: idx_template_changelogs_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_changelogs_template ON public.template_changelogs USING btree (template_id);


--
-- Name: idx_template_entitlements_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_entitlements_plan ON public.template_entitlements USING btree (plan_tier);


--
-- Name: idx_template_entitlements_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_entitlements_template ON public.template_entitlements USING btree (template_id);


--
-- Name: idx_template_install_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_install_events_created ON public.template_install_events USING btree (created_at);


--
-- Name: idx_template_install_events_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_install_events_template ON public.template_install_events USING btree (template_id);


--
-- Name: idx_template_install_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_install_events_tenant ON public.template_install_events USING btree (tenant_id);


--
-- Name: idx_template_registry_min_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_registry_min_plan ON public.template_registry USING btree (min_plan);


--
-- Name: idx_template_registry_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_registry_slug ON public.template_registry USING btree (slug);


--
-- Name: idx_template_registry_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_registry_status ON public.template_registry USING btree (status);


--
-- Name: idx_template_versions_latest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_versions_latest ON public.template_versions USING btree (template_id, is_latest) WHERE (is_latest = true);


--
-- Name: idx_template_versions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_versions_status ON public.template_versions USING btree (status);


--
-- Name: idx_template_versions_template_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_versions_template_id ON public.template_versions USING btree (template_id);


--
-- Name: idx_tenant_deletion_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_deletion_pending ON public.tenant_deletion_requests USING btree (tenant_id, status) WHERE (status = 'pending'::text);


--
-- Name: idx_tenant_installations_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_installations_template ON public.tenant_agent_installations USING btree (template_id);


--
-- Name: idx_tenant_installations_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_installations_tenant ON public.tenant_agent_installations USING btree (tenant_id);


--
-- Name: idx_tenant_isolation_tests_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_isolation_tests_run_id ON public.tenant_isolation_tests USING btree (run_id);


--
-- Name: idx_tenant_isolation_tests_source_runat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_isolation_tests_source_runat ON public.tenant_isolation_tests USING btree (source, run_at DESC);


--
-- Name: idx_tenant_notifications_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_notifications_tenant ON public.tenant_notifications USING btree (tenant_id);


--
-- Name: idx_tenant_notifications_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_notifications_unread ON public.tenant_notifications USING btree (tenant_id, read) WHERE (read = false);


--
-- Name: idx_tenant_notifications_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_notifications_user ON public.tenant_notifications USING btree (tenant_id, user_id);


--
-- Name: idx_tenant_notifications_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_notifications_user_unread ON public.tenant_notifications USING btree (tenant_id, user_id, read) WHERE (read = false);


--
-- Name: idx_tenants_billing_currency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_billing_currency ON public.tenants USING btree (billing_currency);


--
-- Name: idx_tenants_demo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_demo ON public.tenants USING btree (is_demo) WHERE (is_demo = true);


--
-- Name: idx_tenants_encryption_reminder_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_encryption_reminder_active ON public.tenants USING btree (id) WHERE (encryption_reminder_paused = false);


--
-- Name: idx_tenants_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_slug ON public.tenants USING btree (slug);


--
-- Name: idx_tenants_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenants_status ON public.tenants USING btree (status);


--
-- Name: idx_ticket_activity_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_activity_tenant ON public.ticket_activity_log USING btree (tenant_id);


--
-- Name: idx_ticket_activity_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_activity_ticket ON public.ticket_activity_log USING btree (ticket_id, created_at);


--
-- Name: idx_ticket_activity_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_activity_type ON public.ticket_activity_log USING btree (tenant_id, activity_type);


--
-- Name: idx_ticket_attachments_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_attachments_ticket ON public.ticket_attachments USING btree (ticket_id);


--
-- Name: idx_ticket_categories_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_categories_tenant ON public.ticket_categories USING btree (tenant_id);


--
-- Name: idx_ticket_custom_field_values_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_custom_field_values_ticket ON public.ticket_custom_field_values USING btree (ticket_id);


--
-- Name: idx_ticket_custom_fields_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_custom_fields_tenant ON public.ticket_custom_fields USING btree (tenant_id);


--
-- Name: idx_ticket_links_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_links_source ON public.ticket_links USING btree (source_ticket_id);


--
-- Name: idx_ticket_links_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_links_target ON public.ticket_links USING btree (target_ticket_id);


--
-- Name: idx_ticket_macros_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_macros_tenant ON public.ticket_macros USING btree (tenant_id);


--
-- Name: idx_ticket_notifications_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_notifications_ticket ON public.ticket_notifications USING btree (ticket_id);


--
-- Name: idx_ticket_notifications_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_notifications_user ON public.ticket_notifications USING btree (tenant_id, user_id, is_read);


--
-- Name: idx_ticket_outbox_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_outbox_status ON public.ticket_outbox USING btree (status);


--
-- Name: idx_ticket_outbox_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_outbox_tenant ON public.ticket_outbox USING btree (tenant_id);


--
-- Name: idx_ticket_queue_configs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_queue_configs_tenant ON public.ticket_queue_configs USING btree (tenant_id);


--
-- Name: idx_ticket_retention_policies_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_retention_policies_tenant ON public.ticket_retention_policies USING btree (tenant_id);


--
-- Name: idx_ticket_saved_views_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_saved_views_tenant ON public.ticket_saved_views USING btree (tenant_id);


--
-- Name: idx_ticket_sla_instances_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_sla_instances_due ON public.ticket_sla_instances USING btree (tenant_id, resolution_due_at);


--
-- Name: idx_ticket_sla_instances_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_sla_instances_ticket ON public.ticket_sla_instances USING btree (ticket_id);


--
-- Name: idx_ticket_sla_instances_ticket_created_at_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_sla_instances_ticket_created_at_desc ON public.ticket_sla_instances USING btree (ticket_id, created_at DESC);


--
-- Name: idx_ticket_sla_policies_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_sla_policies_tenant ON public.ticket_sla_policies USING btree (tenant_id);


--
-- Name: idx_ticket_templates_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_templates_tenant ON public.ticket_templates USING btree (tenant_id);


--
-- Name: idx_ticket_watchers_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_watchers_ticket ON public.ticket_watchers USING btree (ticket_id);


--
-- Name: idx_ticket_workflow_rules_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_workflow_rules_tenant ON public.ticket_workflow_rules USING btree (tenant_id);


--
-- Name: idx_tickets_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_assignee ON public.tickets USING btree (tenant_id, assignee_user_id);


--
-- Name: idx_tickets_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_category ON public.tickets USING btree (tenant_id, category_id);


--
-- Name: idx_tickets_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_created ON public.tickets USING btree (tenant_id, created_at);


--
-- Name: idx_tickets_department; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_department ON public.tickets USING btree (tenant_id, department);


--
-- Name: idx_tickets_priority_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_priority_status ON public.tickets USING btree (tenant_id, priority, status);


--
-- Name: idx_tickets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_status ON public.tickets USING btree (tenant_id, status);


--
-- Name: idx_tickets_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_tenant ON public.tickets USING btree (tenant_id);


--
-- Name: idx_tickets_ticket_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_ticket_number ON public.tickets USING btree (tenant_id, ticket_number);


--
-- Name: idx_tool_failure_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_failure_events_tenant ON public.tool_failure_events USING btree (tenant_id);


--
-- Name: idx_tool_failure_events_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_failure_events_tool ON public.tool_failure_events USING btree (tenant_id, tool_name);


--
-- Name: idx_tool_invocations_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_agent ON public.tool_invocations USING btree (agent_id);


--
-- Name: idx_tool_invocations_call_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_call_session ON public.tool_invocations USING btree (call_session_id);


--
-- Name: idx_tool_invocations_invoked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_invoked ON public.tool_invocations USING btree (invoked_at);


--
-- Name: idx_tool_invocations_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_session ON public.tool_invocations USING btree (call_session_id);


--
-- Name: idx_tool_invocations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_status ON public.tool_invocations USING btree (status);


--
-- Name: idx_tool_invocations_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_tenant ON public.tool_invocations USING btree (tenant_id);


--
-- Name: idx_tool_invocations_tenant_invoked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_tenant_invoked ON public.tool_invocations USING btree (tenant_id, invoked_at DESC);


--
-- Name: idx_tool_invocations_tenant_invoked_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_tenant_invoked_status ON public.tool_invocations USING btree (tenant_id, invoked_at DESC, status);


--
-- Name: idx_tool_invocations_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_tenant_status ON public.tool_invocations USING btree (tenant_id, status);


--
-- Name: idx_tool_invocations_tenant_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_tenant_tool ON public.tool_invocations USING btree (tenant_id, tool_name);


--
-- Name: idx_tool_invocations_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_tool ON public.tool_invocations USING btree (tool_name);


--
-- Name: idx_tooltip_dismissals_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tooltip_dismissals_user ON public.tooltip_dismissals USING btree (user_id);


--
-- Name: idx_twilio_webhook_replay_nonces_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_twilio_webhook_replay_nonces_expires_at ON public.twilio_webhook_replay_nonces USING btree (expires_at);


--
-- Name: idx_usage_metrics_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_metrics_tenant ON public.usage_metrics USING btree (tenant_id);


--
-- Name: idx_usage_metrics_tenant_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_metrics_tenant_period ON public.usage_metrics USING btree (tenant_id, period_start);


--
-- Name: idx_usage_metrics_tenant_time_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_metrics_tenant_time_type ON public.usage_metrics USING btree (tenant_id, period_start DESC, metric_type);


--
-- Name: idx_usage_metrics_tenant_type_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_metrics_tenant_type_period ON public.usage_metrics USING btree (tenant_id, metric_type, period_start, period_end);


--
-- Name: idx_usage_metrics_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usage_metrics_type ON public.usage_metrics USING btree (metric_type);


--
-- Name: idx_user_devices_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_devices_resource ON public.user_devices USING btree (tenant_id, resource_id) WHERE (push_enabled = true);


--
-- Name: idx_user_devices_secret_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_devices_secret_hash ON public.user_devices USING btree (device_secret_hash) WHERE (device_secret_hash IS NOT NULL);


--
-- Name: idx_user_devices_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_devices_user ON public.user_devices USING btree (tenant_id, user_id) WHERE (push_enabled = true);


--
-- Name: idx_user_invitations_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_invitations_tenant ON public.user_invitations USING btree (tenant_id);


--
-- Name: idx_user_invitations_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_invitations_token ON public.user_invitations USING btree (token);


--
-- Name: idx_user_notification_prefs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_notification_prefs_user ON public.user_notification_preferences USING btree (user_id);


--
-- Name: idx_user_tenant_roles_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_tenant_roles_active ON public.user_roles USING btree (tenant_id, role) WHERE (revoked_at IS NULL);


--
-- Name: idx_user_tenant_roles_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_tenant_roles_role ON public.user_roles USING btree (role);


--
-- Name: idx_user_tenant_roles_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_tenant_roles_tenant ON public.user_roles USING btree (tenant_id);


--
-- Name: idx_user_tenant_roles_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_tenant_roles_user ON public.user_roles USING btree (user_id);


--
-- Name: idx_users_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_active ON public.users USING btree (tenant_id, is_active) WHERE (is_active = true);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: idx_users_email_verification_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_email_verification_token ON public.users USING btree (email_verification_token);


--
-- Name: idx_users_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_tenant ON public.users USING btree (tenant_id);


--
-- Name: idx_users_tenant_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_tenant_email ON public.users USING btree (tenant_id, email);


--
-- Name: idx_verified_caller_alert_recipients_caller; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verified_caller_alert_recipients_caller ON public.verified_caller_alert_recipients USING btree (tenant_id, caller_id, dispatched_at DESC);


--
-- Name: idx_verified_caller_alert_recipients_dispatch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verified_caller_alert_recipients_dispatch ON public.verified_caller_alert_recipients USING btree (tenant_id, dispatch_id);


--
-- Name: idx_verified_caller_ids_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verified_caller_ids_expires_at ON public.verified_caller_ids USING btree (expires_at) WHERE (((status)::text = 'verified'::text) AND (expires_at IS NOT NULL));


--
-- Name: idx_verified_caller_ids_health_check; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verified_caller_ids_health_check ON public.verified_caller_ids USING btree (last_health_check_at NULLS FIRST) WHERE ((status)::text = 'verified'::text);


--
-- Name: idx_verified_caller_ids_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verified_caller_ids_tenant ON public.verified_caller_ids USING btree (tenant_id);


--
-- Name: idx_verified_caller_ids_tenant_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verified_caller_ids_tenant_active ON public.verified_caller_ids USING btree (tenant_id) WHERE ((status)::text = 'verified'::text);


--
-- Name: idx_verified_caller_ids_tenant_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verified_caller_ids_tenant_status ON public.verified_caller_ids USING btree (tenant_id, status);


--
-- Name: idx_vertical_demo_flows_vertical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vertical_demo_flows_vertical ON public.vertical_demo_flows USING btree (vertical_id);


--
-- Name: idx_vertical_expansion_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_vertical_expansion_dedup ON public.vertical_expansion_scores USING btree (vertical_name);


--
-- Name: idx_vertical_expansion_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vertical_expansion_name ON public.vertical_expansion_scores USING btree (vertical_name);


--
-- Name: idx_vertical_expansion_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vertical_expansion_score ON public.vertical_expansion_scores USING btree (expansion_score DESC);


--
-- Name: idx_vertical_prompt_library_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vertical_prompt_library_category ON public.vertical_prompt_library USING btree (category);


--
-- Name: idx_vertical_prompt_library_vertical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vertical_prompt_library_vertical ON public.vertical_prompt_library USING btree (vertical_id);


--
-- Name: idx_vertical_starter_knowledge_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vertical_starter_knowledge_type ON public.vertical_starter_knowledge USING btree (category_type);


--
-- Name: idx_vertical_starter_knowledge_vertical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vertical_starter_knowledge_vertical ON public.vertical_starter_knowledge USING btree (vertical_id);


--
-- Name: idx_wce_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wce_created ON public.website_conversion_events USING btree (created_at);


--
-- Name: idx_wce_landing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wce_landing ON public.website_conversion_events USING btree (landing_page);


--
-- Name: idx_wce_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wce_source ON public.website_conversion_events USING btree (utm_source);


--
-- Name: idx_wce_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wce_stage ON public.website_conversion_events USING btree (stage);


--
-- Name: idx_wce_visitor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wce_visitor ON public.website_conversion_events USING btree (visitor_id);


--
-- Name: idx_webhook_events_processed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_events_processed ON public.webhook_events USING btree (processed);


--
-- Name: idx_webhook_events_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_webhook_events_tenant ON public.webhook_events USING btree (tenant_id);


--
-- Name: idx_website_agent_analytics_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_website_agent_analytics_type ON public.website_agent_analytics USING btree (event_type, created_at DESC);


--
-- Name: idx_website_agent_conversations_cid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_website_agent_conversations_cid ON public.website_agent_conversations USING btree (conversation_id);


--
-- Name: idx_website_leads_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_website_leads_conversation_id ON public.website_leads USING btree (conversation_id) WHERE (conversation_id IS NOT NULL);


--
-- Name: idx_website_leads_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_website_leads_created ON public.website_leads USING btree (created_at DESC);


--
-- Name: idx_website_leads_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_website_leads_email ON public.website_leads USING btree (email);


--
-- Name: idx_website_leads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_website_leads_status ON public.website_leads USING btree (status);


--
-- Name: idx_weekly_reports_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_weekly_reports_tenant ON public.weekly_reports USING btree (tenant_id, week_start DESC);


--
-- Name: idx_weekly_reports_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_weekly_reports_unique ON public.weekly_reports USING btree (tenant_id, week_start);


--
-- Name: idx_wf_opt_insights_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_opt_insights_status ON public.workforce_optimization_insights USING btree (tenant_id, status);


--
-- Name: idx_wf_opt_insights_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_opt_insights_team ON public.workforce_optimization_insights USING btree (team_id, status);


--
-- Name: idx_wf_opt_insights_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_opt_insights_tenant ON public.workforce_optimization_insights USING btree (tenant_id, created_at DESC);


--
-- Name: idx_wf_outbound_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_outbound_team ON public.workforce_outbound_tasks USING btree (team_id, status);


--
-- Name: idx_wf_outbound_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_outbound_tenant ON public.workforce_outbound_tasks USING btree (tenant_id, created_at DESC);


--
-- Name: idx_wf_revenue_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_revenue_team ON public.workforce_revenue_metrics USING btree (team_id, period_start DESC);


--
-- Name: idx_wf_revenue_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wf_revenue_tenant ON public.workforce_revenue_metrics USING btree (tenant_id, period_start DESC);


--
-- Name: idx_wf_revenue_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_wf_revenue_unique ON public.workforce_revenue_metrics USING btree (team_id, period_start, period_end);


--
-- Name: idx_widget_configs_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_widget_configs_tenant ON public.widget_configs USING btree (tenant_id);


--
-- Name: idx_widget_tokens_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_widget_tokens_hash ON public.widget_tokens USING btree (token_hash);


--
-- Name: idx_widget_tokens_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_widget_tokens_tenant ON public.widget_tokens USING btree (tenant_id);


--
-- Name: idx_workflow_executions_call_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_call_session ON public.workflow_executions USING btree (call_session_id);


--
-- Name: idx_workflow_executions_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_session ON public.workflow_executions USING btree (call_session_id);


--
-- Name: idx_workflow_executions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_status ON public.workflow_executions USING btree (status);


--
-- Name: idx_workflow_executions_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_tenant ON public.workflow_executions USING btree (tenant_id);


--
-- Name: idx_workflow_executions_tenant_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_tenant_started ON public.workflow_executions USING btree (tenant_id, started_at);


--
-- Name: idx_workflow_executions_tenant_started_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_tenant_started_status ON public.workflow_executions USING btree (tenant_id, started_at DESC, status);


--
-- Name: idx_workflow_executions_workflow_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_workflow_name ON public.workflow_executions USING btree (tenant_id, workflow_name);


--
-- Name: idx_workflow_perf_metrics_industry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_perf_metrics_industry ON public.workflow_performance_metrics USING btree (industry_vertical, workflow_type);


--
-- Name: idx_workflow_perf_metrics_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_perf_metrics_type ON public.workflow_performance_metrics USING btree (workflow_type, metric_name, period_end DESC);


--
-- Name: idx_workflow_steps_execution; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_steps_execution ON public.workflow_steps USING btree (workflow_execution_id);


--
-- Name: idx_workflow_steps_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_steps_tenant ON public.workflow_steps USING btree (tenant_id);


--
-- Name: idx_workflow_steps_tenant_started_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_steps_tenant_started_status ON public.workflow_steps USING btree (tenant_id, started_at DESC, status);


--
-- Name: idx_workflows_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflows_tenant ON public.workflows USING btree (tenant_id);


--
-- Name: idx_workforce_members_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_members_agent ON public.workforce_members USING btree (agent_id);


--
-- Name: idx_workforce_members_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_members_team ON public.workforce_members USING btree (team_id);


--
-- Name: idx_workforce_members_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_members_tenant ON public.workforce_members USING btree (tenant_id);


--
-- Name: idx_workforce_routing_history_call; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_routing_history_call ON public.workforce_routing_history USING btree (call_session_id);


--
-- Name: idx_workforce_routing_history_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_routing_history_created ON public.workforce_routing_history USING btree (tenant_id, created_at DESC);


--
-- Name: idx_workforce_routing_history_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_routing_history_team ON public.workforce_routing_history USING btree (team_id);


--
-- Name: idx_workforce_routing_history_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_routing_history_tenant ON public.workforce_routing_history USING btree (tenant_id);


--
-- Name: idx_workforce_routing_rules_intent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_routing_rules_intent ON public.workforce_routing_rules USING btree (team_id, intent);


--
-- Name: idx_workforce_routing_rules_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_routing_rules_team ON public.workforce_routing_rules USING btree (team_id);


--
-- Name: idx_workforce_routing_rules_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_routing_rules_tenant ON public.workforce_routing_rules USING btree (tenant_id);


--
-- Name: idx_workforce_teams_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_teams_status ON public.workforce_teams USING btree (tenant_id, status);


--
-- Name: idx_workforce_teams_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_teams_tenant ON public.workforce_teams USING btree (tenant_id);


--
-- Name: idx_workforce_templates_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_templates_tenant ON public.workforce_templates USING btree (tenant_id);


--
-- Name: idx_workforce_templates_vertical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workforce_templates_vertical ON public.workforce_templates USING btree (vertical);


--
-- Name: marketing_lead_events_lead_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketing_lead_events_lead_id_created_at_idx ON public.marketing_lead_events USING btree (lead_id, created_at DESC);


--
-- Name: marketing_leads_email_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketing_leads_email_lower_idx ON public.marketing_leads USING btree (lower(email));


--
-- Name: marketing_leads_source_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketing_leads_source_created_at_idx ON public.marketing_leads USING btree (source, created_at DESC);


--
-- Name: marketing_leads_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketing_leads_status_idx ON public.marketing_leads USING btree (status, created_at DESC);


--
-- Name: retry_attempts_last_attempt_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX retry_attempts_last_attempt_at_idx ON public.retry_attempts USING btree (last_attempt_at);


--
-- Name: support_email_unsubscribe_audit_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_email_unsubscribe_audit_email_idx ON public.support_email_unsubscribe_audit USING btree (email_lower, resubscribed_at DESC);


--
-- Name: support_email_unsubscribe_audit_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_email_unsubscribe_audit_recent_idx ON public.support_email_unsubscribe_audit USING btree (resubscribed_at DESC);


--
-- Name: support_ticket_replies_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_ticket_replies_retry_idx ON public.support_ticket_replies USING btree (created_at) WHERE (((direction)::text = 'outbound'::text) AND (email_error IS NOT NULL));


--
-- Name: support_ticket_replies_ticket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_ticket_replies_ticket_idx ON public.support_ticket_replies USING btree (ticket_id, created_at);


--
-- Name: support_tickets_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_created_idx ON public.support_tickets USING btree (created_at DESC);


--
-- Name: support_tickets_inbound_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX support_tickets_inbound_token_idx ON public.support_tickets USING btree (inbound_token) WHERE (inbound_token IS NOT NULL);


--
-- Name: support_tickets_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_status_idx ON public.support_tickets USING btree (status);


--
-- Name: support_tickets_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_tenant_idx ON public.support_tickets USING btree (tenant_id);


--
-- Name: uniq_dispatch_jobs_tracking_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_dispatch_jobs_tracking_token ON public.dispatch_jobs USING btree (tracking_token);


--
-- Name: uniq_dispatch_route_export_jobs_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_dispatch_route_export_jobs_token ON public.dispatch_route_export_jobs USING btree (download_token) WHERE (download_token IS NOT NULL);


--
-- Name: call_events_2026_03_call_session_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_session ATTACH PARTITION public.call_events_2026_03_call_session_id_idx;


--
-- Name: call_events_2026_03_event_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_type ATTACH PARTITION public.call_events_2026_03_event_type_idx;


--
-- Name: call_events_2026_03_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.call_events_pkey1 ATTACH PARTITION public.call_events_2026_03_pkey;


--
-- Name: call_events_2026_03_tenant_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant ATTACH PARTITION public.call_events_2026_03_tenant_id_idx;


--
-- Name: call_events_2026_03_tenant_id_occurred_at_event_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant_occurred_type ATTACH PARTITION public.call_events_2026_03_tenant_id_occurred_at_event_type_idx;


--
-- Name: call_events_2026_03_tenant_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant_occurred ATTACH PARTITION public.call_events_2026_03_tenant_id_occurred_at_idx;


--
-- Name: call_events_2026_04_call_session_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_session ATTACH PARTITION public.call_events_2026_04_call_session_id_idx;


--
-- Name: call_events_2026_04_event_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_type ATTACH PARTITION public.call_events_2026_04_event_type_idx;


--
-- Name: call_events_2026_04_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.call_events_pkey1 ATTACH PARTITION public.call_events_2026_04_pkey;


--
-- Name: call_events_2026_04_tenant_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant ATTACH PARTITION public.call_events_2026_04_tenant_id_idx;


--
-- Name: call_events_2026_04_tenant_id_occurred_at_event_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant_occurred_type ATTACH PARTITION public.call_events_2026_04_tenant_id_occurred_at_event_type_idx;


--
-- Name: call_events_2026_04_tenant_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant_occurred ATTACH PARTITION public.call_events_2026_04_tenant_id_occurred_at_idx;


--
-- Name: call_events_2026_05_call_session_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_session ATTACH PARTITION public.call_events_2026_05_call_session_id_idx;


--
-- Name: call_events_2026_05_event_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_type ATTACH PARTITION public.call_events_2026_05_event_type_idx;


--
-- Name: call_events_2026_05_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.call_events_pkey1 ATTACH PARTITION public.call_events_2026_05_pkey;


--
-- Name: call_events_2026_05_tenant_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant ATTACH PARTITION public.call_events_2026_05_tenant_id_idx;


--
-- Name: call_events_2026_05_tenant_id_occurred_at_event_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant_occurred_type ATTACH PARTITION public.call_events_2026_05_tenant_id_occurred_at_event_type_idx;


--
-- Name: call_events_2026_05_tenant_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant_occurred ATTACH PARTITION public.call_events_2026_05_tenant_id_occurred_at_idx;


--
-- Name: call_events_2026_06_call_session_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_session ATTACH PARTITION public.call_events_2026_06_call_session_id_idx;


--
-- Name: call_events_2026_06_event_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_type ATTACH PARTITION public.call_events_2026_06_event_type_idx;


--
-- Name: call_events_2026_06_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.call_events_pkey1 ATTACH PARTITION public.call_events_2026_06_pkey;


--
-- Name: call_events_2026_06_tenant_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant ATTACH PARTITION public.call_events_2026_06_tenant_id_idx;


--
-- Name: call_events_2026_06_tenant_id_occurred_at_event_type_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant_occurred_type ATTACH PARTITION public.call_events_2026_06_tenant_id_occurred_at_event_type_idx;


--
-- Name: call_events_2026_06_tenant_id_occurred_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_call_events_tenant_occurred ATTACH PARTITION public.call_events_2026_06_tenant_id_occurred_at_idx;


--
-- Name: audit_logs audit_logs_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_mutation();


--
-- Name: audit_logs audit_logs_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_mutation();


--
-- Name: activation_events activation_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_events
    ADD CONSTRAINT activation_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: active_call_sessions active_call_sessions_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_call_sessions
    ADD CONSTRAINT active_call_sessions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: active_call_sessions active_call_sessions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_call_sessions
    ADD CONSTRAINT active_call_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: agent_prompt_versions agent_prompt_versions_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_prompt_versions
    ADD CONSTRAINT agent_prompt_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: legacy_agent_prompt_versions agent_prompt_versions_agent_prompt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legacy_agent_prompt_versions
    ADD CONSTRAINT agent_prompt_versions_agent_prompt_id_fkey FOREIGN KEY (agent_prompt_id) REFERENCES public.agent_prompts(id) ON DELETE CASCADE;


--
-- Name: legacy_agent_prompt_versions agent_prompt_versions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legacy_agent_prompt_versions
    ADD CONSTRAINT agent_prompt_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: agent_prompt_versions agent_prompt_versions_tenant_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_prompt_versions
    ADD CONSTRAINT agent_prompt_versions_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: agent_prompts agent_prompts_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_prompts
    ADD CONSTRAINT agent_prompts_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_prompts agent_prompts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_prompts
    ADD CONSTRAINT agent_prompts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: agent_templates agent_templates_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_templates
    ADD CONSTRAINT agent_templates_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: agent_templates agent_templates_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_templates
    ADD CONSTRAINT agent_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: agent_tools agent_tools_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tools
    ADD CONSTRAINT agent_tools_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_tools agent_tools_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tools
    ADD CONSTRAINT agent_tools_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: agent_versions agent_versions_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agent_versions agent_versions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_versions
    ADD CONSTRAINT agent_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: agents agents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: agents agents_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE SET NULL;


--
-- Name: ai_insights ai_insights_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_insights
    ADD CONSTRAINT ai_insights_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: analytics_metrics analytics_metrics_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_metrics
    ADD CONSTRAINT analytics_metrics_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: answering_service_logs answering_service_logs_call_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.answering_service_logs
    ADD CONSTRAINT answering_service_logs_call_log_id_fkey FOREIGN KEY (call_log_id) REFERENCES public.call_logs(id);


--
-- Name: answering_service_logs answering_service_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.answering_service_logs
    ADD CONSTRAINT answering_service_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: appointment_scheduling_dispatch appointment_scheduling_dispatch_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_scheduling_dispatch
    ADD CONSTRAINT appointment_scheduling_dispatch_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: assistant_actions assistant_actions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_actions
    ADD CONSTRAINT assistant_actions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.assistant_sessions(id) ON DELETE CASCADE;


--
-- Name: assistant_actions assistant_actions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_actions
    ADD CONSTRAINT assistant_actions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: assistant_sessions assistant_sessions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_sessions
    ADD CONSTRAINT assistant_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: audit_logs audit_logs_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: autopilot_actions autopilot_actions_recommendation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_actions
    ADD CONSTRAINT autopilot_actions_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES public.autopilot_recommendations(id) ON DELETE SET NULL;


--
-- Name: autopilot_actions autopilot_actions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_actions
    ADD CONSTRAINT autopilot_actions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: autopilot_approvals autopilot_approvals_recommendation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_approvals
    ADD CONSTRAINT autopilot_approvals_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES public.autopilot_recommendations(id) ON DELETE CASCADE;


--
-- Name: autopilot_approvals autopilot_approvals_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_approvals
    ADD CONSTRAINT autopilot_approvals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: autopilot_impact_reports autopilot_impact_reports_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_impact_reports
    ADD CONSTRAINT autopilot_impact_reports_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.autopilot_actions(id) ON DELETE SET NULL;


--
-- Name: autopilot_impact_reports autopilot_impact_reports_recommendation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_impact_reports
    ADD CONSTRAINT autopilot_impact_reports_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES public.autopilot_recommendations(id) ON DELETE SET NULL;


--
-- Name: autopilot_impact_reports autopilot_impact_reports_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_impact_reports
    ADD CONSTRAINT autopilot_impact_reports_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: autopilot_insights autopilot_insights_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_insights
    ADD CONSTRAINT autopilot_insights_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.autopilot_runs(id) ON DELETE SET NULL;


--
-- Name: autopilot_insights autopilot_insights_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_insights
    ADD CONSTRAINT autopilot_insights_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: autopilot_notifications autopilot_notifications_insight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_notifications
    ADD CONSTRAINT autopilot_notifications_insight_id_fkey FOREIGN KEY (insight_id) REFERENCES public.autopilot_insights(id) ON DELETE SET NULL;


--
-- Name: autopilot_notifications autopilot_notifications_recommendation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_notifications
    ADD CONSTRAINT autopilot_notifications_recommendation_id_fkey FOREIGN KEY (recommendation_id) REFERENCES public.autopilot_recommendations(id) ON DELETE SET NULL;


--
-- Name: autopilot_notifications autopilot_notifications_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_notifications
    ADD CONSTRAINT autopilot_notifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: autopilot_policies autopilot_policies_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_policies
    ADD CONSTRAINT autopilot_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: autopilot_recommendations autopilot_recommendations_insight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_recommendations
    ADD CONSTRAINT autopilot_recommendations_insight_id_fkey FOREIGN KEY (insight_id) REFERENCES public.autopilot_insights(id) ON DELETE CASCADE;


--
-- Name: autopilot_recommendations autopilot_recommendations_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_recommendations
    ADD CONSTRAINT autopilot_recommendations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.autopilot_runs(id) ON DELETE SET NULL;


--
-- Name: autopilot_recommendations autopilot_recommendations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_recommendations
    ADD CONSTRAINT autopilot_recommendations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: autopilot_runs autopilot_runs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_runs
    ADD CONSTRAINT autopilot_runs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: billing_events billing_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_events
    ADD CONSTRAINT billing_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: billing_recommendation_events billing_recommendation_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_recommendation_events
    ADD CONSTRAINT billing_recommendation_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: bookings bookings_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_appointment_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_appointment_type_id_fkey FOREIGN KEY (appointment_type_id) REFERENCES public.scheduling_appointment_types(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.scheduling_providers(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.scheduling_resources(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_conversion_stages call_conversion_stages_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_conversion_stages
    ADD CONSTRAINT call_conversion_stages_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE;


--
-- Name: call_conversion_stages call_conversion_stages_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_conversion_stages
    ADD CONSTRAINT call_conversion_stages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_csat_responses call_csat_responses_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_csat_responses
    ADD CONSTRAINT call_csat_responses_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE;


--
-- Name: call_csat_responses call_csat_responses_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_csat_responses
    ADD CONSTRAINT call_csat_responses_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_events call_events_call_session_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.call_events
    ADD CONSTRAINT call_events_call_session_id_fkey1 FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE;


--
-- Name: call_events call_events_tenant_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.call_events
    ADD CONSTRAINT call_events_tenant_id_fkey1 FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_logs call_logs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: call_logs call_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT call_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_quality_scores call_quality_scores_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_quality_scores
    ADD CONSTRAINT call_quality_scores_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE;


--
-- Name: call_quality_scores call_quality_scores_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_quality_scores
    ADD CONSTRAINT call_quality_scores_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_saved_view_pins call_saved_view_pins_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_saved_view_pins
    ADD CONSTRAINT call_saved_view_pins_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_saved_view_pins call_saved_view_pins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_saved_view_pins
    ADD CONSTRAINT call_saved_view_pins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: call_saved_view_pins call_saved_view_pins_view_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_saved_view_pins
    ADD CONSTRAINT call_saved_view_pins_view_id_fkey FOREIGN KEY (view_id) REFERENCES public.call_saved_views(id) ON DELETE CASCADE;


--
-- Name: call_saved_views call_saved_views_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_saved_views
    ADD CONSTRAINT call_saved_views_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: call_saved_views call_saved_views_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_saved_views
    ADD CONSTRAINT call_saved_views_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_sentiment_scores call_sentiment_scores_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sentiment_scores
    ADD CONSTRAINT call_sentiment_scores_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE;


--
-- Name: call_sentiment_scores call_sentiment_scores_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sentiment_scores
    ADD CONSTRAINT call_sentiment_scores_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_sessions call_sessions_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT call_sessions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: call_sessions call_sessions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT call_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_topic_classifications call_topic_classifications_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_topic_classifications
    ADD CONSTRAINT call_topic_classifications_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE;


--
-- Name: call_topic_classifications call_topic_classifications_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_topic_classifications
    ADD CONSTRAINT call_topic_classifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: call_transcripts call_transcripts_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_transcripts
    ADD CONSTRAINT call_transcripts_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE;


--
-- Name: call_transcripts call_transcripts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_transcripts
    ADD CONSTRAINT call_transcripts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: callback_queue callback_queue_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.callback_queue
    ADD CONSTRAINT callback_queue_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: callback_queue callback_queue_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.callback_queue
    ADD CONSTRAINT callback_queue_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: campaign_contact_attempts campaign_contact_attempts_campaign_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_contact_attempts
    ADD CONSTRAINT campaign_contact_attempts_campaign_contact_id_fkey FOREIGN KEY (campaign_contact_id) REFERENCES public.campaign_contacts(id) ON DELETE CASCADE;


--
-- Name: campaign_contact_attempts campaign_contact_attempts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_contact_attempts
    ADD CONSTRAINT campaign_contact_attempts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: campaign_contacts campaign_contacts_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_contacts
    ADD CONSTRAINT campaign_contacts_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: campaign_contacts campaign_contacts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_contacts
    ADD CONSTRAINT campaign_contacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: campaigns campaigns_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: campaigns campaigns_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: case_studies case_studies_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_studies
    ADD CONSTRAINT case_studies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: changelog_reads changelog_reads_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.changelog_reads
    ADD CONSTRAINT changelog_reads_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.changelog_entries(id) ON DELETE CASCADE;


--
-- Name: changelog_reads changelog_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.changelog_reads
    ADD CONSTRAINT changelog_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: connector_alert_mutes connector_alert_mutes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_alert_mutes
    ADD CONSTRAINT connector_alert_mutes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: connector_alert_recipients connector_alert_recipients_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_alert_recipients
    ADD CONSTRAINT connector_alert_recipients_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: connector_alert_recipients connector_alert_recipients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_alert_recipients
    ADD CONSTRAINT connector_alert_recipients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: connector_alert_settings connector_alert_settings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_alert_settings
    ADD CONSTRAINT connector_alert_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: connector_configs connector_configs_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_configs
    ADD CONSTRAINT connector_configs_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE CASCADE;


--
-- Name: connector_configs connector_configs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_configs
    ADD CONSTRAINT connector_configs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: conversation_costs conversation_costs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_costs
    ADD CONSTRAINT conversation_costs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: cost_budget_settings cost_budget_settings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_budget_settings
    ADD CONSTRAINT cost_budget_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: crm_stale_cache_scrubs crm_stale_cache_scrubs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_stale_cache_scrubs
    ADD CONSTRAINT crm_stale_cache_scrubs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: daily_openai_costs daily_openai_costs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_openai_costs
    ADD CONSTRAINT daily_openai_costs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: daily_org_usage daily_org_usage_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_org_usage
    ADD CONSTRAINT daily_org_usage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: daily_reconciliation daily_reconciliation_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_reconciliation
    ADD CONSTRAINT daily_reconciliation_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: demo_agents demo_agents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_agents
    ADD CONSTRAINT demo_agents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: demo_sessions demo_sessions_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_sessions
    ADD CONSTRAINT demo_sessions_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE SET NULL;


--
-- Name: demo_sessions demo_sessions_demo_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_sessions
    ADD CONSTRAINT demo_sessions_demo_agent_id_fkey FOREIGN KEY (demo_agent_id) REFERENCES public.demo_agents(id) ON DELETE CASCADE;


--
-- Name: demo_sessions demo_sessions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.demo_sessions
    ADD CONSTRAINT demo_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: developer_submissions developer_submissions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.developer_submissions
    ADD CONSTRAINT developer_submissions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_registry(id);


--
-- Name: digital_twin_models digital_twin_models_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_twin_models
    ADD CONSTRAINT digital_twin_models_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: digital_twin_results digital_twin_results_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_twin_results
    ADD CONSTRAINT digital_twin_results_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.digital_twin_simulation_runs(id) ON DELETE CASCADE;


--
-- Name: digital_twin_results digital_twin_results_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_twin_results
    ADD CONSTRAINT digital_twin_results_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: digital_twin_simulation_runs digital_twin_simulation_runs_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_twin_simulation_runs
    ADD CONSTRAINT digital_twin_simulation_runs_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.digital_twin_models(id) ON DELETE CASCADE;


--
-- Name: digital_twin_simulation_runs digital_twin_simulation_runs_scenario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_twin_simulation_runs
    ADD CONSTRAINT digital_twin_simulation_runs_scenario_id_fkey FOREIGN KEY (scenario_id) REFERENCES public.digital_twin_scenarios(id) ON DELETE CASCADE;


--
-- Name: digital_twin_simulation_runs digital_twin_simulation_runs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.digital_twin_simulation_runs
    ADD CONSTRAINT digital_twin_simulation_runs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_assignment_rules dispatch_assignment_rules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_assignment_rules
    ADD CONSTRAINT dispatch_assignment_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_job_attachments dispatch_job_attachments_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_job_attachments
    ADD CONSTRAINT dispatch_job_attachments_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.dispatch_jobs(id) ON DELETE CASCADE;


--
-- Name: dispatch_job_attachments dispatch_job_attachments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_job_attachments
    ADD CONSTRAINT dispatch_job_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_job_events dispatch_job_events_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_job_events
    ADD CONSTRAINT dispatch_job_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.dispatch_jobs(id) ON DELETE CASCADE;


--
-- Name: dispatch_job_events dispatch_job_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_job_events
    ADD CONSTRAINT dispatch_job_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_job_exceptions dispatch_job_exceptions_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_job_exceptions
    ADD CONSTRAINT dispatch_job_exceptions_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.dispatch_jobs(id) ON DELETE CASCADE;


--
-- Name: dispatch_job_exceptions dispatch_job_exceptions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_job_exceptions
    ADD CONSTRAINT dispatch_job_exceptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_jobs dispatch_jobs_assignee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_jobs
    ADD CONSTRAINT dispatch_jobs_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: dispatch_jobs dispatch_jobs_parent_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_jobs
    ADD CONSTRAINT dispatch_jobs_parent_job_id_fkey FOREIGN KEY (parent_job_id) REFERENCES public.dispatch_jobs(id) ON DELETE SET NULL;


--
-- Name: dispatch_jobs dispatch_jobs_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_jobs
    ADD CONSTRAINT dispatch_jobs_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.dispatch_resources(id) ON DELETE SET NULL;


--
-- Name: dispatch_jobs dispatch_jobs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_jobs
    ADD CONSTRAINT dispatch_jobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_jobs dispatch_jobs_territory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_jobs
    ADD CONSTRAINT dispatch_jobs_territory_id_fkey FOREIGN KEY (territory_id) REFERENCES public.dispatch_territories(id) ON DELETE SET NULL;


--
-- Name: dispatch_notification_templates dispatch_notification_templates_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_notification_templates
    ADD CONSTRAINT dispatch_notification_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_notifications_log dispatch_notifications_log_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_notifications_log
    ADD CONSTRAINT dispatch_notifications_log_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.dispatch_jobs(id) ON DELETE SET NULL;


--
-- Name: dispatch_notifications_log dispatch_notifications_log_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_notifications_log
    ADD CONSTRAINT dispatch_notifications_log_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.dispatch_notification_templates(id) ON DELETE SET NULL;


--
-- Name: dispatch_notifications_log dispatch_notifications_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_notifications_log
    ADD CONSTRAINT dispatch_notifications_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_resource_location_history dispatch_resource_location_history_active_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_location_history
    ADD CONSTRAINT dispatch_resource_location_history_active_job_id_fkey FOREIGN KEY (active_job_id) REFERENCES public.dispatch_jobs(id) ON DELETE SET NULL;


--
-- Name: dispatch_resource_location_history dispatch_resource_location_history_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_location_history
    ADD CONSTRAINT dispatch_resource_location_history_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.dispatch_resources(id) ON DELETE CASCADE;


--
-- Name: dispatch_resource_location_history dispatch_resource_location_history_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_location_history
    ADD CONSTRAINT dispatch_resource_location_history_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_resource_locations dispatch_resource_locations_active_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_locations
    ADD CONSTRAINT dispatch_resource_locations_active_job_id_fkey FOREIGN KEY (active_job_id) REFERENCES public.dispatch_jobs(id) ON DELETE SET NULL;


--
-- Name: dispatch_resource_locations dispatch_resource_locations_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_locations
    ADD CONSTRAINT dispatch_resource_locations_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.dispatch_resources(id) ON DELETE CASCADE;


--
-- Name: dispatch_resource_locations dispatch_resource_locations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_locations
    ADD CONSTRAINT dispatch_resource_locations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_resource_pairing_codes dispatch_resource_pairing_codes_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_pairing_codes
    ADD CONSTRAINT dispatch_resource_pairing_codes_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.dispatch_resources(id) ON DELETE CASCADE;


--
-- Name: dispatch_resource_pairing_codes dispatch_resource_pairing_codes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_pairing_codes
    ADD CONSTRAINT dispatch_resource_pairing_codes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_resource_skills dispatch_resource_skills_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_skills
    ADD CONSTRAINT dispatch_resource_skills_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.dispatch_resources(id) ON DELETE CASCADE;


--
-- Name: dispatch_resource_skills dispatch_resource_skills_skill_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resource_skills
    ADD CONSTRAINT dispatch_resource_skills_skill_type_id_fkey FOREIGN KEY (skill_type_id) REFERENCES public.dispatch_skill_types(id) ON DELETE CASCADE;


--
-- Name: dispatch_resources dispatch_resources_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resources
    ADD CONSTRAINT dispatch_resources_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_resources dispatch_resources_territory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resources
    ADD CONSTRAINT dispatch_resources_territory_id_fkey FOREIGN KEY (territory_id) REFERENCES public.dispatch_territories(id) ON DELETE SET NULL;


--
-- Name: dispatch_resources dispatch_resources_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_resources
    ADD CONSTRAINT dispatch_resources_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: dispatch_route_export_jobs dispatch_route_export_jobs_requested_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_route_export_jobs
    ADD CONSTRAINT dispatch_route_export_jobs_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: dispatch_route_export_jobs dispatch_route_export_jobs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_route_export_jobs
    ADD CONSTRAINT dispatch_route_export_jobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_skill_types dispatch_skill_types_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_skill_types
    ADD CONSTRAINT dispatch_skill_types_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dispatch_territories dispatch_territories_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_territories
    ADD CONSTRAINT dispatch_territories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: dnc_list dnc_list_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dnc_list
    ADD CONSTRAINT dnc_list_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: docs_feedback_replies docs_feedback_replies_feedback_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs_feedback_replies
    ADD CONSTRAINT docs_feedback_replies_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES public.docs_feedback(id) ON DELETE CASCADE;


--
-- Name: docs_feedback_replies docs_feedback_replies_retry_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docs_feedback_replies
    ADD CONSTRAINT docs_feedback_replies_retry_of_fkey FOREIGN KEY (retry_of) REFERENCES public.docs_feedback_replies(id) ON DELETE SET NULL;


--
-- Name: encrypted_fields encrypted_fields_encryption_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encrypted_fields
    ADD CONSTRAINT encrypted_fields_encryption_key_id_fkey FOREIGN KEY (encryption_key_id) REFERENCES public.encryption_keys(id);


--
-- Name: encrypted_fields encrypted_fields_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encrypted_fields
    ADD CONSTRAINT encrypted_fields_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: encryption_keys encryption_keys_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_keys
    ADD CONSTRAINT encryption_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: error_logs error_logs_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_logs
    ADD CONSTRAINT error_logs_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE SET NULL;


--
-- Name: error_logs error_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_logs
    ADD CONSTRAINT error_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: evolution_signals evolution_signals_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evolution_signals
    ADD CONSTRAINT evolution_signals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: experiment_results experiment_results_opportunity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.experiment_results
    ADD CONSTRAINT experiment_results_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES public.evolution_opportunities(id) ON DELETE SET NULL;


--
-- Name: feature_request_clusters feature_request_clusters_opportunity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_request_clusters
    ADD CONSTRAINT feature_request_clusters_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES public.evolution_opportunities(id) ON DELETE SET NULL;


--
-- Name: execution_traces fk_execution_traces_call_session; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.execution_traces
    ADD CONSTRAINT fk_execution_traces_call_session FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE;


--
-- Name: forecast_models forecast_models_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_models
    ADD CONSTRAINT forecast_models_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.digital_twin_models(id) ON DELETE SET NULL;


--
-- Name: forecast_models forecast_models_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forecast_models
    ADD CONSTRAINT forecast_models_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: gdpr_requests gdpr_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_requests
    ADD CONSTRAINT gdpr_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: gdpr_requests gdpr_requests_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_requests
    ADD CONSTRAINT gdpr_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: gin_policy_acceptance_records gin_policy_acceptance_records_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gin_policy_acceptance_records
    ADD CONSTRAINT gin_policy_acceptance_records_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: global_insight_patterns global_insight_patterns_aggregation_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_insight_patterns
    ADD CONSTRAINT global_insight_patterns_aggregation_run_id_fkey FOREIGN KEY (aggregation_run_id) REFERENCES public.gin_aggregation_runs(id) ON DELETE SET NULL;


--
-- Name: global_prompt_patterns global_prompt_patterns_aggregation_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_prompt_patterns
    ADD CONSTRAINT global_prompt_patterns_aggregation_run_id_fkey FOREIGN KEY (aggregation_run_id) REFERENCES public.gin_aggregation_runs(id) ON DELETE SET NULL;


--
-- Name: handoff_states handoff_states_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.handoff_states
    ADD CONSTRAINT handoff_states_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: handoff_states handoff_states_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.handoff_states
    ADD CONSTRAINT handoff_states_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: improvement_metrics improvement_metrics_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.improvement_metrics
    ADD CONSTRAINT improvement_metrics_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: improvement_metrics improvement_metrics_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.improvement_metrics
    ADD CONSTRAINT improvement_metrics_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: industry_benchmarks industry_benchmarks_aggregation_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.industry_benchmarks
    ADD CONSTRAINT industry_benchmarks_aggregation_run_id_fkey FOREIGN KEY (aggregation_run_id) REFERENCES public.gin_aggregation_runs(id) ON DELETE SET NULL;


--
-- Name: ingest_events ingest_events_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_events
    ADD CONSTRAINT ingest_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: integration_demand_scores integration_demand_scores_opportunity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_demand_scores
    ADD CONSTRAINT integration_demand_scores_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES public.evolution_opportunities(id) ON DELETE SET NULL;


--
-- Name: integrations integrations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: knowledge_articles knowledge_articles_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_articles
    ADD CONSTRAINT knowledge_articles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: knowledge_chunks knowledge_chunks_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.knowledge_documents(id) ON DELETE CASCADE;


--
-- Name: knowledge_chunks knowledge_chunks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: knowledge_documents knowledge_documents_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_documents
    ADD CONSTRAINT knowledge_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: marketing_lead_events marketing_lead_events_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_lead_events
    ADD CONSTRAINT marketing_lead_events_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.marketing_leads(id) ON DELETE CASCADE;


--
-- Name: marketplace_opportunity_scores marketplace_opportunity_scores_opportunity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_opportunity_scores
    ADD CONSTRAINT marketplace_opportunity_scores_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES public.evolution_opportunities(id) ON DELETE SET NULL;


--
-- Name: marketplace_purchases marketplace_purchases_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_purchases
    ADD CONSTRAINT marketplace_purchases_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_registry(id) ON DELETE CASCADE;


--
-- Name: marketplace_revenue_events marketplace_revenue_events_purchase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_revenue_events
    ADD CONSTRAINT marketplace_revenue_events_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.marketplace_purchases(id);


--
-- Name: marketplace_revenue_events marketplace_revenue_events_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_revenue_events
    ADD CONSTRAINT marketplace_revenue_events_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_registry(id);


--
-- Name: marketplace_reviews marketplace_reviews_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reviews
    ADD CONSTRAINT marketplace_reviews_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_registry(id) ON DELETE CASCADE;


--
-- Name: milestone_thresholds milestone_thresholds_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.milestone_thresholds
    ADD CONSTRAINT milestone_thresholds_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: model_routing_log model_routing_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_routing_log
    ADD CONSTRAINT model_routing_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: network_recommendations network_recommendations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.network_recommendations
    ADD CONSTRAINT network_recommendations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: number_routing number_routing_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_routing
    ADD CONSTRAINT number_routing_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: number_routing number_routing_phone_number_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_routing
    ADD CONSTRAINT number_routing_phone_number_id_fkey FOREIGN KEY (phone_number_id) REFERENCES public.phone_numbers(id) ON DELETE CASCADE;


--
-- Name: number_routing number_routing_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_routing
    ADD CONSTRAINT number_routing_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: operations_alerts operations_alerts_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_alerts
    ADD CONSTRAINT operations_alerts_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE SET NULL;


--
-- Name: operations_alerts operations_alerts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_alerts
    ADD CONSTRAINT operations_alerts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: outbox_events outbox_events_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id);


--
-- Name: outbox_events outbox_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: outbox_messages outbox_messages_call_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_messages
    ADD CONSTRAINT outbox_messages_call_log_id_fkey FOREIGN KEY (call_log_id) REFERENCES public.call_sessions(id) ON DELETE SET NULL;


--
-- Name: outbox_messages outbox_messages_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_messages
    ADD CONSTRAINT outbox_messages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: password_reset_tokens password_reset_tokens_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: phone_endpoints phone_endpoints_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_endpoints
    ADD CONSTRAINT phone_endpoints_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: phone_numbers phone_numbers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_numbers
    ADD CONSTRAINT phone_numbers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: platform_settings platform_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: prompt_improvement_suggestions prompt_improvement_suggestions_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_improvement_suggestions
    ADD CONSTRAINT prompt_improvement_suggestions_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.users(id);


--
-- Name: prompt_improvement_suggestions prompt_improvement_suggestions_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_improvement_suggestions
    ADD CONSTRAINT prompt_improvement_suggestions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id);


--
-- Name: prompt_improvement_suggestions prompt_improvement_suggestions_dismissed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_improvement_suggestions
    ADD CONSTRAINT prompt_improvement_suggestions_dismissed_by_fkey FOREIGN KEY (dismissed_by) REFERENCES public.users(id);


--
-- Name: prompt_improvement_suggestions prompt_improvement_suggestions_source_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_improvement_suggestions
    ADD CONSTRAINT prompt_improvement_suggestions_source_call_session_id_fkey FOREIGN KEY (source_call_session_id) REFERENCES public.call_sessions(id);


--
-- Name: prompt_improvement_suggestions prompt_improvement_suggestions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_improvement_suggestions
    ADD CONSTRAINT prompt_improvement_suggestions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: prompt_versions prompt_versions_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: prompt_versions prompt_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: prompt_versions prompt_versions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: response_cache response_cache_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response_cache
    ADD CONSTRAINT response_cache_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: roadmap_recommendations roadmap_recommendations_opportunity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roadmap_recommendations
    ADD CONSTRAINT roadmap_recommendations_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES public.evolution_opportunities(id) ON DELETE CASCADE;


--
-- Name: scheduling_appointment_types scheduling_appointment_types_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_appointment_types
    ADD CONSTRAINT scheduling_appointment_types_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_audit_log scheduling_audit_log_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_audit_log
    ADD CONSTRAINT scheduling_audit_log_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: scheduling_audit_log scheduling_audit_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_audit_log
    ADD CONSTRAINT scheduling_audit_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: scheduling_audit_log scheduling_audit_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_audit_log
    ADD CONSTRAINT scheduling_audit_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_booking_rules scheduling_booking_rules_appointment_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_booking_rules
    ADD CONSTRAINT scheduling_booking_rules_appointment_type_id_fkey FOREIGN KEY (appointment_type_id) REFERENCES public.scheduling_appointment_types(id) ON DELETE CASCADE;


--
-- Name: scheduling_booking_rules scheduling_booking_rules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_booking_rules
    ADD CONSTRAINT scheduling_booking_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_overrides scheduling_overrides_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_overrides
    ADD CONSTRAINT scheduling_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: scheduling_overrides scheduling_overrides_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_overrides
    ADD CONSTRAINT scheduling_overrides_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.scheduling_providers(id) ON DELETE CASCADE;


--
-- Name: scheduling_overrides scheduling_overrides_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_overrides
    ADD CONSTRAINT scheduling_overrides_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_provider_schedules scheduling_provider_schedules_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_provider_schedules
    ADD CONSTRAINT scheduling_provider_schedules_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.scheduling_providers(id) ON DELETE CASCADE;


--
-- Name: scheduling_provider_schedules scheduling_provider_schedules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_provider_schedules
    ADD CONSTRAINT scheduling_provider_schedules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_providers scheduling_providers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_providers
    ADD CONSTRAINT scheduling_providers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_recurring_series scheduling_recurring_series_appointment_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_recurring_series
    ADD CONSTRAINT scheduling_recurring_series_appointment_type_id_fkey FOREIGN KEY (appointment_type_id) REFERENCES public.scheduling_appointment_types(id) ON DELETE SET NULL;


--
-- Name: scheduling_recurring_series scheduling_recurring_series_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_recurring_series
    ADD CONSTRAINT scheduling_recurring_series_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: scheduling_recurring_series scheduling_recurring_series_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_recurring_series
    ADD CONSTRAINT scheduling_recurring_series_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.scheduling_providers(id) ON DELETE SET NULL;


--
-- Name: scheduling_recurring_series scheduling_recurring_series_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_recurring_series
    ADD CONSTRAINT scheduling_recurring_series_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.scheduling_resources(id) ON DELETE SET NULL;


--
-- Name: scheduling_recurring_series scheduling_recurring_series_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_recurring_series
    ADD CONSTRAINT scheduling_recurring_series_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_reminder_configs scheduling_reminder_configs_appointment_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_reminder_configs
    ADD CONSTRAINT scheduling_reminder_configs_appointment_type_id_fkey FOREIGN KEY (appointment_type_id) REFERENCES public.scheduling_appointment_types(id) ON DELETE CASCADE;


--
-- Name: scheduling_reminder_configs scheduling_reminder_configs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_reminder_configs
    ADD CONSTRAINT scheduling_reminder_configs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_reminder_log scheduling_reminder_log_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_reminder_log
    ADD CONSTRAINT scheduling_reminder_log_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: scheduling_reminder_log scheduling_reminder_log_reminder_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_reminder_log
    ADD CONSTRAINT scheduling_reminder_log_reminder_config_id_fkey FOREIGN KEY (reminder_config_id) REFERENCES public.scheduling_reminder_configs(id) ON DELETE SET NULL;


--
-- Name: scheduling_reminder_log scheduling_reminder_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_reminder_log
    ADD CONSTRAINT scheduling_reminder_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_resources scheduling_resources_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_resources
    ADD CONSTRAINT scheduling_resources_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_waitlist scheduling_waitlist_appointment_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_waitlist
    ADD CONSTRAINT scheduling_waitlist_appointment_type_id_fkey FOREIGN KEY (appointment_type_id) REFERENCES public.scheduling_appointment_types(id) ON DELETE SET NULL;


--
-- Name: scheduling_waitlist scheduling_waitlist_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_waitlist
    ADD CONSTRAINT scheduling_waitlist_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.scheduling_providers(id) ON DELETE SET NULL;


--
-- Name: scheduling_waitlist scheduling_waitlist_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_waitlist
    ADD CONSTRAINT scheduling_waitlist_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: scheduling_workflows scheduling_workflows_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_workflows
    ADD CONSTRAINT scheduling_workflows_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: simulation_results simulation_results_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_results
    ADD CONSTRAINT simulation_results_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.simulation_runs(id) ON DELETE CASCADE;


--
-- Name: simulation_results simulation_results_scenario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_results
    ADD CONSTRAINT simulation_results_scenario_id_fkey FOREIGN KEY (scenario_id) REFERENCES public.simulation_scenarios(id) ON DELETE CASCADE;


--
-- Name: simulation_results simulation_results_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_results
    ADD CONSTRAINT simulation_results_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: simulation_runs simulation_runs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_runs
    ADD CONSTRAINT simulation_runs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: simulation_runs simulation_runs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_runs
    ADD CONSTRAINT simulation_runs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: simulation_scenarios simulation_scenarios_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulation_scenarios
    ADD CONSTRAINT simulation_scenarios_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: sms_assignment_rules sms_assignment_rules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_assignment_rules
    ADD CONSTRAINT sms_assignment_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sms_auto_reply_rules sms_auto_reply_rules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_auto_reply_rules
    ADD CONSTRAINT sms_auto_reply_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sms_canned_responses sms_canned_responses_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_canned_responses
    ADD CONSTRAINT sms_canned_responses_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sms_consent_log sms_consent_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_consent_log
    ADD CONSTRAINT sms_consent_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sms_conversation_activity_log sms_conversation_activity_log_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_conversation_activity_log
    ADD CONSTRAINT sms_conversation_activity_log_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.sms_conversations(id) ON DELETE CASCADE;


--
-- Name: sms_conversation_activity_log sms_conversation_activity_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_conversation_activity_log
    ADD CONSTRAINT sms_conversation_activity_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sms_conversations sms_conversations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_conversations
    ADD CONSTRAINT sms_conversations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sms_internal_notes sms_internal_notes_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_internal_notes
    ADD CONSTRAINT sms_internal_notes_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.sms_conversations(id) ON DELETE CASCADE;


--
-- Name: sms_internal_notes sms_internal_notes_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_internal_notes
    ADD CONSTRAINT sms_internal_notes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: sms_logs sms_logs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_logs
    ADD CONSTRAINT sms_logs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: sms_messages sms_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.sms_conversations(id) ON DELETE CASCADE;


--
-- Name: sms_messages sms_messages_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: subscriptions subscriptions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: support_ticket_replies support_ticket_replies_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_replies
    ADD CONSTRAINT support_ticket_replies_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id) ON DELETE CASCADE;


--
-- Name: template_category_map template_category_map_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_category_map
    ADD CONSTRAINT template_category_map_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.template_categories(id) ON DELETE CASCADE;


--
-- Name: template_category_map template_category_map_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_category_map
    ADD CONSTRAINT template_category_map_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_registry(id) ON DELETE CASCADE;


--
-- Name: template_changelogs template_changelogs_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_changelogs
    ADD CONSTRAINT template_changelogs_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_registry(id) ON DELETE CASCADE;


--
-- Name: template_entitlements template_entitlements_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_entitlements
    ADD CONSTRAINT template_entitlements_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_registry(id) ON DELETE CASCADE;


--
-- Name: template_install_events template_install_events_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_install_events
    ADD CONSTRAINT template_install_events_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_registry(id) ON DELETE CASCADE;


--
-- Name: template_versions template_versions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_versions
    ADD CONSTRAINT template_versions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_registry(id) ON DELETE CASCADE;


--
-- Name: tenant_agent_installations tenant_agent_installations_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_agent_installations
    ADD CONSTRAINT tenant_agent_installations_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.template_registry(id) ON DELETE CASCADE;


--
-- Name: tenant_deletion_requests tenant_deletion_requests_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_deletion_requests
    ADD CONSTRAINT tenant_deletion_requests_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id);


--
-- Name: tenant_deletion_requests tenant_deletion_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_deletion_requests
    ADD CONSTRAINT tenant_deletion_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: tenant_deletion_requests tenant_deletion_requests_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_deletion_requests
    ADD CONSTRAINT tenant_deletion_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_notifications tenant_notifications_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_notifications
    ADD CONSTRAINT tenant_notifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_notifications tenant_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_notifications
    ADD CONSTRAINT tenant_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tenants tenants_encryption_reminder_paused_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_encryption_reminder_paused_by_user_id_fkey FOREIGN KEY (encryption_reminder_paused_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ticket_activity_log ticket_activity_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_activity_log
    ADD CONSTRAINT ticket_activity_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_activity_log ticket_activity_log_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_activity_log
    ADD CONSTRAINT ticket_activity_log_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_activity_log ticket_activity_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_activity_log
    ADD CONSTRAINT ticket_activity_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ticket_attachments ticket_attachments_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_attachments ticket_attachments_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_attachments ticket_attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ticket_categories ticket_categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_categories
    ADD CONSTRAINT ticket_categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.ticket_categories(id) ON DELETE SET NULL;


--
-- Name: ticket_categories ticket_categories_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_categories
    ADD CONSTRAINT ticket_categories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_custom_field_values ticket_custom_field_values_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_custom_field_values
    ADD CONSTRAINT ticket_custom_field_values_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.ticket_custom_fields(id) ON DELETE CASCADE;


--
-- Name: ticket_custom_field_values ticket_custom_field_values_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_custom_field_values
    ADD CONSTRAINT ticket_custom_field_values_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_custom_field_values ticket_custom_field_values_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_custom_field_values
    ADD CONSTRAINT ticket_custom_field_values_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_custom_fields ticket_custom_fields_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_custom_fields
    ADD CONSTRAINT ticket_custom_fields_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_links ticket_links_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_links
    ADD CONSTRAINT ticket_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ticket_links ticket_links_source_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_links
    ADD CONSTRAINT ticket_links_source_ticket_id_fkey FOREIGN KEY (source_ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_links ticket_links_target_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_links
    ADD CONSTRAINT ticket_links_target_ticket_id_fkey FOREIGN KEY (target_ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_links ticket_links_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_links
    ADD CONSTRAINT ticket_links_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_macros ticket_macros_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_macros
    ADD CONSTRAINT ticket_macros_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ticket_macros ticket_macros_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_macros
    ADD CONSTRAINT ticket_macros_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_notifications ticket_notifications_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notifications
    ADD CONSTRAINT ticket_notifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_notifications ticket_notifications_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notifications
    ADD CONSTRAINT ticket_notifications_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_notifications ticket_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notifications
    ADD CONSTRAINT ticket_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ticket_outbox ticket_outbox_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_outbox
    ADD CONSTRAINT ticket_outbox_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_queue_configs ticket_queue_configs_filter_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_queue_configs
    ADD CONSTRAINT ticket_queue_configs_filter_category_id_fkey FOREIGN KEY (filter_category_id) REFERENCES public.ticket_categories(id) ON DELETE SET NULL;


--
-- Name: ticket_queue_configs ticket_queue_configs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_queue_configs
    ADD CONSTRAINT ticket_queue_configs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_retention_policies ticket_retention_policies_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_retention_policies
    ADD CONSTRAINT ticket_retention_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_saved_views ticket_saved_views_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_saved_views
    ADD CONSTRAINT ticket_saved_views_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ticket_saved_views ticket_saved_views_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_saved_views
    ADD CONSTRAINT ticket_saved_views_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_sla_instances ticket_sla_instances_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_sla_instances
    ADD CONSTRAINT ticket_sla_instances_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.ticket_sla_policies(id) ON DELETE CASCADE;


--
-- Name: ticket_sla_instances ticket_sla_instances_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_sla_instances
    ADD CONSTRAINT ticket_sla_instances_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_sla_instances ticket_sla_instances_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_sla_instances
    ADD CONSTRAINT ticket_sla_instances_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_sla_policies ticket_sla_policies_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_sla_policies
    ADD CONSTRAINT ticket_sla_policies_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.ticket_categories(id) ON DELETE SET NULL;


--
-- Name: ticket_sla_policies ticket_sla_policies_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_sla_policies
    ADD CONSTRAINT ticket_sla_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_templates ticket_templates_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_templates
    ADD CONSTRAINT ticket_templates_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.ticket_categories(id) ON DELETE SET NULL;


--
-- Name: ticket_templates ticket_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_templates
    ADD CONSTRAINT ticket_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ticket_templates ticket_templates_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_templates
    ADD CONSTRAINT ticket_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_watchers ticket_watchers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_watchers
    ADD CONSTRAINT ticket_watchers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: ticket_watchers ticket_watchers_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_watchers
    ADD CONSTRAINT ticket_watchers_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_watchers ticket_watchers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_watchers
    ADD CONSTRAINT ticket_watchers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ticket_workflow_rules ticket_workflow_rules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_workflow_rules
    ADD CONSTRAINT ticket_workflow_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tickets tickets_assignee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_call_id_fkey FOREIGN KEY (call_id) REFERENCES public.call_sessions(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.ticket_categories(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_parent_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_parent_ticket_id_fkey FOREIGN KEY (parent_ticket_id) REFERENCES public.tickets(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tool_invocations tool_invocations_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_invocations
    ADD CONSTRAINT tool_invocations_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE;


--
-- Name: tool_invocations tool_invocations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_invocations
    ADD CONSTRAINT tool_invocations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tool_rate_limits tool_rate_limits_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_rate_limits
    ADD CONSTRAINT tool_rate_limits_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tooltip_dismissals tooltip_dismissals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tooltip_dismissals
    ADD CONSTRAINT tooltip_dismissals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: usage_metrics usage_metrics_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_metrics
    ADD CONSTRAINT usage_metrics_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: user_devices user_devices_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.dispatch_resources(id) ON DELETE CASCADE;


--
-- Name: user_devices user_devices_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: user_devices user_devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_invitations user_invitations_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invitations
    ADD CONSTRAINT user_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: user_invitations user_invitations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_invitations
    ADD CONSTRAINT user_invitations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: user_notification_preferences user_notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_preferences
    ADD CONSTRAINT user_notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_roles user_tenant_roles_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_tenant_roles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);


--
-- Name: user_roles user_tenant_roles_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_tenant_roles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: user_roles user_tenant_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_tenant_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: verified_caller_alert_recipients verified_caller_alert_recipients_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_caller_alert_recipients
    ADD CONSTRAINT verified_caller_alert_recipients_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: verified_caller_alert_recipients verified_caller_alert_recipients_triggered_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_caller_alert_recipients
    ADD CONSTRAINT verified_caller_alert_recipients_triggered_by_user_id_fkey FOREIGN KEY (triggered_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: verified_caller_alert_recipients verified_caller_alert_recipients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_caller_alert_recipients
    ADD CONSTRAINT verified_caller_alert_recipients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: verified_caller_ids verified_caller_ids_rotated_to_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_caller_ids
    ADD CONSTRAINT verified_caller_ids_rotated_to_id_fkey FOREIGN KEY (rotated_to_id) REFERENCES public.verified_caller_ids(id) ON DELETE SET NULL;


--
-- Name: verified_caller_ids verified_caller_ids_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_caller_ids
    ADD CONSTRAINT verified_caller_ids_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: vertical_expansion_scores vertical_expansion_scores_opportunity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vertical_expansion_scores
    ADD CONSTRAINT vertical_expansion_scores_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES public.evolution_opportunities(id) ON DELETE SET NULL;


--
-- Name: webhook_events webhook_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: website_agent_conversations website_agent_conversations_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_agent_conversations
    ADD CONSTRAINT website_agent_conversations_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.website_leads(id);


--
-- Name: weekly_reports weekly_reports_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_reports
    ADD CONSTRAINT weekly_reports_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: widget_configs widget_configs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.widget_configs
    ADD CONSTRAINT widget_configs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: widget_configs widget_configs_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.widget_configs
    ADD CONSTRAINT widget_configs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: widget_tokens widget_tokens_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.widget_tokens
    ADD CONSTRAINT widget_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workflow_executions workflow_executions_call_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_executions
    ADD CONSTRAINT workflow_executions_call_session_id_fkey FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE CASCADE;


--
-- Name: workflow_executions workflow_executions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_executions
    ADD CONSTRAINT workflow_executions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workflow_performance_metrics workflow_performance_metrics_aggregation_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_performance_metrics
    ADD CONSTRAINT workflow_performance_metrics_aggregation_run_id_fkey FOREIGN KEY (aggregation_run_id) REFERENCES public.gin_aggregation_runs(id) ON DELETE SET NULL;


--
-- Name: workflow_steps workflow_steps_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_steps
    ADD CONSTRAINT workflow_steps_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workflow_steps workflow_steps_workflow_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_steps
    ADD CONSTRAINT workflow_steps_workflow_execution_id_fkey FOREIGN KEY (workflow_execution_id) REFERENCES public.workflow_executions(id) ON DELETE CASCADE;


--
-- Name: workflows workflows_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workforce_members workforce_members_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_members
    ADD CONSTRAINT workforce_members_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: workforce_members workforce_members_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_members
    ADD CONSTRAINT workforce_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.workforce_teams(id) ON DELETE CASCADE;


--
-- Name: workforce_members workforce_members_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_members
    ADD CONSTRAINT workforce_members_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workforce_optimization_insights workforce_optimization_insights_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_optimization_insights
    ADD CONSTRAINT workforce_optimization_insights_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.workforce_teams(id) ON DELETE CASCADE;


--
-- Name: workforce_optimization_insights workforce_optimization_insights_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_optimization_insights
    ADD CONSTRAINT workforce_optimization_insights_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workforce_outbound_tasks workforce_outbound_tasks_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_outbound_tasks
    ADD CONSTRAINT workforce_outbound_tasks_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.workforce_teams(id) ON DELETE CASCADE;


--
-- Name: workforce_outbound_tasks workforce_outbound_tasks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_outbound_tasks
    ADD CONSTRAINT workforce_outbound_tasks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workforce_revenue_metrics workforce_revenue_metrics_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_revenue_metrics
    ADD CONSTRAINT workforce_revenue_metrics_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.workforce_teams(id) ON DELETE CASCADE;


--
-- Name: workforce_revenue_metrics workforce_revenue_metrics_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_revenue_metrics
    ADD CONSTRAINT workforce_revenue_metrics_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workforce_routing_history workforce_routing_history_routing_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_routing_history
    ADD CONSTRAINT workforce_routing_history_routing_rule_id_fkey FOREIGN KEY (routing_rule_id) REFERENCES public.workforce_routing_rules(id) ON DELETE SET NULL;


--
-- Name: workforce_routing_history workforce_routing_history_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_routing_history
    ADD CONSTRAINT workforce_routing_history_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.workforce_teams(id) ON DELETE CASCADE;


--
-- Name: workforce_routing_history workforce_routing_history_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_routing_history
    ADD CONSTRAINT workforce_routing_history_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workforce_routing_rules workforce_routing_rules_fallback_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_routing_rules
    ADD CONSTRAINT workforce_routing_rules_fallback_member_id_fkey FOREIGN KEY (fallback_member_id) REFERENCES public.workforce_members(id) ON DELETE SET NULL;


--
-- Name: workforce_routing_rules workforce_routing_rules_target_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_routing_rules
    ADD CONSTRAINT workforce_routing_rules_target_member_id_fkey FOREIGN KEY (target_member_id) REFERENCES public.workforce_members(id) ON DELETE CASCADE;


--
-- Name: workforce_routing_rules workforce_routing_rules_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_routing_rules
    ADD CONSTRAINT workforce_routing_rules_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.workforce_teams(id) ON DELETE CASCADE;


--
-- Name: workforce_routing_rules workforce_routing_rules_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_routing_rules
    ADD CONSTRAINT workforce_routing_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workforce_teams workforce_teams_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_teams
    ADD CONSTRAINT workforce_teams_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: workforce_templates workforce_templates_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_templates
    ADD CONSTRAINT workforce_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: active_call_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.active_call_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_prompt_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_prompt_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_prompts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_prompts ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_templates agent_templates_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_templates_tenant_isolation ON public.agent_templates USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: agent_tools; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_tools ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_versions agent_versions_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_versions_tenant_isolation ON public.agent_versions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: agents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_insights; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_insights ENABLE ROW LEVEL SECURITY;

--
-- Name: analytics_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.analytics_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: answering_service_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.answering_service_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: appointment_scheduling_dispatch; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.appointment_scheduling_dispatch ENABLE ROW LEVEL SECURITY;

--
-- Name: assistant_actions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assistant_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: assistant_actions assistant_actions_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assistant_actions_tenant_isolation ON public.assistant_actions USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: assistant_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assistant_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: assistant_sessions assistant_sessions_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assistant_sessions_tenant_isolation ON public.assistant_sessions USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: autopilot_actions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.autopilot_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: autopilot_approvals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.autopilot_approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: autopilot_impact_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.autopilot_impact_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: autopilot_insights; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.autopilot_insights ENABLE ROW LEVEL SECURITY;

--
-- Name: autopilot_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.autopilot_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: autopilot_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.autopilot_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: autopilot_recommendations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.autopilot_recommendations ENABLE ROW LEVEL SECURITY;

--
-- Name: autopilot_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.autopilot_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_recommendation_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_recommendation_events ENABLE ROW LEVEL SECURITY;

--
-- Name: bookings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

--
-- Name: call_conversion_stages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_conversion_stages ENABLE ROW LEVEL SECURITY;

--
-- Name: call_conversion_stages call_conversion_stages_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY call_conversion_stages_tenant_isolation ON public.call_conversion_stages USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: call_csat_responses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_csat_responses ENABLE ROW LEVEL SECURITY;

--
-- Name: call_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_events ENABLE ROW LEVEL SECURITY;

--
-- Name: call_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: call_quality_scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_quality_scores ENABLE ROW LEVEL SECURITY;

--
-- Name: call_saved_view_pins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_saved_view_pins ENABLE ROW LEVEL SECURITY;

--
-- Name: call_saved_views; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_saved_views ENABLE ROW LEVEL SECURITY;

--
-- Name: call_sentiment_scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_sentiment_scores ENABLE ROW LEVEL SECURITY;

--
-- Name: call_sentiment_scores call_sentiment_scores_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY call_sentiment_scores_tenant_isolation ON public.call_sentiment_scores USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: call_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: call_topic_classifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_topic_classifications ENABLE ROW LEVEL SECURITY;

--
-- Name: call_topic_classifications call_topic_classifications_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY call_topic_classifications_tenant_isolation ON public.call_topic_classifications USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: call_transcripts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.call_transcripts ENABLE ROW LEVEL SECURITY;

--
-- Name: callback_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.callback_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_contact_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_contact_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: connector_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.connector_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_costs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_costs ENABLE ROW LEVEL SECURITY;

--
-- Name: cost_budget_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cost_budget_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_caller_identities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_caller_identities ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_openai_costs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_openai_costs ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_org_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_org_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_reconciliation; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_reconciliation ENABLE ROW LEVEL SECURITY;

--
-- Name: demo_agents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.demo_agents ENABLE ROW LEVEL SECURITY;

--
-- Name: demo_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.demo_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: digital_twin_models; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.digital_twin_models ENABLE ROW LEVEL SECURITY;

--
-- Name: digital_twin_models digital_twin_models_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY digital_twin_models_tenant_isolation ON public.digital_twin_models USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: digital_twin_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.digital_twin_results ENABLE ROW LEVEL SECURITY;

--
-- Name: digital_twin_results digital_twin_results_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY digital_twin_results_tenant_isolation ON public.digital_twin_results USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: digital_twin_scenarios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.digital_twin_scenarios ENABLE ROW LEVEL SECURITY;

--
-- Name: digital_twin_scenarios digital_twin_scenarios_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY digital_twin_scenarios_tenant_isolation ON public.digital_twin_scenarios USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) OR ((tenant_id)::text = '__system__'::text)));


--
-- Name: digital_twin_simulation_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.digital_twin_simulation_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_assignment_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_assignment_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_job_attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_job_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_job_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_job_events ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_job_exceptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_job_exceptions ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_notification_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_notification_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_notifications_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_notifications_log ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_resource_location_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_resource_location_history ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_resource_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_resource_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_resource_pairing_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_resource_pairing_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_resource_skills; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_resource_skills ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_resources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_resources ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_route_export_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_route_export_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_skill_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_skill_types ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_territories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispatch_territories ENABLE ROW LEVEL SECURITY;

--
-- Name: dnc_list; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dnc_list ENABLE ROW LEVEL SECURITY;

--
-- Name: dnc_list dnc_list_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dnc_list_tenant_isolation ON public.dnc_list USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: digital_twin_simulation_runs dt_simulation_runs_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dt_simulation_runs_tenant_isolation ON public.digital_twin_simulation_runs USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: encrypted_fields; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.encrypted_fields ENABLE ROW LEVEL SECURITY;

--
-- Name: encryption_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.encryption_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: error_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: escalation_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.escalation_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: execution_traces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.execution_traces ENABLE ROW LEVEL SECURITY;

--
-- Name: forecast_models; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.forecast_models ENABLE ROW LEVEL SECURITY;

--
-- Name: forecast_models forecast_models_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY forecast_models_tenant_isolation ON public.forecast_models USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: gdpr_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gdpr_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: handoff_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.handoff_states ENABLE ROW LEVEL SECURITY;

--
-- Name: improvement_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.improvement_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: ingest_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ingest_events ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_event_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_event_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

--
-- Name: knowledge_articles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.knowledge_articles ENABLE ROW LEVEL SECURITY;

--
-- Name: knowledge_chunks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;

--
-- Name: knowledge_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: legacy_agent_prompt_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.legacy_agent_prompt_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: model_routing_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.model_routing_log ENABLE ROW LEVEL SECURITY;

--
-- Name: network_recommendations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.network_recommendations ENABLE ROW LEVEL SECURITY;

--
-- Name: number_routing; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.number_routing ENABLE ROW LEVEL SECURITY;

--
-- Name: outbox_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outbox_events ENABLE ROW LEVEL SECURITY;

--
-- Name: outbox_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outbox_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: dispatch_resource_pairing_codes pairing_codes_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pairing_codes_tenant_isolation ON public.dispatch_resource_pairing_codes USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: password_reset_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: phone_endpoints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.phone_endpoints ENABLE ROW LEVEL SECURITY;

--
-- Name: phone_numbers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.phone_numbers ENABLE ROW LEVEL SECURITY;

--
-- Name: prompt_improvement_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prompt_improvement_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: prompt_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prompt_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: response_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.response_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: escalation_tasks rls_escalation_tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_escalation_tasks ON public.escalation_tasks USING ((tenant_id = current_setting('app.tenant_id'::text, true)));


--
-- Name: tool_failure_events rls_tool_failure_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_tool_failure_events ON public.tool_failure_events USING ((tenant_id = current_setting('app.tenant_id'::text, true)));


--
-- Name: scheduling_appointment_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_appointment_types ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_booking_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_booking_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_provider_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_provider_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_recurring_series; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_recurring_series ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_reminder_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_reminder_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_reminder_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_reminder_log ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_resources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_resources ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_waitlist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_waitlist ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduling_workflows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_workflows ENABLE ROW LEVEL SECURITY;

--
-- Name: simulation_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.simulation_results ENABLE ROW LEVEL SECURITY;

--
-- Name: simulation_results simulation_results_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY simulation_results_tenant_isolation ON public.simulation_results USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: simulation_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.simulation_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: simulation_runs simulation_runs_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY simulation_runs_tenant_isolation ON public.simulation_runs USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: simulation_scenarios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.simulation_scenarios ENABLE ROW LEVEL SECURITY;

--
-- Name: simulation_scenarios simulation_scenarios_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY simulation_scenarios_tenant_isolation ON public.simulation_scenarios USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: sms_conversation_activity_log sms_activity_log_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_activity_log_tenant_policy ON public.sms_conversation_activity_log USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: sms_conversation_activity_log sms_activity_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_activity_tenant_policy ON public.sms_conversation_activity_log USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: sms_assignment_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_assignment_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_assignment_rules sms_assignment_rules_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_assignment_rules_tenant_policy ON public.sms_assignment_rules USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: sms_auto_reply_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_auto_reply_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_auto_reply_rules sms_auto_reply_rules_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_auto_reply_rules_tenant_policy ON public.sms_auto_reply_rules USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: sms_canned_responses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_canned_responses ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_canned_responses sms_canned_responses_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_canned_responses_tenant_policy ON public.sms_canned_responses USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: sms_consent_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_consent_log ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_consent_log sms_consent_log_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_consent_log_tenant_policy ON public.sms_consent_log USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: sms_conversation_activity_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_conversation_activity_log ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_conversations sms_conversations_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_conversations_tenant_policy ON public.sms_conversations USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: sms_internal_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_internal_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_internal_notes sms_internal_notes_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_internal_notes_tenant_policy ON public.sms_internal_notes USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: sms_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_messages sms_messages_tenant_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_messages_tenant_policy ON public.sms_messages USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: template_install_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.template_install_events ENABLE ROW LEVEL SECURITY;

--
-- Name: tenant_agent_installations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenant_agent_installations ENABLE ROW LEVEL SECURITY;

--
-- Name: active_call_sessions tenant_isolation_active_call_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_active_call_sessions ON public.active_call_sessions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: agent_prompt_versions tenant_isolation_agent_prompt_versions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_agent_prompt_versions ON public.agent_prompt_versions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: legacy_agent_prompt_versions tenant_isolation_agent_prompt_versions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_agent_prompt_versions ON public.legacy_agent_prompt_versions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: agent_prompts tenant_isolation_agent_prompts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_agent_prompts ON public.agent_prompts USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: agent_tools tenant_isolation_agent_tools; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_agent_tools ON public.agent_tools USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: agents tenant_isolation_agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_agents ON public.agents USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ai_insights tenant_isolation_ai_insights; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ai_insights ON public.ai_insights USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: analytics_metrics tenant_isolation_analytics_metrics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_analytics_metrics ON public.analytics_metrics USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: answering_service_logs tenant_isolation_answering_service_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_answering_service_logs ON public.answering_service_logs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: api_keys tenant_isolation_api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_api_keys ON public.api_keys USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: appointment_scheduling_dispatch tenant_isolation_appt_sched_dispatch; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_appt_sched_dispatch ON public.appointment_scheduling_dispatch USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: audit_logs tenant_isolation_audit_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_audit_logs ON public.audit_logs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: autopilot_actions tenant_isolation_autopilot_actions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_autopilot_actions ON public.autopilot_actions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: autopilot_approvals tenant_isolation_autopilot_approvals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_autopilot_approvals ON public.autopilot_approvals USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: autopilot_impact_reports tenant_isolation_autopilot_impact_reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_autopilot_impact_reports ON public.autopilot_impact_reports USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: autopilot_insights tenant_isolation_autopilot_insights; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_autopilot_insights ON public.autopilot_insights USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: autopilot_notifications tenant_isolation_autopilot_notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_autopilot_notifications ON public.autopilot_notifications USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: autopilot_policies tenant_isolation_autopilot_policies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_autopilot_policies ON public.autopilot_policies USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: autopilot_recommendations tenant_isolation_autopilot_recommendations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_autopilot_recommendations ON public.autopilot_recommendations USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: autopilot_runs tenant_isolation_autopilot_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_autopilot_runs ON public.autopilot_runs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: billing_events tenant_isolation_billing_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_billing_events ON public.billing_events USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: billing_recommendation_events tenant_isolation_billing_recommendation_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_billing_recommendation_events ON public.billing_recommendation_events USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: bookings tenant_isolation_bookings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_bookings ON public.bookings USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: call_csat_responses tenant_isolation_call_csat_responses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_call_csat_responses ON public.call_csat_responses USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: call_events tenant_isolation_call_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_call_events ON public.call_events USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: call_logs tenant_isolation_call_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_call_logs ON public.call_logs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: call_quality_scores tenant_isolation_call_quality_scores; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_call_quality_scores ON public.call_quality_scores USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: call_saved_view_pins tenant_isolation_call_saved_view_pins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_call_saved_view_pins ON public.call_saved_view_pins USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: call_saved_views tenant_isolation_call_saved_views; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_call_saved_views ON public.call_saved_views USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: call_sessions tenant_isolation_call_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_call_sessions ON public.call_sessions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: call_transcripts tenant_isolation_call_transcripts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_call_transcripts ON public.call_transcripts USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: callback_queue tenant_isolation_callback_queue; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_callback_queue ON public.callback_queue USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: campaign_contact_attempts tenant_isolation_campaign_contact_attempts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_campaign_contact_attempts ON public.campaign_contact_attempts USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: campaign_contacts tenant_isolation_campaign_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_campaign_contacts ON public.campaign_contacts USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: campaigns tenant_isolation_campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_campaigns ON public.campaigns USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: connector_configs tenant_isolation_connector_configs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_connector_configs ON public.connector_configs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: conversation_costs tenant_isolation_conversation_costs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_conversation_costs ON public.conversation_costs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: conversation_costs tenant_isolation_conversation_costs_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_conversation_costs_insert ON public.conversation_costs FOR INSERT WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: cost_budget_settings tenant_isolation_cost_budget_settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_cost_budget_settings ON public.cost_budget_settings USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: cost_budget_settings tenant_isolation_cost_budget_settings_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_cost_budget_settings_insert ON public.cost_budget_settings FOR INSERT WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: crm_caller_identities tenant_isolation_crm_caller_identities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_crm_caller_identities ON public.crm_caller_identities USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: daily_openai_costs tenant_isolation_daily_openai_costs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_daily_openai_costs ON public.daily_openai_costs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: daily_org_usage tenant_isolation_daily_org_usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_daily_org_usage ON public.daily_org_usage USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: daily_reconciliation tenant_isolation_daily_reconciliation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_daily_reconciliation ON public.daily_reconciliation USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: demo_agents tenant_isolation_demo_agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_demo_agents ON public.demo_agents USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: demo_sessions tenant_isolation_demo_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_demo_sessions ON public.demo_sessions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_assignment_rules tenant_isolation_dispatch_assignment_rules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_assignment_rules ON public.dispatch_assignment_rules USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_job_attachments tenant_isolation_dispatch_job_attachments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_job_attachments ON public.dispatch_job_attachments USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_job_events tenant_isolation_dispatch_job_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_job_events ON public.dispatch_job_events USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_job_exceptions tenant_isolation_dispatch_job_exceptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_job_exceptions ON public.dispatch_job_exceptions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_jobs tenant_isolation_dispatch_jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_jobs ON public.dispatch_jobs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_notification_templates tenant_isolation_dispatch_notification_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_notification_templates ON public.dispatch_notification_templates USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_notifications_log tenant_isolation_dispatch_notifications_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_notifications_log ON public.dispatch_notifications_log USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_resource_location_history tenant_isolation_dispatch_resource_location_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_resource_location_history ON public.dispatch_resource_location_history USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_resource_locations tenant_isolation_dispatch_resource_locations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_resource_locations ON public.dispatch_resource_locations USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_resource_skills tenant_isolation_dispatch_resource_skills; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_resource_skills ON public.dispatch_resource_skills USING (((resource_id)::text IN ( SELECT dispatch_resources.id
   FROM public.dispatch_resources
  WHERE ((dispatch_resources.tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text))));


--
-- Name: dispatch_resources tenant_isolation_dispatch_resources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_resources ON public.dispatch_resources USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_route_export_jobs tenant_isolation_dispatch_route_export_jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_route_export_jobs ON public.dispatch_route_export_jobs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_skill_types tenant_isolation_dispatch_skill_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_skill_types ON public.dispatch_skill_types USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: dispatch_territories tenant_isolation_dispatch_territories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_dispatch_territories ON public.dispatch_territories USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: encrypted_fields tenant_isolation_encrypted_fields; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_encrypted_fields ON public.encrypted_fields USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: encryption_keys tenant_isolation_encryption_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_encryption_keys ON public.encryption_keys USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: error_logs tenant_isolation_error_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_error_logs ON public.error_logs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: execution_traces tenant_isolation_execution_traces; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_execution_traces ON public.execution_traces USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: gdpr_requests tenant_isolation_gdpr_requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_gdpr_requests ON public.gdpr_requests USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: handoff_states tenant_isolation_handoff_states; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_handoff_states ON public.handoff_states USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: improvement_metrics tenant_isolation_improvement_metrics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_improvement_metrics ON public.improvement_metrics USING (((tenant_id)::text = current_setting('app.tenant_id'::text)));


--
-- Name: ingest_events tenant_isolation_ingest_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ingest_events ON public.ingest_events USING (((org_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((org_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: integration_event_logs tenant_isolation_integration_event_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_integration_event_logs ON public.integration_event_logs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: integrations tenant_isolation_integrations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_integrations ON public.integrations USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: knowledge_articles tenant_isolation_knowledge_articles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_knowledge_articles ON public.knowledge_articles USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: knowledge_articles tenant_isolation_knowledge_articles_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_knowledge_articles_insert ON public.knowledge_articles FOR INSERT WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: knowledge_chunks tenant_isolation_knowledge_chunks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_knowledge_chunks ON public.knowledge_chunks USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: knowledge_chunks tenant_isolation_knowledge_chunks_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_knowledge_chunks_insert ON public.knowledge_chunks FOR INSERT WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: knowledge_documents tenant_isolation_knowledge_documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_knowledge_documents ON public.knowledge_documents USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: knowledge_documents tenant_isolation_knowledge_documents_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_knowledge_documents_insert ON public.knowledge_documents FOR INSERT WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: model_routing_log tenant_isolation_model_routing_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_model_routing_log ON public.model_routing_log USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: model_routing_log tenant_isolation_model_routing_log_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_model_routing_log_insert ON public.model_routing_log FOR INSERT WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: network_recommendations tenant_isolation_network_recommendations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_network_recommendations ON public.network_recommendations USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: number_routing tenant_isolation_number_routing; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_number_routing ON public.number_routing USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: outbox_events tenant_isolation_outbox_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_outbox_events ON public.outbox_events USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: outbox_messages tenant_isolation_outbox_messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_outbox_messages ON public.outbox_messages USING ((((tenant_id)::text = current_setting('app.tenant_id'::text, true)) OR (CURRENT_USER = ANY (ARRAY['service_role'::name, 'postgres'::name])))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: password_reset_tokens tenant_isolation_password_reset_tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_password_reset_tokens ON public.password_reset_tokens USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: phone_endpoints tenant_isolation_phone_endpoints; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_phone_endpoints ON public.phone_endpoints USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: phone_numbers tenant_isolation_phone_numbers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_phone_numbers ON public.phone_numbers USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: prompt_improvement_suggestions tenant_isolation_prompt_improvement_suggestions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_prompt_improvement_suggestions ON public.prompt_improvement_suggestions USING (((tenant_id)::text = current_setting('app.tenant_id'::text)));


--
-- Name: prompt_versions tenant_isolation_prompt_versions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_prompt_versions ON public.prompt_versions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: response_cache tenant_isolation_response_cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_response_cache ON public.response_cache USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: response_cache tenant_isolation_response_cache_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_response_cache_insert ON public.response_cache FOR INSERT WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_appointment_types tenant_isolation_sched_appt_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_appt_types ON public.scheduling_appointment_types USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_audit_log tenant_isolation_sched_audit; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_audit ON public.scheduling_audit_log USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_overrides tenant_isolation_sched_overrides; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_overrides ON public.scheduling_overrides USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_provider_schedules tenant_isolation_sched_prov_sched; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_prov_sched ON public.scheduling_provider_schedules USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_providers tenant_isolation_sched_providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_providers ON public.scheduling_providers USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_recurring_series tenant_isolation_sched_recurring; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_recurring ON public.scheduling_recurring_series USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_reminder_configs tenant_isolation_sched_reminder_configs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_reminder_configs ON public.scheduling_reminder_configs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_reminder_log tenant_isolation_sched_reminder_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_reminder_log ON public.scheduling_reminder_log USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_resources tenant_isolation_sched_resources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_resources ON public.scheduling_resources USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_booking_rules tenant_isolation_sched_rules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_rules ON public.scheduling_booking_rules USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_waitlist tenant_isolation_sched_waitlist; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sched_waitlist ON public.scheduling_waitlist USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: scheduling_workflows tenant_isolation_scheduling_workflows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_scheduling_workflows ON public.scheduling_workflows USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: sms_logs tenant_isolation_sms_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_sms_logs ON public.sms_logs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: subscriptions tenant_isolation_subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_subscriptions ON public.subscriptions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: template_install_events tenant_isolation_template_install_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_template_install_events ON public.template_install_events USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: tenant_agent_installations tenant_isolation_tenant_agent_installations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_tenant_agent_installations ON public.tenant_agent_installations USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: tenants tenant_isolation_tenants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_tenants ON public.tenants USING (((id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_activity_log tenant_isolation_ticket_activity_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_activity_log ON public.ticket_activity_log USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_attachments tenant_isolation_ticket_attachments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_attachments ON public.ticket_attachments USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_categories tenant_isolation_ticket_categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_categories ON public.ticket_categories USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_custom_field_values tenant_isolation_ticket_custom_field_values; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_custom_field_values ON public.ticket_custom_field_values USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_custom_fields tenant_isolation_ticket_custom_fields; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_custom_fields ON public.ticket_custom_fields USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_links tenant_isolation_ticket_links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_links ON public.ticket_links USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_macros tenant_isolation_ticket_macros; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_macros ON public.ticket_macros USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_notifications tenant_isolation_ticket_notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_notifications ON public.ticket_notifications USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_outbox tenant_isolation_ticket_outbox; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_outbox ON public.ticket_outbox USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_queue_configs tenant_isolation_ticket_queue_configs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_queue_configs ON public.ticket_queue_configs USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_retention_policies tenant_isolation_ticket_retention_policies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_retention_policies ON public.ticket_retention_policies USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_saved_views tenant_isolation_ticket_saved_views; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_saved_views ON public.ticket_saved_views USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_sla_instances tenant_isolation_ticket_sla_instances; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_sla_instances ON public.ticket_sla_instances USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_sla_policies tenant_isolation_ticket_sla_policies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_sla_policies ON public.ticket_sla_policies USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_templates tenant_isolation_ticket_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_templates ON public.ticket_templates USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_watchers tenant_isolation_ticket_watchers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_watchers ON public.ticket_watchers USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: ticket_workflow_rules tenant_isolation_ticket_workflow_rules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_ticket_workflow_rules ON public.ticket_workflow_rules USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: tickets tenant_isolation_tickets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_tickets ON public.tickets USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: tool_invocations tenant_isolation_tool_invocations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_tool_invocations ON public.tool_invocations USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: tool_rate_limits tenant_isolation_tool_rate_limits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_tool_rate_limits ON public.tool_rate_limits USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: usage_metrics tenant_isolation_usage_metrics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_usage_metrics ON public.usage_metrics USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: user_invitations tenant_isolation_user_invitations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_user_invitations ON public.user_invitations USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: user_roles tenant_isolation_user_roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_user_roles ON public.user_roles USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: users tenant_isolation_users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_users ON public.users USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: verified_caller_ids tenant_isolation_verified_caller_ids; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_verified_caller_ids ON public.verified_caller_ids USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: webhook_events tenant_isolation_webhook_events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_webhook_events ON public.webhook_events USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: weekly_reports tenant_isolation_weekly_reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_weekly_reports ON public.weekly_reports USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: workflow_executions tenant_isolation_workflow_executions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_workflow_executions ON public.workflow_executions USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: workflow_steps tenant_isolation_workflow_steps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_workflow_steps ON public.workflow_steps USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: tenants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_activity_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_activity_log ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_custom_field_values; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_custom_field_values ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_custom_fields; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_custom_fields ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_links ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_macros; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_macros ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_queue_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_queue_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_retention_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_retention_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_saved_views; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_saved_views ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_sla_instances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_sla_instances ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_sla_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_sla_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_watchers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_watchers ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_workflow_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_workflow_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: tool_failure_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tool_failure_events ENABLE ROW LEVEL SECURITY;

--
-- Name: tool_invocations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tool_invocations ENABLE ROW LEVEL SECURITY;

--
-- Name: tool_rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tool_rate_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usage_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: user_invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: verified_caller_ids; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.verified_caller_ids ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

--
-- Name: weekly_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.weekly_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_optimization_insights wf_opt_insights_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wf_opt_insights_tenant_isolation ON public.workforce_optimization_insights USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: workforce_outbound_tasks wf_outbound_tasks_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wf_outbound_tasks_tenant_isolation ON public.workforce_outbound_tasks USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: workforce_revenue_metrics wf_revenue_metrics_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY wf_revenue_metrics_tenant_isolation ON public.workforce_revenue_metrics USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: workflow_executions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_executions ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_steps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_steps ENABLE ROW LEVEL SECURITY;

--
-- Name: workflows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;

--
-- Name: workflows workflows_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workflows_tenant_isolation ON public.workflows USING (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text)) WITH CHECK (((tenant_id)::text = ((current_setting('app.tenant_id'::text, true))::character varying)::text));


--
-- Name: workforce_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workforce_members ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_members workforce_members_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workforce_members_tenant_isolation ON public.workforce_members USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: workforce_optimization_insights; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workforce_optimization_insights ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_outbound_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workforce_outbound_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_revenue_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workforce_revenue_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_routing_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workforce_routing_history ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_routing_history workforce_routing_history_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workforce_routing_history_tenant_isolation ON public.workforce_routing_history USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: workforce_routing_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workforce_routing_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_routing_rules workforce_routing_rules_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workforce_routing_rules_tenant_isolation ON public.workforce_routing_rules USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: workforce_teams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workforce_teams ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_teams workforce_teams_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workforce_teams_tenant_isolation ON public.workforce_teams USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- Name: workforce_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workforce_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: workforce_templates workforce_templates_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workforce_templates_tenant_isolation ON public.workforce_templates USING (((tenant_id IS NULL) OR ((tenant_id)::text = current_setting('app.tenant_id'::text, true))));


--
-- PostgreSQL database dump complete
--

\unrestrict G2qAv94C1arSpmbcqIQPrE3mTUkJSINKruFIWbV70IPXzGYyKce1piz3RKiHuLr

