import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('healthcare call ingress gate wiring', () => {
  it('enforces approval before inbound and outbound Twilio streams are returned', () => {
    const twilio = source('server/voice-gateway/routes/twilio.ts');
    expect(twilio).toContain("from '../../../platform/compliance/HealthcareDeploymentApprovalService'");
    expect((twilio.match(/authorizeHealthcareDeployment\(/g) ?? [])).toHaveLength(2);
    const inboundGate = twilio.indexOf('authorizeHealthcareDeployment(', twilio.indexOf("router.post('/twilio/voice'"));
    const inboundStream = twilio.indexOf('<Stream url=', twilio.indexOf("router.post('/twilio/voice'"));
    const outboundGate = twilio.indexOf('authorizeHealthcareDeployment(', twilio.indexOf("router.post('/twilio/outbound'"));
    const outboundStream = twilio.indexOf('<Stream url=', twilio.indexOf("router.post('/twilio/outbound'"));
    expect(inboundGate).toBeGreaterThan(0);
    expect(inboundGate).toBeLessThan(inboundStream);
    expect(outboundGate).toBeGreaterThan(0);
    expect(outboundGate).toBeLessThan(outboundStream);
  });

  it('rechecks database-backed agent identity at Twilio and widget WebSocket start', () => {
    const stream = source('server/voice-gateway/routes/stream.ts');
    expect(stream).toContain("from '../../../platform/compliance/HealthcareDeploymentApprovalService'");
    expect((stream.match(/authorizeHealthcareDeployment\(/g) ?? [])).toHaveLength(2);
    expect(stream).toMatch(/trustedAgentType[\s\S]{0,500}authorizeHealthcareDeployment\(/);
    expect(stream).toMatch(/widgetConfig\.agent_id[\s\S]{0,1000}authorizeHealthcareDeployment\(/);
  });
});
