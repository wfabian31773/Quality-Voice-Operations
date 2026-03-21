import { Router } from 'express';
import crypto from 'crypto';
import { upsertConnector } from '../../../platform/integrations/connectors';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('CONNECTOR_OAUTH');

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
    return res.status(400).json({ error: 'HubSpot OAuth not configured: HUBSPOT_CLIENT_ID missing' });
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
    return res.status(400).json({ error: 'Google OAuth not configured: GOOGLE_CLIENT_ID missing' });
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

router.get('/connectors/oauth/slack/init', requireAuth, requireRole('manager'), (req, res) => {
  const clientId = process.env.SLACK_CLIENT_ID ?? '';
  if (!clientId) {
    return res.status(400).json({ error: 'Slack OAuth not configured: SLACK_CLIENT_ID missing' });
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

export default router;
