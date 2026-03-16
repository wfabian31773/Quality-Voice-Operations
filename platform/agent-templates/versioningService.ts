import { createLogger } from '../core/logger';

const logger = createLogger('TEMPLATE_VERSIONING');

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemVer(version: string): SemVer | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10), patch: parseInt(match[3], 10) };
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function isMajorUpgrade(from: string, to: string): boolean {
  const fromV = parseSemVer(from);
  const toV = parseSemVer(to);
  if (!fromV || !toV) return false;
  return toV.major > fromV.major;
}

export function isNewerVersion(installed: string, available: string): boolean {
  const a = parseSemVer(installed);
  const b = parseSemVer(available);
  if (!a || !b) return false;
  return compareSemVer(b, a) > 0;
}

export type UpgradeType = 'major' | 'minor' | 'patch';

export function getUpgradeType(from: string, to: string): UpgradeType | null {
  const fromV = parseSemVer(from);
  const toV = parseSemVer(to);
  if (!fromV || !toV) return null;
  if (toV.major > fromV.major) return 'major';
  if (toV.minor > fromV.minor) return 'minor';
  if (toV.patch > fromV.patch) return 'patch';
  return null;
}

export interface AvailableUpdate {
  installationId: string;
  templateId: string;
  templateSlug: string;
  templateName: string;
  installedVersion: string;
  availableVersion: string;
  upgradeType: UpgradeType;
  isMajor: boolean;
  changelog: ChangelogEntry[];
  requiresConfirmation: boolean;
}

export interface ChangelogEntry {
  version: string;
  changeType: string;
  summary: string;
  details: string | null;
  createdAt: string;
}

export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
}

export function validateVersionFormat(version: string): boolean {
  return parseSemVer(version) !== null;
}

export function runPrePublicationValidation(template: {
  slug: string;
  requiredTools: string[];
  configSchema: Record<string, unknown>;
  description: string;
}, version: {
  version: string;
  changelog: string;
}): ValidationResult {
  const checks: ValidationCheck[] = [];

  const semver = parseSemVer(version.version);
  checks.push({
    name: 'version_format',
    passed: semver !== null,
    message: semver ? `Valid semantic version: ${version.version}` : `Invalid version format: ${version.version}`,
  });

  checks.push({
    name: 'template_description',
    passed: template.description.length >= 10,
    message: template.description.length >= 10
      ? 'Template has a sufficient description'
      : 'Template description is too short (minimum 10 characters)',
  });

  checks.push({
    name: 'changelog_present',
    passed: version.changelog.length > 0,
    message: version.changelog.length > 0
      ? 'Changelog is present'
      : 'Changelog is missing — required for publication',
  });

  const hasTools = template.requiredTools.length > 0;
  checks.push({
    name: 'tool_registry',
    passed: hasTools,
    message: hasTools
      ? `Template declares ${template.requiredTools.length} required tool(s)`
      : 'No required tools declared (warning — template may have limited functionality)',
  });

  const hasConfigSchema = Object.keys(template.configSchema).length > 0;
  checks.push({
    name: 'config_schema',
    passed: hasConfigSchema,
    message: hasConfigSchema
      ? 'Configuration schema is defined'
      : 'No configuration schema defined (warning — tenants cannot customize)',
  });

  checks.push({
    name: 'slug_valid',
    passed: /^[a-z0-9-]+$/.test(template.slug),
    message: /^[a-z0-9-]+$/.test(template.slug)
      ? 'Template slug is valid'
      : 'Template slug contains invalid characters',
  });

  const criticalChecks = ['version_format', 'changelog_present', 'slug_valid'];
  const valid = checks.filter(c => criticalChecks.includes(c.name)).every(c => c.passed);

  logger.info('Pre-publication validation completed', {
    templateSlug: template.slug,
    version: version.version,
    valid,
    passedCount: checks.filter(c => c.passed).length,
    totalChecks: checks.length,
  });

  return { valid, checks };
}

export function validateUpgradeCompatibility(
  installedVersion: string,
  targetVersion: string,
  tenantConfig: Record<string, unknown>,
  templateConfigSchema: Record<string, unknown>,
): ValidationResult {
  const checks: ValidationCheck[] = [];

  const upgradeType = getUpgradeType(installedVersion, targetVersion);
  checks.push({
    name: 'version_order',
    passed: upgradeType !== null,
    message: upgradeType
      ? `Valid ${upgradeType} upgrade from ${installedVersion} to ${targetVersion}`
      : `Cannot upgrade: ${targetVersion} is not newer than ${installedVersion}`,
  });

  if (upgradeType === 'major') {
    checks.push({
      name: 'major_upgrade_warning',
      passed: true,
      message: 'Major version upgrade — may include breaking changes. Tenant confirmation required.',
    });
  }

  const schemaProperties = (templateConfigSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const configKeys = Object.keys(tenantConfig);
  const schemaKeys = Object.keys(schemaProperties);
  const removedKeys = configKeys.filter(k => !schemaKeys.includes(k) && schemaKeys.length > 0);

  if (removedKeys.length > 0) {
    checks.push({
      name: 'config_compatibility',
      passed: upgradeType !== 'patch',
      message: `Tenant config keys not in new schema: ${removedKeys.join(', ')}. These will be preserved but may not be used.`,
    });
  } else {
    checks.push({
      name: 'config_compatibility',
      passed: true,
      message: 'Tenant configuration is compatible with the new version',
    });
  }

  const valid = checks.every(c => c.passed);

  return { valid, checks };
}
