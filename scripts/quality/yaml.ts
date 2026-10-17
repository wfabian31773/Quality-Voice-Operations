import { createRequire } from 'node:module';

// js-yaml ships without bundled types and @types/js-yaml is not installed.
const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load: (src: string) => unknown };

export function loadYaml(src: string): unknown {
  return yaml.load(src);
}
