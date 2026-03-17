import fs from 'fs';
import path from 'path';
import { getPlatformPool } from '../platform/db';

interface ManifestData {
  slug: string;
  displayName: string;
  description: string;
  shortDescription: string;
  version: string;
  agentType: string;
  category: string[];
  supportedChannels: string[];
  requiredTools: string[];
  optionalTools: string[];
  defaultVoice: string;
  defaultLanguage: string;
  minPlan: string;
  tags: string[];
  configSchema: Record<string, unknown>;
  iconUrl?: string;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
  marketplaceCategory?: string;
  priceModel?: string;
  priceCents?: number;
  featured?: boolean;
  developerName?: string;
}

const TEMPLATE_DIRS = [
  'medical-after-hours',
  'dental',
  'legal',
  'property-management',
  'home-services',
  'answering-service',
  'customer-support',
  'outbound-sales',
  'technical-support',
  'collections',
];

const CATEGORIES: Record<string, { displayName: string; description: string; icon: string; sortOrder: number }> = {
  healthcare: { displayName: 'Healthcare', description: 'Medical, dental, and health-related agent templates', icon: 'stethoscope', sortOrder: 1 },
  'professional-services': { displayName: 'Professional Services', description: 'Legal, accounting, and consulting agent templates', icon: 'briefcase', sortOrder: 2 },
  'real-estate': { displayName: 'Real Estate', description: 'Property management and real estate agent templates', icon: 'building', sortOrder: 3 },
  'home-services': { displayName: 'Home Services', description: 'HVAC, plumbing, electrical, and home repair agent templates', icon: 'wrench', sortOrder: 4 },
  general: { displayName: 'General', description: 'General-purpose answering and receptionist agent templates', icon: 'phone', sortOrder: 5 },
  'customer-service': { displayName: 'Customer Service', description: 'Customer support and technical assistance agent templates', icon: 'headset', sortOrder: 6 },
  sales: { displayName: 'Sales', description: 'Outbound sales and lead qualification agent templates', icon: 'megaphone', sortOrder: 7 },
  financial: { displayName: 'Financial', description: 'Collections, billing, and financial services agent templates', icon: 'dollar-sign', sortOrder: 8 },
};

