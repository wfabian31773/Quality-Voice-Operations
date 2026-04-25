import { Router, Response } from 'express';
import crypto from 'crypto';
import { upsertConnector } from '../../../platform/integrations/connectors';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('CONNECTOR_OAUTH');

function sendOAuthNotConfigured(
  res: Response,
  opts: { provider: string; providerLabel: string; missingEnv: string; docsUrl: string },
) {
  return res.status(400).json({
    error: `${opts.providerLabel} OAuth not configured: ${opts.missingEnv} missing`,
    code: 'OAUTH_NOT_CONFIGURED',
    provider: opts.provider,
    providerLabel: opts.providerLabel,
    missingEnv: opts.missingEnv,
    docsUrl: opts.docsUrl,
  });
}

function getBaseUrl(req: { headers: Record<string, string | string[] | undefined> }): string {
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:3002';
  return `${proto}://${host}`;
}

function getStateSecret(): string {
  return process.env.ADMIN_JWT_SECRET ?? process.env.CONNECTOR_ENCRYPTION_KEY ?? 'fallback-dev-secret';
}

function signState(payload: { tenantId: string; userId: string; provider: string }): string {
  const data = JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) });
  const dataB64 = Buffer.from(data).toString('base64url');
  const sig = crypto.createHmac('sha256', getStateSecret()).update(dataB64).digest('base64url');
  return `${dataB64}.${sig}`;
}

function verifyState(state: string, expectedProvider: string): { tenantId: string; userId: string } | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [dataB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', getStateSecret()).update(dataB64).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(dataB64, 'base64url').toString()) as {
      tenantId: string;
      userId: string;
      provider: string;
      iat: number;
    };
    if (parsed.provider !== expectedProvider) return null;
    const age = Math.floor(Date.now() / 1000) - parsed.iat;
    if (age > 600) return null;
    return { tenantId: parsed.tenantId, userId: parsed.userId };
  } catch {
    return null;
  }
}

function getAppOrigin(req: { headers: Record<string, string | string[] | undefined> }): string {
  const proto = req.headers['x-forwarded-proto'] ?? 'https';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:5000';
  return `${proto}://${host}`;
}

function oauthSuccessHtml(provider: string, appOrigin: string, displayName: string): string {
  return `<html><body><script>window.opener?.postMessage({type:"oauth_complete",provider:"${provider}"},"${appOrigin}");window.close();</script>${displayName} connected! You can close this window.</body></html>`;
}

router.get('/connectors/oauth/hubspot/init', requireAuth, requireRole('manager'), (req, res) => {
  const clientId = process.env.HUBSPOT_CLIENT_ID ?? '';
  if (!clientId) {
    return sendOAuthNotConfigured(res, {
      provider: 'hubspot',
      providerLabel: 'HubSpot',
      missingEnv: 'HUBSPOT_CLIENT_ID',
      docsUrl: '/docs/connecting-hubspot',
    });
  }

  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/connectors/oauth/hubspot/callback`;
  const state = signState({ tenantId: req.user!.tenantId, userId: req.user!.userId, provider: 'hubspot' });

  const scopes = [
    'crm.objects.contacts.read',
    'crm.objects.contacts.write',
    'crm.objects.deals.read',
    'crm.objects.deals.write',
    'timeline',
  ].join('%20');

  const authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&state=${state}`;

  return res.json({ authUrl, redirectUri });
});

