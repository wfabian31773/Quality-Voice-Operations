// PR-00: render.yaml validates against Render's Blueprint JSON Schema and
// encodes the deploy-safety settings from render-plan.md §2/§6.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadBlueprint, loadVendoredSchema, validateBlueprint } from './validate-blueprint';

interface EnvVar { key?: string; value?: string; sync?: boolean; fromGroup?: string; fromService?: Record<string, string> }
interface Service {
  type: string; name: string; region: string; numInstances?: number; autoDeployTrigger: string;
  healthCheckPath?: string; maxShutdownDelaySeconds?: number; envVars: EnvVar[]; domains?: string[];
  preDeployCommand?: string; scaling?: unknown; schedule?: string; startCommand: string; buildCommand: string;
}

const doc = loadBlueprint() as {
  previews: { generation: string };
  projects: Array<{ name: string; environments: Array<{ name: string; services: Service[] }> }>;
};
const services = doc.projects[0].environments[0].services;
const byName = Object.fromEntries(services.map((s) => [s.name, s]));
const env = (s: Service, key: string) => s.envVars.find((e) => e.key === key);

describe('render.yaml', () => {
  it('validates against the Render Blueprint JSON Schema (vendored snapshot)', () => {
    const result = validateBlueprint(doc, loadVendoredSchema());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('the schema check is real: invalid values are rejected', () => {
    const bad = JSON.parse(JSON.stringify(doc));
    bad.projects[0].environments[0].services[0].autoDeployTrigger = 'sometimes';
    expect(validateBlueprint(bad, loadVendoredSchema()).valid).toBe(false);
  });

  it('project qvo / environment production, previews off', () => {
    expect(doc.projects.map((p) => p.name)).toEqual(['qvo']);
    expect(doc.projects[0].environments.map((e) => e.name)).toEqual(['production']);
    expect(doc.previews.generation).toBe('off');
  });

  it('has the four services with the planned types and commands', () => {
    expect(services.map((s) => [s.name, s.type])).toEqual([
      ['qvo-voice', 'web'], ['qvo-api', 'web'], ['qvo-worker', 'worker'], ['qvo-nightly', 'cron'],
    ]);
    expect(byName['qvo-voice'].startCommand).toBe('node --import tsx server/voice-gateway/start.ts');
    expect(byName['qvo-api'].startCommand).toBe('node --import tsx server/admin-api/start.ts');
    expect(byName['qvo-worker'].startCommand).toBe('node --import tsx server/worker/start.ts');
    expect(byName['qvo-nightly'].startCommand).toBe('node --import tsx server/jobs/run.ts nightly');
    expect(byName['qvo-api'].buildCommand).toBe('bash scripts/render/build.sh api');
    expect(byName['qvo-voice'].buildCommand).toBe('bash scripts/render/build.sh voice');
    expect(byName['qvo-nightly'].schedule).toBe('30 7 * * *');
  });

  it('region virginia and autoDeploy off everywhere', () => {
    for (const s of services) {
      expect(s.region, s.name).toBe('virginia');
      expect(s.autoDeployTrigger, s.name).toBe('off');
    }
  });

  it('one instance, no autoscaling, for every long-running service', () => {
    for (const s of services.filter((x) => x.type !== 'cron')) {
      expect(s.numInstances, s.name).toBe(1);
      expect(s.scaling, s.name).toBeUndefined();
    }
  });

  it('shutdown delays: voice 300 / api 60 / worker 120', () => {
    expect(byName['qvo-voice'].maxShutdownDelaySeconds).toBe(300);
    expect(byName['qvo-api'].maxShutdownDelaySeconds).toBe(60);
    expect(byName['qvo-worker'].maxShutdownDelaySeconds).toBe(120);
    expect(Number(env(byName['qvo-voice'], 'DRAIN_TIMEOUT_MS')?.value)).toBeLessThan(300_000);
  });

  it('health checks use liveness-only /healthz', () => {
    expect(byName['qvo-voice'].healthCheckPath).toBe('/healthz');
    expect(byName['qvo-api'].healthCheckPath).toBe('/healthz');
  });

  it('roles, domains, migrations and private-network wiring', () => {
    expect(env(byName['qvo-voice'], 'QVO_PROCESS_ROLE')?.value).toBe('voice');
    expect(env(byName['qvo-api'], 'QVO_PROCESS_ROLE')?.value).toBe('api');
    expect(env(byName['qvo-worker'], 'QVO_PROCESS_ROLE')?.value).toBe('worker');
    expect(env(byName['qvo-nightly'], 'QVO_PROCESS_ROLE')?.value).toBe('cron');
    expect(byName['qvo-voice'].domains).toEqual(['voice.qualityvoiceoperations.com']);
    expect(byName['qvo-api'].domains).toEqual(['api.qualityvoiceoperations.com']);
    expect(byName['qvo-api'].preDeployCommand).toBe('npm run db:migrate');
    expect(env(byName['qvo-api'], 'VOICE_GATEWAY_INTERNAL_HOSTPORT')?.fromService).toEqual({ type: 'web', name: 'qvo-voice', property: 'hostport' });
    for (const s of services) {
      expect(s.envVars.some((e) => e.fromGroup === 'qvo-secrets'), s.name).toBe(true);
      expect(env(s, 'APP_URL')?.value, s.name).toBeTruthy(); // RENDER=true requires it
      expect(env(s, 'VOICE_GATEWAY_BASE_URL')?.value, s.name).toBeTruthy();
    }
  });

  it('contains no literal secrets: secret-like keys are sync:false or come from the group', () => {
    const secretish = /(SECRET|TOKEN|KEY|PASS|PASSWORD|_DB_URL|DATABASE_URL|POOL_URL|AUTH)/;
    for (const s of services) {
      for (const e of s.envVars) {
        if (!e.key || !secretish.test(e.key)) continue;
        expect(e.value, `${s.name}.${e.key}`).toBeUndefined();
        expect(e.sync === false || e.fromService !== undefined, `${s.name}.${e.key}`).toBe(true);
      }
    }
    const raw = fs.readFileSync(path.resolve(__dirname, '../../render.yaml'), 'utf8');
    for (const pattern of [/sk_(live|test)_/, /whsec_/, /xai-[A-Za-z0-9]/, /postgres(ql)?:\/\//, /\bAC[0-9a-f]{32}\b/, /rnd_[A-Za-z0-9]/]) {
      expect(raw).not.toMatch(pattern);
    }
  });
});
