export const TENANT_DATA_CONTROL_CATALOG_VERSION = '3.0.0';

export type TenantDataClass =
  | 'tenant_data'
  | 'audio'
  | 'transcript'
  | 'pii'
  | 'phi'
  | 'tool'
  | 'outcome'
  | 'knowledge'
  | 'log'
  | 'evidence';

export type TenantDeletionDisposition =
  | 'cascade'
  | 'explicit_delete'
  | 'controlled_audit_delete'
  | 'preserve_evidence';

export interface TenantDataControlEntry {
  table: string;
  tenantColumn: 'tenant_id';
  dataClasses: readonly TenantDataClass[];
  deletionDisposition: TenantDeletionDisposition;
}

// Generated from the ordered migration history and reviewed under GTM-012.
// The equality regression test intentionally makes every future tenant table
// an explicit change-control decision instead of silently trusting a new FK.
const TENANT_TABLE_NAMES = [
  'activation_events',
  'active_call_sessions',
  'agent_prompt_versions',
  'agent_prompts',
  'agent_templates',
  'agent_tools',
  'agent_versions',
  'agents',
  'ai_insights',
  'analytics_metrics',
  'answering_service_logs',
  'api_keys',
  'appointment_scheduling_dispatch',
  'assistant_actions',
  'assistant_sessions',
  'audit_logs',
  'autopilot_actions',
  'autopilot_approvals',
  'autopilot_impact_reports',
  'autopilot_insights',
  'autopilot_notifications',
  'autopilot_policies',
  'autopilot_recommendations',
  'autopilot_runs',
  'billing_events',
  'billing_recommendation_events',
  'billing_reconciliation',
  'bookings',
  'call_conversion_stages',
  'call_csat_responses',
  'call_events',
  'call_logs',
  'call_quality_scores',
  'call_saved_view_pins',
  'call_saved_views',
  'call_sentiment_scores',
  'call_sessions',
  'call_topic_classifications',
  'call_transcripts',
  'callback_queue',
  'campaign_contact_attempts',
  'campaign_contacts',
  'campaigns',
  'case_studies',
  'connector_alert_mutes',
  'connector_alert_recipients',
  'connector_alert_settings',
  'connector_configs',
  'connector_stale_alerts',
  'conversation_costs',
  'cost_budget_settings',
  'crm_caller_identities',
  'crm_stale_cache_scrubs',
  'daily_openai_costs',
  'daily_org_usage',
  'daily_reconciliation',
  'demo_agents',
  'demo_sessions',
  'digital_twin_models',
  'digital_twin_results',
  'digital_twin_scenarios',
  'digital_twin_simulation_runs',
  'dispatch_assignment_rules',
  'dispatch_job_attachments',
  'dispatch_job_events',
  'dispatch_job_exceptions',
  'dispatch_jobs',
  'dispatch_notification_templates',
  'dispatch_notifications_log',
  'dispatch_resource_location_history',
  'dispatch_resource_locations',
  'dispatch_resource_pairing_codes',
  'dispatch_resources',
  'dispatch_route_export_jobs',
  'dispatch_skill_types',
  'dispatch_territories',
  'distributed_locks',
  'dnc_list',
  'encrypted_fields',
  'encryption_keys',
  'error_logs',
  'escalation_tasks',
  'evolution_signals',
  'execution_traces',
  'forecast_models',
  'gdpr_requests',
  'gin_policy_acceptance_records',
  'handoff_states',
  'healthcare_control_evidence',
  'healthcare_activation_readiness',
  'healthcare_deployment_approvals',
  'improvement_metrics',
  'integration_event_logs',
  'integrations',
  'knowledge_articles',
  'knowledge_chunks',
  'knowledge_documents',
  'legacy_agent_prompt_versions',
  'marketplace_purchases',
  'marketplace_reviews',
  'milestone_thresholds',
  'model_routing_log',
  'network_recommendations',
  'number_routing',
  'operations_alerts',
  'outbox_events',
  'outbox_messages',
  'password_reset_tokens',
  'phone_endpoints',
  'phone_numbers',
  'prompt_improvement_suggestions',
  'prompt_versions',
  'push_delivery_attempts',
  'response_cache',
  'scheduling_appointment_types',
  'scheduling_audit_log',
  'scheduling_booking_rules',
  'scheduling_overrides',
  'scheduling_provider_schedules',
  'scheduling_providers',
  'scheduling_recurring_series',
  'scheduling_reminder_configs',
  'scheduling_reminder_log',
  'scheduling_resources',
  'scheduling_waitlist',
  'scheduling_workflows',
  'simulation_results',
  'simulation_runs',
  'simulation_scenarios',
  'sms_assignment_rules',
  'sms_auto_reply_rules',
  'sms_canned_responses',
  'sms_consent_log',
  'sms_conversation_activity_log',
  'sms_conversations',
  'sms_internal_notes',
  'sms_logs',
  'sms_messages',
  'subscriptions',
  'support_recipient_bounce_alerts',
  'support_tickets',
  'template_install_events',
  'tenant_agent_installations',
  'tenant_deletion_requests',
  'tenant_notifications',
  'ticket_activity_log',
  'ticket_attachments',
  'ticket_categories',
  'ticket_custom_field_values',
  'ticket_custom_fields',
  'ticket_links',
  'ticket_macros',
  'ticket_notifications',
  'ticket_outbox',
  'ticket_queue_configs',
  'ticket_retention_policies',
  'ticket_saved_views',
  'ticket_sla_instances',
  'ticket_sla_policies',
  'ticket_templates',
  'ticket_watchers',
  'ticket_workflow_rules',
  'tickets',
  'tool_failure_events',
  'tool_invocations',
  'tool_rate_limits',
  'usage_metrics',
  'user_devices',
  'user_invitations',
  'user_roles',
  'users',
  'verified_caller_alert_recipients',
  'verified_caller_ids',
  'webhook_events',
  'weekly_reports',
  'widget_configs',
  'widget_tokens',
  'workflow_executions',
  'workflow_steps',
  'workflows',
  'workforce_members',
  'workforce_optimization_insights',
  'workforce_outbound_tasks',
  'workforce_revenue_metrics',
  'workforce_routing_history',
  'workforce_routing_rules',
  'workforce_teams',
  'workforce_templates',
] as const;