router.get('/connectors/oauth/hubspot/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    return res.status(400).send('<html><body><script>window.close();</script>OAuth failed: missing code or state</body></html>');
  }

  const clientId = process.env.HUBSPOT_CLIENT_ID ?? '';
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET ?? '';

  if (!clientId || !clientSecret) {
    return res.status(500).send('<html><body><script>window.close();</script>HubSpot OAuth not configured</body></html>');
  }

  const parsed = verifyState(state, 'hubspot');
  if (!parsed) {
    logger.warn('HubSpot OAuth callback: invalid or expired state');
    return res.status(400).send('<html><body><script>window.close();</script>Invalid or expired state</body></html>');
  }

  try {
    const baseUrl = getBaseUrl(req);
    const tokenRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${baseUrl}/connectors/oauth/hubspot/callback`,
        code,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      logger.error('HubSpot token exchange failed', { status: tokenRes.status, body: text.slice(0, 200) });
      return res.status(500).send('<html><body><script>window.close();</script>Token exchange failed</body></html>');
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    await upsertConnector(parsed.tenantId, {
      connectorType: 'crm',
      provider: 'hubspot',
      name: 'HubSpot',
      credentials: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: String(Date.now() + tokens.expires_in * 1000),
      },
      isEnabled: true,
    });

    logger.info('HubSpot OAuth connected', { tenantId: parsed.tenantId });
    writeAuditLog({
      tenantId: parsed.tenantId,
      actorUserId: parsed.userId,
      actorRole: 'manager',
      action: 'connector.oauth_connected',
      resourceType: 'connector',
      resourceId: 'hubspot',
      changes: { provider: 'hubspot', connectorType: 'crm' },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    const appOrigin = getAppOrigin(req);
    return res.send(oauthSuccessHtml('hubspot', appOrigin, 'HubSpot'));
  } catch (err) {
    logger.error('HubSpot OAuth callback failed', { error: String(err) });
    return res.status(500).send('<html><body><script>window.close();</script>OAuth failed</body></html>');
  }
});

router.get('/connectors/oauth/google/init', requireAuth, requireRole('manager'), (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? '';
  if (!clientId) {
    return sendOAuthNotConfigured(res, {
      provider: 'google',
      providerLabel: 'Google',
      missingEnv: 'GOOGLE_CLIENT_ID',
      docsUrl: '/docs/connecting-calendar',
    });
  }

  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/connectors/oauth/google/callback`;
  const state = signState({ tenantId: req.user!.tenantId, userId: req.user!.userId, provider: 'google' });

  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ].join('%20');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes}&access_type=offline&prompt=consent&state=${state}`;

  return res.json({ authUrl, redirectUri });
});

router.get('/connectors/oauth/google/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    return res.status(400).send('<html><body><script>window.close();</script>OAuth failed: missing code or state</body></html>');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID ?? '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';

  if (!clientId || !clientSecret) {
    return res.status(500).send('<html><body><script>window.close();</script>Google OAuth not configured</body></html>');
  }

  const parsed = verifyState(state, 'google');
  if (!parsed) {
    logger.warn('Google OAuth callback: invalid or expired state');
    return res.status(400).send('<html><body><script>window.close();</script>Invalid or expired state</body></html>');
  }

  try {
    const baseUrl = getBaseUrl(req);
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${baseUrl}/connectors/oauth/google/callback`,
        code,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      logger.error('Google token exchange failed', { status: tokenRes.status, body: text.slice(0, 200) });
      return res.status(500).send('<html><body><script>window.close();</script>Token exchange failed</body></html>');
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    await upsertConnector(parsed.tenantId, {
      connectorType: 'scheduling',
      provider: 'google-calendar',
      name: 'Google Calendar',
      credentials: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? '',
        client_id: clientId,
        client_secret: clientSecret,
        token_expires_at: String(Date.now() + tokens.expires_in * 1000),
      },
      isEnabled: true,
    });

    logger.info('Google Calendar OAuth connected', { tenantId: parsed.tenantId });
    writeAuditLog({
      tenantId: parsed.tenantId,
      actorUserId: parsed.userId,
      actorRole: 'manager',
      action: 'connector.oauth_connected',
      resourceType: 'connector',
      resourceId: 'google-calendar',
      changes: { provider: 'google-calendar', connectorType: 'scheduling' },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    const appOrigin = getAppOrigin(req);
    return res.send(oauthSuccessHtml('google-calendar', appOrigin, 'Google Calendar'));
  } catch (err) {
    logger.error('Google OAuth callback failed', { error: String(err) });
    return res.status(500).send('<html><body><script>window.close();</script>OAuth failed</body></html>');
  }
});

