import { createHash } from 'node:crypto';
import type { HealthcareControlEvidenceRecord } from '../../shared/compliance/healthcareControlEvidence';
import {
  HEALTHCARE_RETENTION_SCOPES,
  evaluateHealthcareRetentionPolicy,
  type HealthcareRetentionPolicy,
  type HealthcareRetentionScope,
} from '../../shared/compliance/healthcareRetentionPolicy';

interface PlannerClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

const RETENTION_TARGETS: Partial<Record<HealthcareRetentionScope, readonly {
  table: string;
  timestampColumn: string;
}[]>> = {
  call_sessions: [{ table: 'call_sessions', timestampColumn: 'start_time' }],
  call_transcripts: [{ table: 'call_transcripts', timestampColumn: 'occurred_at' }],
  call_events: [{ table: 'call_events', timestampColumn: 'occurred_at' }],
  tool_invocations: [{ table: 'tool_invocations', timestampColumn: 'invoked_at' }],
  outbox: [{ table: 'outbox_messages', timestampColumn: 'created_at' }],
  tickets: [{ table: 'tickets', timestampColumn: 'created_at' }],
  escalations: [{ table: 'escalation_tasks', timestampColumn: 'created_at' }],
  knowledge: [
    { table: 'knowledge_articles', timestampColumn: 'created_at' },
    { table: 'knowledge_documents', timestampColumn: 'created_at' },
    { table: 'knowledge_chunks', timestampColumn: 'created_at' },
  ],
  logs: [
    { table: 'error_logs', timestampColumn: 'occurred_at' },
    { table: 'audit_logs', timestampColumn: 'occurred_at' },
  ],
  control_evidence: [{ table: 'healthcare_control_evidence', timestampColumn: 'created_at' }],
  first_party_files: [
    { table: 'ticket_attachments', timestampColumn: 'created_at' },
    { table: 'dispatch_job_attachments', timestampColumn: 'created_at' },
  ],
};

function policyDigest(policy: HealthcareRetentionPolicy): string {
  const canonical = {
    policyId: policy.policyId,
    version: policy.version,
    tenantId: policy.tenantId,
    agentId: policy.agentId,
    environment: policy.environment,
    effectiveAt: policy.effectiveAt,
    expiresAt: policy.expiresAt,
    evidenceRef: policy.evidenceRef,
    legalHoldMode: policy.legalHoldMode,
    rules: HEALTHCARE_RETENTION_SCOPES.map((scope) => [scope, policy.rules[scope].retentionDays]),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export async function buildHealthcareRetentionDryRun(
  client: PlannerClient,
  input: {
    policy: HealthcareRetentionPolicy;
    evidence: HealthcareControlEvidenceRecord;
    now?: Date;
  },
): Promise<{
  mode: 'dry-run';
  executionAuthorized: false;
  policyDigest: string;
  policyVersion: string;
  evidenceRecordId: string;
  counts: Record<HealthcareRetentionScope, number | null>;
  externalEvidenceRequired: ['backups', 'external_processors'];
}> {
  const now = input.now ?? new Date();
  const decision = evaluateHealthcareRetentionPolicy({ ...input, now });
  if (!decision.valid) {
    throw new Error('Healthcare retention planning requires verified owner evidence');
  }

  const counts = Object.fromEntries(
    HEALTHCARE_RETENTION_SCOPES.map((scope) => [scope, null]),
  ) as Record<HealthcareRetentionScope, number | null>;
  for (const scope of HEALTHCARE_RETENTION_SCOPES) {
    const targets = RETENTION_TARGETS[scope];
    if (!targets) continue;
    let scopeCount = 0;
    const cutoff = new Date(now.getTime() - input.policy.rules[scope].retentionDays * 86_400_000);
    for (const target of targets) {
      const result = await client.query(
        `SELECT COUNT(*)::int AS candidate_count FROM ${target.table} WHERE tenant_id = $1 AND ${target.timestampColumn} < $2`,
        [input.policy.tenantId, cutoff],
      );
      scopeCount += Number(result.rows[0]?.candidate_count ?? 0);
    }
    counts[scope] = scopeCount;
  }

  return {
    mode: 'dry-run',
    executionAuthorized: false,
    policyDigest: policyDigest(input.policy),
    policyVersion: input.policy.version,
    evidenceRecordId: decision.evidenceRecordId,
    counts,
    externalEvidenceRequired: ['backups', 'external_processors'],
  };
}