const HIGH_RISK_CLASSIFICATIONS: Readonly<Record<string, readonly TenantDataClass[]>> = Object.freeze({
  call_sessions: ['pii', 'phi', 'transcript'],
  call_events: ['phi', 'log'],
  call_transcripts: ['transcript', 'phi'],
  tool_invocations: ['tool', 'phi'],
  outbox_messages: ['outcome', 'pii', 'phi'],
  tickets: ['outcome', 'pii', 'phi'],
  escalation_tasks: ['outcome', 'pii', 'phi'],
  tool_failure_events: ['tool', 'log', 'phi'],
  knowledge_articles: ['knowledge', 'phi'],
  error_logs: ['log', 'phi'],
  audit_logs: ['log', 'evidence', 'phi'],
  tenant_deletion_requests: ['evidence'],
  healthcare_control_evidence: ['evidence'],
  healthcare_activation_readiness: ['evidence'],
  healthcare_deployment_approvals: ['evidence'],
});

function dispositionFor(table: string): TenantDeletionDisposition {
  if (table === 'tenant_deletion_requests') return 'preserve_evidence';
  if (table === 'audit_logs') return 'controlled_audit_delete';
  return 'cascade';
}

export const TENANT_DATA_CONTROL_CATALOG: readonly TenantDataControlEntry[] = Object.freeze(
  TENANT_TABLE_NAMES.map((table) => Object.freeze({
    table,
    tenantColumn: 'tenant_id' as const,
    dataClasses: HIGH_RISK_CLASSIFICATIONS[table] ?? (['tenant_data'] as const),
    deletionDisposition: dispositionFor(table),
  })),
);

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export function validateTenantDataControlCatalog(
  entries: readonly TenantDataControlEntry[] = TENANT_DATA_CONTROL_CATALOG,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!SAFE_IDENTIFIER.test(entry.table)) errors.push('unsafe table identifier: ' + entry.table);
    if (seen.has(entry.table)) errors.push('duplicate table: ' + entry.table);
    if (entry.dataClasses.length === 0) errors.push('missing data classification: ' + entry.table);
    seen.add(entry.table);
  }
  return errors;
}
