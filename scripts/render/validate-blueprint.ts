/**
 * Validate render.yaml against Render's published Blueprint JSON Schema.
 *
 *   npx tsx scripts/render/validate-blueprint.ts            # vendored snapshot
 *   npx tsx scripts/render/validate-blueprint.ts --remote   # fetch the live schema
 *
 * The snapshot (scripts/render/render.yaml.schema.json) was fetched from
 * https://render.com/schema/render.yaml.json on 2026-10-16. Used by
 * scripts/render/renderBlueprint.test.ts. `render blueprints validate` (CLI
 * v2.7+) is the authoritative check when the CLI is available.
 */
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

// js-yaml ships without bundled types and @types/js-yaml is not installed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml: { load: (src: string) => unknown } = require('js-yaml');

export const SCHEMA_URL = 'https://render.com/schema/render.yaml.json';
const ROOT = path.resolve(__dirname, '../..');

export function loadBlueprint(file = path.join(ROOT, 'render.yaml')): unknown {
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

export function loadVendoredSchema(): object {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'render.yaml.schema.json'), 'utf8'));
}

export function validateBlueprint(doc: unknown, schema: object): { valid: boolean; errors: string[] } {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(doc) as boolean;
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
  return { valid, errors };
}

if (require.main === module) {
  (async () => {
    const remote = process.argv.includes('--remote');
    const schema = remote ? ((await (await fetch(SCHEMA_URL)).json()) as object) : loadVendoredSchema();
    const result = validateBlueprint(loadBlueprint(), schema);
    console.log(`render.yaml vs ${remote ? SCHEMA_URL : 'vendored schema snapshot'}: ${result.valid ? 'VALID' : 'INVALID'}`);
    for (const e of result.errors) console.log(`  ${e}`);
    process.exit(result.valid ? 0 : 1);
  })();
}
