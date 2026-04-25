import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';

const router = Router();

interface OAuthProviderSpec {
  provider: string;
  label: string;
  category: string;
  requiredEnv: string[];
  optionalEnv?: string[];
  docsUrl: string;
}

const PROVIDERS: OAuthProviderSpec[] = [
  {
    provider: 'hubspot',
    label: 'HubSpot',
    category: 'CRM',
    requiredEnv: ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET'],
    docsUrl: '/docs/connecting-hubspot',
  },
  {
    provider: 'salesforce',
    label: 'Salesforce',
    category: 'CRM',
    requiredEnv: ['SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET'],
    optionalEnv: ['SALESFORCE_LOGIN_URL'],
    docsUrl: '/docs/connecting-salesforce',
  },
  {
    provider: 'pipedrive',
    label: 'Pipedrive',
    category: 'CRM',
    requiredEnv: ['PIPEDRIVE_CLIENT_ID', 'PIPEDRIVE_CLIENT_SECRET'],
    docsUrl: '/docs/connecting-pipedrive',
  },
  {
    provider: 'google-calendar',
    label: 'Google Calendar',
    category: 'Scheduling',
    requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    docsUrl: '/docs/connecting-calendar',
  },
  {
    provider: 'outlook-calendar',
    label: 'Outlook Calendar',
    category: 'Scheduling',
    requiredEnv: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    optionalEnv: ['MICROSOFT_TENANT_ID'],
    docsUrl: '/docs/connecting-outlook',
  },
  {
    provider: 'slack',
    label: 'Slack',
    category: 'Messaging',
    requiredEnv: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'],
    docsUrl: '/docs/connecting-slack',
  },
  {
    provider: 'quickbooks',
    label: 'QuickBooks',
    category: 'Finance',
    requiredEnv: ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET'],
    optionalEnv: ['QUICKBOOKS_ENV'],
    docsUrl: '/docs/connecting-quickbooks',
  },
];

router.get('/platform/integrations-status', requireAuth, requirePlatformAdmin, (_req, res) => {
  const providers = PROVIDERS.map((spec) => {
    const missingRequired = spec.requiredEnv.filter((name) => {
      const value = process.env[name];
      return value === undefined || value === '';
    });
    const optionalEnv = (spec.optionalEnv ?? []).map((name) => ({
      name,
      set: Boolean(process.env[name] && process.env[name] !== ''),
    }));
    return {
      provider: spec.provider,
      label: spec.label,
      category: spec.category,
      configured: missingRequired.length === 0,
      requiredEnv: spec.requiredEnv,
      missingEnv: missingRequired,
      optionalEnv,
      docsUrl: spec.docsUrl,
    };
  });

  const configuredCount = providers.filter((p) => p.configured).length;

  return res.json({
    providers,
    summary: {
      total: providers.length,
      configured: configuredCount,
      missing: providers.length - configuredCount,
    },
  });
});

export default router;
