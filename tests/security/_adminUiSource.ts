import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Platform-admin support / docs-feedback UI used to live entirely in
 * `PlatformAdmin.tsx`. The inbox, bounce panel, and docs-feedback tab now
 * span a few sibling modules plus the English admin locale file. Source
 * contract tests that used to grep one file need the concatenated surface.
 */
const ADMIN_UI_FILES = [
  'client-app/src/pages/PlatformAdmin.tsx',
  'client-app/src/pages/admin/dashboard/panels/DocsFeedbackTab.tsx',
  'client-app/src/pages/admin/dashboard/PlatformAdminLayout.tsx',
  'client-app/src/pages/admin/dashboard/routes/SupportRoute.tsx',
  'client-app/src/locales/en/admin.json',
  'client-app/src/lib/smtpErrorClass.ts',
] as const;

export function readAdminUiSource(): string {
  return ADMIN_UI_FILES.map((rel) => readFileSync(join(process.cwd(), rel), 'utf8')).join('\n');
}