router.get('/connectors/oauth/outlook/init', requireAuth, requireRole('manager'), (req, res) => {
  const clientId = process.env.MICROSOFT_CLIENT_ID ?? '';
  if (!clientId) {
    return sendOAuthNotConfigured(res, {
      provider: 'outlook',
      providerLabel: 'Microsoft',
      missingEnv: 'MICROSOFT_CLIENT_ID',
      docsUrl: '/docs/connecting-outlook',
    });
  }

  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/connectors/oauth/outlook/callback`;
  const state = signState({ tenantId: req.user!.tenantId, userId: req.user!.userId, provider: 'outlook' });
  const tenant = process.env.MICROSOFT_TENANT_ID || 'common';

  const scopes = [
    'offline_access',
    'https://graph.microsoft.com/Calendars.ReadWrite',
    'https://graph.microsoft.com/User.Read',
  ].join(' ');

  const authUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&response_mode=query&scope=${encodeURIComponent(scopes)}&prompt=consent&state=${state}`;

  return res.json({ authUrl, redirectUri });
});

router.get('/connectors/oauth/outlook/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    return res.status(400).send('<html><body><script>window.close();</script>OAuth failed: missing code or state</body></html>');
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID ?? '';
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET ?? '';

  if (!clientId || !clientSecret) {
    return res.status(500).send('<html><body><script>window.close();</script>Microsoft OAuth not configured</body></html>');
  }

  const parsed = verifyState(state, 'outlook');
  if (!parsed) {
    logger.warn('Outlook OAuth callback: invalid or expired state');
    return res.status(400).send('<html><body><script>window.close();</script>Invalid or expired state</body></html>');
  }

  try {
    const baseUrl = getBaseUrl(req);
    const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
    const tokenRes = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${baseUrl}/connectors/oauth/outlook/callback`,
        code,
        scope: 'offline_access https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read',
      }).toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      logger.error('Outlook token exchange failed', { status: tokenRes.status, body: text.slice(0, 200) });
      return res.status(500).send('<html><body><script>window.close();</script>Token exchange failed</body></html>');
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    await upsertConnector(parsed.tenantId, {
      connectorType: 'scheduling',
      provider: 'outlook-calendar',
      name: 'Outlook Calendar',
      credentials: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? '',
        client_id: clientId,
        client_secret: clientSecret,
        token_expires_at: String(Date.now() + tokens.expires_in * 1000),
      },
      isEnabled: true,
    });

    logger.info('Outlook Calendar OAuth connected', { tenantId: parsed.tenantId });
    writeAuditLog({
      tenantId: parsed.tenantId,
      actorUserId: parsed.userId,
      actorRole: 'manager',
      action: 'connector.oauth_connected',
      resourceType: 'connector',
      resourceId: 'outlook-calendar',
      changes: { provider: 'outlook-calendar', connectorType: 'scheduling' },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    const appOrigin = getAppOrigin(req);
    return res.send(oauthSuccessHtml('outlook-calendar', appOrigin, 'Outlook Calendar'));
  } catch (err) {
    logger.error('Outlook OAuth callback failed', { error: String(err) });
    return res.status(500).send('<html><body><script>window.close();</script>OAuth failed</body></html>');
  }
});

router.get('/connectors/oauth/slack/init', requireAuth, requireRole('manager'), (req, res) => {
  const clientId = process.env.SLACK_CLIENT_ID ?? '';
  if (!clientId) {
    return sendOAuthNotConfigured(res, {
      provider: 'slack',
      providerLabel: 'Slack',
      missingEnv: 'SLACK_CLIENT_ID',
      docsUrl: '/docs/connecting-slack',
    });
  }

  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/connectors/oauth/slack/callback`;
  const state = signState({ tenantId: req.user!.tenantId, userId: req.user!.userId, provider: 'slack' });

  const scopes = [
    'chat:write',
    'channels:read',
    'groups:read',
  ].join(',');

  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  return res.json({ authUrl, redirectUri });
});

