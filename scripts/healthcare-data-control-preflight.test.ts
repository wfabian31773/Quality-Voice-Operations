import { describe, expect, it } from 'vitest';
import { parseHealthcareDataControlPreflightEnv } from './healthcare-data-control-preflight';

describe('healthcare data-control preflight CLI', () => {
  it('requires bounded scope identifiers from environment without accepting them as CLI output arguments', () => {
    expect(parseHealthcareDataControlPreflightEnv({
      QVO_PREFLIGHT_TENANT_ID: 't1', QVO_PREFLIGHT_AGENT_ID: 'a1',
      PLATFORM_DB_POOL_URL: 'postgresql://postgres.project-ref:secret@db.example.test:5432/postgres',
    })).toEqual({
      tenantId: 't1',
      agentId: 'a1',
      expectedDatabaseRole: 'postgres.project-ref',
    });
    expect(() => parseHealthcareDataControlPreflightEnv({})).toThrow('QVO_PREFLIGHT_TENANT_ID');
    expect(() => parseHealthcareDataControlPreflightEnv({
      QVO_PREFLIGHT_TENANT_ID: 't1', QVO_PREFLIGHT_AGENT_ID: 'a'.repeat(256),
    })).toThrow('bounded');
    expect(() => parseHealthcareDataControlPreflightEnv({
      QVO_PREFLIGHT_TENANT_ID: 't1', QVO_PREFLIGHT_AGENT_ID: 'a1',
    })).toThrow('PLATFORM_DB_POOL_URL');
  });

  it('derives the expected database role from the configured connection without returning credentials', () => {
    const parsed = parseHealthcareDataControlPreflightEnv({
      QVO_PREFLIGHT_TENANT_ID: 't1',
      QVO_PREFLIGHT_AGENT_ID: 'a1',
      PLATFORM_DB_POOL_URL: 'postgresql://postgres%2Eproject-ref:do-not-return@db.example.test/postgres',
    });
    expect(parsed.expectedDatabaseRole).toBe('postgres.project-ref');
    expect(JSON.stringify(parsed)).not.toContain('do-not-return');
  });
});
