import { describe, it, expect } from 'vitest';
import {
  resolveProcessRole,
  resolveVoicePort,
  resolveApiPort,
  scrubReplitFallbacks,
  resolveVoiceGatewayBaseUrl,
  resolveVoicePublicBaseUrl,
  isRenderRuntime,
  resolveVoiceGatewayProxyTarget,
} from './processRole';

describe('resolveProcessRole', () => {
  it('defaults to all (Replit) and accepts every role, case-insensitively', () => {
    expect(resolveProcessRole({})).toBe('all');
    expect(resolveProcessRole({ QVO_PROCESS_ROLE: '  ' })).toBe('all');
    expect(resolveProcessRole({}, 'worker')).toBe('worker');
    for (const r of ['all', 'api', 'voice', 'worker', 'cron']) expect(resolveProcessRole({ QVO_PROCESS_ROLE: r.toUpperCase() })).toBe(r);
  });

  it('throws on an unknown role without echoing the value', () => {
    expect(() => resolveProcessRole({ QVO_PROCESS_ROLE: 'secretish' })).toThrow(/must be one of/);
    expect(() => resolveProcessRole({ QVO_PROCESS_ROLE: 'secretish' })).not.toThrow(/secretish/);
  });
});

describe('ports', () => {
  it('voice binds PORT only for role voice', () => {
    expect(resolveVoicePort('voice', { PORT: '10000' })).toBe(10000);
    expect(resolveVoicePort('voice', {})).toBe(3001);
    expect(resolveVoicePort('all', { PORT: '5000' })).toBe(3001);
    expect(resolveVoicePort('all', { PORT: '5000', VOICE_GATEWAY_PORT: '3005' })).toBe(3005);
  });

  it('api binds PORT for role api and keeps ADMIN_API_PORT ?? PORT otherwise', () => {
    expect(resolveApiPort('api', { PORT: '10000', ADMIN_API_PORT: '3002' })).toBe(10000);
    expect(resolveApiPort('all', { PORT: '5000' })).toBe(5000); // Replit production
    expect(resolveApiPort('all', { PORT: '5000', ADMIN_API_PORT: '3002' })).toBe(3002); // Replit dev
    expect(resolveApiPort('all', {})).toBe(3002);
    expect(resolveApiPort('api', { PORT: 'x' })).toBe(3002);
  });
});

describe('Render guards', () => {
  it('scrubs Replit-only fallbacks only on Render', () => {
    const replit = { REPLIT_DEV_DOMAIN: 'x.replit.dev', REPL_ID: 'id' };
    expect(scrubReplitFallbacks(replit)).toEqual([]);
    expect(replit.REPLIT_DEV_DOMAIN).toBe('x.replit.dev');

    const render: Record<string, string | undefined> = { RENDER: 'true', REPLIT_DEV_DOMAIN: 'x', REPL_ID: 'y' };
    expect(isRenderRuntime(render)).toBe(true);
    expect(scrubReplitFallbacks(render)).toEqual(['REPLIT_DEV_DOMAIN', 'REPL_ID']);
    expect(render.REPLIT_DEV_DOMAIN).toBeUndefined();
  });

  it('voice gateway base URL never becomes https://undefined', () => {
    expect(resolveVoiceGatewayBaseUrl({ VOICE_GATEWAY_BASE_URL: 'https://voice.example.com/' })).toBe('https://voice.example.com');
    expect(resolveVoiceGatewayBaseUrl({ REPLIT_DEV_DOMAIN: 'dev.replit.dev' })).toBe('https://dev.replit.dev');
    expect(resolveVoiceGatewayBaseUrl({})).toBeNull();
    expect(resolveVoiceGatewayBaseUrl({ RENDER: 'true', REPLIT_DEV_DOMAIN: 'dev.replit.dev' })).toBeNull();
  });

  it('normalizes VOICE_PUBLIC_BASE_URL', () => {
    expect(resolveVoicePublicBaseUrl({ VOICE_PUBLIC_BASE_URL: ' https://v.example.com// ' })).toBe('https://v.example.com');
    expect(resolveVoicePublicBaseUrl({})).toBeNull();
  });
});

describe('resolveVoiceGatewayProxyTarget', () => {
  it('uses the Render private-network hostport when set, else 127.0.0.1 (Replit)', () => {
    expect(resolveVoiceGatewayProxyTarget({ VOICE_GATEWAY_INTERNAL_HOSTPORT: 'qvo-voice-abc:10000' })).toBe('http://qvo-voice-abc:10000');
    expect(resolveVoiceGatewayProxyTarget({})).toBe('http://127.0.0.1:3001');
    expect(resolveVoiceGatewayProxyTarget({ VOICE_GATEWAY_PORT: '3005' })).toBe('http://127.0.0.1:3005');
  });
});