router.get('/connectors/oauth/slack/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    return res.status(400).send('<html><body><script>window.close();</script>OAuth failed: missing code or state</body></html>');
  }

  const clientId = process.env.SLACK_CLIENT_ID ?? '';
  const clientSecret = process.env.SLACK_CLIENT_SECRET ?? '';

  if (!clientId || !clientSecret) {
    return res.status(500).send('<html><body><script>window.close();</script>Slack OAuth not configured</body></html>');
  }

  const parsed = verifyState(state, 'slack');
  if (!parsed) {
    logger.warn('Slack OAuth callback: invalid or expired state');
    return res.status(400).send('<html><body><script>window.close();</script>Invalid or expired state</body></html>');
  }

  try {
    const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }).toString(),
    });

    const tokenData = await tokenRes.json() as {
      ok: boolean;
      access_token?: string;
      bot_user_id?: string;
      team?: { id: string; name: string };
      incoming_webhook?: { channel_id: string; channel: string };
      error?: string;
    };

    if (!tokenData.ok || !tokenData.access_token) {
      logger.error('Slack token exchange failed', { error: tokenData.error });
      return res.status(500).send('<html><body><script>window.close();</script>Slack OAuth failed</body></html>');
    }

    const channelId = tokenData.incoming_webhook?.channel_id ?? '';

    await upsertConnector(parsed.tenantId, {
      connectorType: 'custom',
      provider: 'slack',
      name: 'Slack',
      credentials: {
        bot_token: tokenData.access_token,
        channel_id: channelId,
        team_id: tokenData.team?.id ?? '',
        team_name: tokenData.team?.name ?? '',
      },
      isEnabled: true,
    });

    logger.info('Slack OAuth connected', { tenantId: parsed.tenantId });
    writeAuditLog({
      tenantId: parsed.tenantId,
      actorUserId: parsed.userId,
      actorRole: 'manager',
      action: 'connector.oauth_connected',
      resourceType: 'connector',
      resourceId: 'slack',
      changes: { provider: 'slack', connectorType: 'custom' },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    const appOrigin = getAppOrigin(req);
    return res.send(oauthSuccessHtml('slack', appOrigin, 'Slack'));
  } catch (err) {
    logger.error('Slack OAuth callback failed', { error: String(err) });
    return res.status(500).send('<html><body><script>window.close();</script>OAuth failed</body></html>');
  }
});

router.get('/connectors/oauth/pipedrive/init', requireAuth, requireRole('manager'), (req, res) => {
  const clientId = process.env.PIPEDRIVE_CLIENT_ID ?? '';
  if (!clientId) {
    return sendOAuthNotConfigured(res, {
      provider: 'pipedrive',
      providerLabel: 'Pipedrive',
      missingEnv: 'PIPEDRIVE_CLIENT_ID',
      docsUrl: '/docs/connecting-pipedrive',
    });
  }

  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/connectors/oauth/pipedrive/callback`;
  const state = signState({ tenantId: req.user!.tenantId, userId: req.user!.userId, provider: 'pipedrive' });

  const authUrl = `https://oauth.pipedrive.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  return res.json({ authUrl, redirectUri });
});

