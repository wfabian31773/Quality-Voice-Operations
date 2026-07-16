import { pathToFileURL } from 'node:url';
import { withPrivilegedClient } from '../platform/db';
import { collectHealthcareDataControlPreflight } from '../platform/compliance/HealthcareDataControlPreflight';

export function parseHealthcareDataControlPreflightEnv(
  env: Record<string, string | undefined>,
): { tenantId: string; agentId: string; expectedDatabaseRole: string } {
  const tenantId = env.QVO_PREFLIGHT_TENANT_ID?.trim();
  const agentId = env.QVO_PREFLIGHT_AGENT_ID?.trim();
  if (!tenantId || !agentId) {
    throw new Error('QVO_PREFLIGHT_TENANT_ID and QVO_PREFLIGHT_AGENT_ID are required');
  }
  if (
    tenantId.length > 255
    || agentId.length > 255
    || /[\u0000-\u001f]/.test(tenantId)
    || /[\u0000-\u001f]/.test(agentId)
  ) throw new Error('Preflight scope identifiers must be bounded');
  const databaseUrl = env.PLATFORM_DB_POOL_URL?.trim();
  if (!databaseUrl) throw new Error('PLATFORM_DB_POOL_URL is required');
  let expectedDatabaseRole: string;
  try {
    const parsed = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.username) throw new Error();
    expectedDatabaseRole = decodeURIComponent(parsed.username);
  } catch {
    throw new Error('PLATFORM_DB_POOL_URL must be a valid PostgreSQL connection URL');
  }
  if (
    expectedDatabaseRole.length === 0
    || expectedDatabaseRole.length > 63
    || /[\u0000-\u001f]/.test(expectedDatabaseRole)
  ) throw new Error('Configured database role must be bounded');
  return { tenantId, agentId, expectedDatabaseRole };
}

export async function main(): Promise<void> {
  const scope = parseHealthcareDataControlPreflightEnv(process.env);
  const result = await withPrivilegedClient((client) => (
    collectHealthcareDataControlPreflight(client, scope)
  ));
  console.log(JSON.stringify(result));
  if (result.overallStatus !== 'pass') process.exitCode = 2;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  main().catch(() => {
    console.error('Healthcare data-control preflight failed; no identifiers, row data, or connection details were emitted');
    process.exitCode = 1;
  });
}
