import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_COMPLIANCE_FRAMEWORKS,
  buildPublicCompliancePosture,
} from '../../shared/compliance/publicCompliancePosture';

const repoRoot = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('healthcare pilot fail-closed boundary', () => {
  it('publishes no positive framework, BAA, or residency determination by default', () => {
    const posture = buildPublicCompliancePosture([], new Date('2026-07-12T00:00:00.000Z'));
    expect(PUBLIC_COMPLIANCE_FRAMEWORKS.every(({ status }) => status === 'not_verified')).toBe(true);
    expect(posture.baa.available).toBe(false);
    expect(posture.baa.plans).toEqual([]);
    expect(posture.data_residency.verified).toBe(false);
  });

  it('creates calls with an encrypted caller identifier and recording disabled', () => {
    const persistence = source('server/voice-gateway/services/callPersistence.ts');
    expect(persistence).toContain('encryptSensitiveField(params.tenantId, params.callerNumber)');
    expect(persistence).toContain("recordingPolicy: { policy: 'disabled', status: 'not_recorded' }");
  });

  it('keeps healthcare emergency, clinical, and identity boundaries explicit', () => {
    const role = source('platform/agent-templates/healthcare-receptionist/rolePackage.ts');
    expect(role).toMatch(/you are not a clinician/i);
    expect(role).toMatch(/must not pretend to be human/i);
    expect(role).toContain('Call 911 now, or your local emergency number.');
    expect(role).toMatch(/do not attempt clinical triage/i);
    expect(role).toMatch(/never use the knowledge base as medical advice/i);
  });

  it('enables tenant isolation on the call, tool, outcome, and knowledge stores', () => {
    const baseRls = source('migrations/011_rls.sql');
    for (const table of ['call_sessions', 'call_events', 'call_transcripts', 'tool_invocations']) {
      expect(baseRls).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }

    const scopedMigrations = [
      ['migrations/019_outbox_messages.sql', 'outbox_messages'],
      ['migrations/046_reliability_engine.sql', 'escalation_tasks'],
      ['migrations/048_mini_systems.sql', 'tickets'],
      ['migrations/029_knowledge_articles.sql', 'knowledge_articles'],
    ] as const;
    for (const [path, table] of scopedMigrations) {
      expect(source(path)).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
  });

  it('does not tell customers that an unverified deletion workflow proves complete erasure', () => {
    const templates = source('platform/email/templates.ts');
    expect(templates).not.toMatch(/all account data[^.]+permanently erased/i);
    expect(templates).not.toMatch(/all users, agents, phone numbers, call sessions[^.]+were removed/i);
    expect(templates).toMatch(/must be verified before QVO confirms complete erasure/i);
  });
});