router.get('/connectors/oauth/salesforce/init', requireAuth, requireRole('manager'), (req, res) => {
  const clientId = process.env.SALESFORCE_CLIENT_ID ?? '';
  if (!clientId) {
    return sendOAuthNotConfigured(res, {
      provider: 'salesforce',
      providerLabel: 'Salesforce',
      missingEnv: 'SALESFORCE_CLIENT_ID',
      docsUrl: '/docs/connecting-salesforce',
    });
  }

  const loginUrl = process.env.SALESFORCE_LOGIN_URL ?? 'https://login.salesforce.com';
  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/connectors/oauth/salesforce/callback`;
  const state = signState({ tenantId: req.user!.tenantId, userId: req.user!.userId, provider: 'salesforce' });

  const scopes = ['api', 'refresh_token', 'offline_access', 'id'].join(' ');

  const authUrl = `${loginUrl}/services/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${state}`;

  return res.json({ authUrl, redirectUri });
});

router.get('/connectors/oauth/pipedrive/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    return res.status(400).send('<html><body><script>window.close();</script>OAuth failed: missing code or state</body></html>');
  }

  const clientId = process.env.PIPEDRIVE_CLIENT_ID ?? '';
  const clientSecret = process.env.PIPEDRIVE_CLIENT_SECRET ?? '';

  if (!clientId || !clientSecret) {
    return res.status(500).send('<html><body><script>window.close();</script>Pipedrive OAuth not configured</body></html>');
  }

  const parsed = verifyState(state, 'pipedrive');
  if (!parsed) {
    logger.warn('Pipedrive OAuth callback: invalid or expired state');
    return res.status(400).send('<html><body><script>window.close();</script>Invalid or expired state</body></html>');
  }

  try {
    const baseUrl = getBaseUrl(req);
    const tokenRes = await fetch('https://oauth.pipedrive.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${baseUrl}/connectors/oauth/pipedrive/callback`,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      logger.error('Pipedrive token exchange failed', { status: tokenRes.status, body: text.slice(0, 200) });
      return res.status(500).send('<html><body><script>window.close();</script>Token exchange failed</body></html>');
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      api_domain?: string;
    };

    const companyDomain = tokens.api_domain
      ? tokens.api_domain.replace(/^https?:\/\//, '').split('.')[0]
      : '';

    await upsertConnector(parsed.tenantId, {
      connectorType: 'crm',
      provider: 'pipedrive',
      name: 'Pipedrive',
      credentials: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: String(Date.now() + tokens.expires_in * 1000),
        ...(companyDomain ? { company_domain: companyDomain } : {}),
      },
      isEnabled: true,
    });

    logger.info('Pipedrive OAuth connected', { tenantId: parsed.tenantId });
    writeAuditLog({
      tenantId: parsed.tenantId,
      actorUserId: parsed.userId,
      actorRole: 'manager',
      action: 'connector.oauth_connected',
      resourceType: 'connector',
      resourceId: 'pipedrive',
      changes: { provider: 'pipedrive', connectorType: 'crm' },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    const appOrigin = getAppOrigin(req);
    return res.send(oauthSuccessHtml('pipedrive', appOrigin, 'Pipedrive'));
  } catch (err) {
    logger.error('Pipedrive OAuth callback failed', { error: String(err) });
    return res.status(500).send('<html><body><script>window.close();</script>OAuth failed</body></html>');
  }
});

router.get('/connectors/oauth/salesforce/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };

  if (!code || !state) {
    return res.status(400).send('<html><body><script>window.close();</script>OAuth failed: missing code or state</body></html>');
  }

  const clientId = process.env.SALESFORCE_CLIENT_ID ?? '';
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET ?? '';
  const loginUrl = process.env.SALESFORCE_LOGIN_URL ?? 'https://login.salesforce.com';

  if (!clientId || !clientSecret) {
    return res.status(500).send('<html><body><script>window.close();</script>Salesforce OAuth not configured</body></html>');
  }

  const parsed = verifyState(state, 'salesforce');
  if (!parsed) {
    logger.warn('Salesforce OAuth callback: invalid or expired state');
    return res.status(400).send('<html><body><script>window.close();</script>Invalid or expired state</body></html>');
  }

  try {
    const baseUrl = getBaseUrl(req);
    const tokenRes = await fetch(`${loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${baseUrl}/connectors/oauth/salesforce/callback`,
        code,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      logger.error('Salesforce token exchange failed', { status: tokenRes.status, body: text.slice(0, 200) });
      return res.status(500).send('<html><body><script>window.close();</script>Token exchange failed</body></html>');
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      instance_url: string;
      issued_at?: string;
      expires_in?: number;
      id?: string;
    };

    if (!tokens.access_token || !tokens.instance_url) {
      logger.error('Salesforce token response missing fields');
      return res.status(500).send('<html><body><script>window.close();</script>Salesforce returned incomplete tokens</body></html>');
    }

    // Use Salesforce-reported issued_at + expires_in (default ~2 hours) for accurate TTL.
    const issuedAtMs = tokens.issued_at ? Number(tokens.issued_at) : Date.now();
    const ttlMs = (tokens.expires_in ? tokens.expires_in : 2 * 60 * 60) * 1000;
    const expiresAt = issuedAtMs + ttlMs;

    await upsertConnector(parsed.tenantId, {
      connectorType: 'crm',
      provider: 'salesforce',
      name: 'Salesforce',
      credentials: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? '',
        instance_url: tokens.instance_url,
        token_expires_at: String(expiresAt),
        identity_url: tokens.id ?? '',
      },
      isEnabled: true,
    });

    logger.info('Salesforce OAuth connected', { tenantId: parsed.tenantId, instanceUrl: tokens.instance_url });
    writeAuditLog({
      tenantId: parsed.tenantId,
      actorUserId: parsed.userId,
      actorRole: 'manager',
      action: 'connector.oauth_connected',
      resourceType: 'connector',
      resourceId: 'salesforce',
      changes: { provider: 'salesforce', connectorType: 'crm' },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    const appOrigin = getAppOrigin(req);
    return res.send(oauthSuccessHtml('salesforce', appOrigin, 'Salesforce'));
  } catch (err) {
    logger.error('Salesforce OAuth callback failed', { error: String(err) });
    return res.status(500).send('<html><body><script>window.close();</script>OAuth failed</body></html>');
  }
});