async function seedTemplateRegistry(): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log('Seeding template categories...');
    const categoryIdMap: Record<string, string> = {};

    for (const [name, cat] of Object.entries(CATEGORIES)) {
      const result = await client.query(
        `INSERT INTO template_categories (name, display_name, description, icon, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name, description = EXCLUDED.description
         RETURNING id`,
        [name, cat.displayName, cat.description, cat.icon, cat.sortOrder],
      );
      categoryIdMap[name] = result.rows[0].id;
      console.log(`  Category: ${cat.displayName} (${result.rows[0].id})`);
    }

    const templatesDir = path.resolve(__dirname, '../platform/agent-templates');

    for (const dir of TEMPLATE_DIRS) {
      const manifestPath = path.join(templatesDir, dir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        console.warn(`  Skipping ${dir}: manifest.json not found`);
        continue;
      }

      const manifest: ManifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

      const VALID_PLANS = ['starter', 'pro', 'enterprise'];
      const VALID_AGENT_TYPES = ['inbound', 'outbound'];
      if (!VALID_PLANS.includes(manifest.minPlan)) {
        throw new Error(`Invalid minPlan "${manifest.minPlan}" in ${dir}/manifest.json. Must be one of: ${VALID_PLANS.join(', ')}`);
      }
      if (!VALID_AGENT_TYPES.includes(manifest.agentType)) {
        throw new Error(`Invalid agentType "${manifest.agentType}" in ${dir}/manifest.json. Must be one of: ${VALID_AGENT_TYPES.join(', ')}`);
      }
      if (!manifest.slug || !manifest.displayName || !manifest.version) {
        throw new Error(`Missing required fields (slug, displayName, version) in ${dir}/manifest.json`);
      }
      if (!Array.isArray(manifest.category) || manifest.category.length === 0) {
        throw new Error(`Invalid or empty category array in ${dir}/manifest.json`);
      }

      console.log(`\nSeeding template: ${manifest.displayName} (${manifest.slug})`);

      const mktCategory = manifest.marketplaceCategory ?? 'vertical_agent';
      const priceModel = manifest.priceModel ?? 'free';
      const priceCents = manifest.priceCents ?? 0;
      const featured = manifest.featured ?? false;
      const developerName = manifest.developerName ?? null;

      const templateResult = await client.query(
        `INSERT INTO template_registry
           (slug, display_name, description, short_description, icon_url, status, current_version,
            min_plan, agent_type, default_voice, default_language, supported_channels,
            required_tools, optional_tools, config_schema, tags, sort_order, metadata,
            marketplace_category, price_model, price_cents, featured, developer_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         ON CONFLICT (slug) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           short_description = EXCLUDED.short_description,
           current_version = EXCLUDED.current_version,
           min_plan = EXCLUDED.min_plan,
           agent_type = EXCLUDED.agent_type,
           default_voice = EXCLUDED.default_voice,
           default_language = EXCLUDED.default_language,
           supported_channels = EXCLUDED.supported_channels,
           required_tools = EXCLUDED.required_tools,
           optional_tools = EXCLUDED.optional_tools,
           config_schema = EXCLUDED.config_schema,
           tags = EXCLUDED.tags,
           sort_order = EXCLUDED.sort_order,
           metadata = EXCLUDED.metadata,
           marketplace_category = EXCLUDED.marketplace_category,
           price_model = EXCLUDED.price_model,
           price_cents = EXCLUDED.price_cents,
           featured = EXCLUDED.featured,
           developer_name = EXCLUDED.developer_name,
           updated_at = NOW()
         RETURNING id`,
        [
          manifest.slug,
          manifest.displayName,
          manifest.description,
          manifest.shortDescription,
          manifest.iconUrl ?? null,
          'active',
          manifest.version,
          manifest.minPlan,
          manifest.agentType,
          manifest.defaultVoice,
          manifest.defaultLanguage,
          JSON.stringify(manifest.supportedChannels),
          JSON.stringify(manifest.requiredTools),
          JSON.stringify(manifest.optionalTools),
          JSON.stringify(manifest.configSchema),
          JSON.stringify(manifest.tags),
          manifest.sortOrder ?? 0,
          JSON.stringify(manifest.metadata ?? {}),
          mktCategory,
          priceModel,
          priceCents,
          featured,
          developerName,
        ],
      );

      const templateId = templateResult.rows[0].id;
      console.log(`  Template ID: ${templateId}`);

      await client.query(
        `UPDATE template_versions SET is_latest = FALSE WHERE template_id = $1`,
        [templateId],
      );

      await client.query(
        `INSERT INTO template_versions (template_id, version, changelog, package_ref, release_notes, is_latest)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         ON CONFLICT (template_id, version) DO UPDATE SET
           is_latest = TRUE,
           changelog = EXCLUDED.changelog,
           package_ref = EXCLUDED.package_ref`,
        [
          templateId,
          manifest.version,
          'Initial release',
          `platform/agent-templates/${dir}`,
          'Initial release of the template.',
        ],
      );
      console.log(`  Version: ${manifest.version} (latest)`);

      for (const categoryName of manifest.category) {
        const catId = categoryIdMap[categoryName];
        if (catId) {
          await client.query(
            `INSERT INTO template_category_map (template_id, category_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [templateId, catId],
          );
          console.log(`  Category: ${categoryName}`);
        }
      }

      const existingChangelog = await client.query(
        `SELECT id FROM template_changelogs WHERE template_id = $1 AND version = $2 AND change_type = $3 AND summary = $4 LIMIT 1`,
        [templateId, manifest.version, 'added', 'Initial release'],
      );
      if (existingChangelog.rows.length === 0) {
        await client.query(
          `INSERT INTO template_changelogs (template_id, version, change_type, summary, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [templateId, manifest.version, 'added', 'Initial release', `First version of the ${manifest.displayName} template.`],
        );
      }

      const planTiers = ['starter', 'pro', 'enterprise'];
      const planIndex = planTiers.indexOf(manifest.minPlan);
      for (let i = 0; i < planTiers.length; i++) {
        await client.query(
          `INSERT INTO template_entitlements (template_id, plan_tier, enabled)
           VALUES ($1, $2, $3)
           ON CONFLICT (template_id, plan_tier) DO UPDATE SET enabled = EXCLUDED.enabled`,
          [templateId, planTiers[i], i >= planIndex],
        );
      }
      console.log(`  Entitlements set (min: ${manifest.minPlan})`);
    }

    await client.query('COMMIT');
    console.log('\nTemplate registry seeded successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to seed template registry:', err);
    throw err;
  } finally {
    client.release();
  }
}

seedTemplateRegistry()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