router.get('/connectors/oauth/quickbooks/init', requireAuth, requireRole('manager'), (req, res) => {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID ?? '';
  if (!clientId) {
    return sendOAuthNotConfigured(res, {
      provider: 'quickbooks',
      providerLabel: 'QuickBooks',
      missingEnv: 'QUICKBOOKS_CLIENT_ID',
      docsUrl: '/docs/connecting-quickbooks',
    });
  }

  const baseUrl = getBaseUrl(req);
  const redirectUri = `${baseUrl}/connectors/oauth/quickbooks/callback`;
  const state = signState({ tenantId: req.user!.tenantId, userId: req.user!.userId, provider: 'quickbooks' });

  const scopes = ['com.intuit.quickbooks.accounting'].join(' ');

  const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${clientId}&response_type=code&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  return res.json({ authUrl, redirectUri });
});

router.get('/connectors/oauth/quickbooks/callback', async (req, res) => {
  const { code, state, realmId } = req.query as { code?: string; state?: string; realmId?: string };

  if (!code || !state) {
    return res.status(400).send('<html><body><script>window.close();</script>OAuth failed: missing code or state</body></html>');
  }

  const clientId = process.env.QUICKBOOKS_CLIENT_ID ?? '';
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET ?? '';
  const environment = (process.env.QUICKBOOKS_ENV ?? 'production').toLowerCase();

  if (!clientId || !clientSecret) {
    return res.status(500).send('<html><body><script>window.close();</script>QuickBooks OAuth not configured</body></html>');
  }

  if (!realmId) {
    return res.status(400).send('<html><body><script>window.close();</script>QuickBooks OAuth failed: missing realmId</body></html>');
  }

  const parsed = verifyState(state, 'quickbooks');
  if (!parsed) {
    logger.warn('QuickBooks OAuth callback: invalid or expired state');
    return res.status(400).send('<html><body><script>window.close();</script>Invalid or expired state</body></html>');
  }

  try {
    const baseUrl = getBaseUrl(req);
    const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${baseUrl}/connectors/oauth/quickbooks/callback`,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      logger.error('QuickBooks token exchange failed', { status: tokenRes.status, body: text.slice(0, 200) });
      return res.status(500).send('<html><body><script>window.close();</script>Token exchange failed</body></html>');
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      x_refresh_token_expires_in?: number;
    };

    await upsertConnector(parsed.tenantId, {
      connectorType: 'accounting',
      provider: 'quickbooks',
      name: 'QuickBooks',
      credentials: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        realm_id: realmId,
        environment,
        token_expires_at: String(Date.now() + tokens.expires_in * 1000),
      },
      isEnabled: true,
    });

    logger.info('QuickBooks OAuth connected', { tenantId: parsed.tenantId, realmId });
    writeAuditLog({
      tenantId: parsed.tenantId,
      actorUserId: parsed.userId,
      actorRole: 'manager',
      action: 'connector.oauth_connected',
      resourceType: 'connector',
      resourceId: 'quickbooks',
      changes: { provider: 'quickbooks', connectorType: 'accounting', realmId },
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    const appOrigin = getAppOrigin(req);
    return res.send(oauthSuccessHtml('quickbooks', appOrigin, 'QuickBooks'));
  } catch (err) {
    logger.error('QuickBooks OAuth callback failed', { error: String(err) });
    return res.status(500).send('<html><body><script>window.close();</script>OAuth failed</body></html>');
  }
});

export default router;
