/**
 * Extract translatable strings from `client-app/src/data/docs.ts`,
 * write them under `articles.<slug>` and `categories.<slug>` keys in
 * `client-app/src/locales/en/docs.json`, and translate them into all other
 * supported locales (es, fr, de, pt-BR) via OpenAI.
 *
 * Re-runs are idempotent: if a target locale already has a translation for
 * a given key, it is preserved.
 *
 * Usage:
 *   npx tsx scripts/translate-docs.ts
 *   npx tsx scripts/translate-docs.ts --locales=es        # only translate es
 *   npx tsx scripts/translate-docs.ts --dry-run           # write en only
 *   npx tsx scripts/translate-docs.ts --force             # overwrite existing translations
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { docArticles, docCategories } from "../client-app/src/data/docs";
import type { DocBlock } from "../client-app/src/data/docs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const localesDir = resolve(root, "client-app/src/locales");

const ALL_LOCALES = ["es", "pt-BR", "fr", "de"] as const;

type LocaleCode = (typeof ALL_LOCALES)[number];

const LANG_NAMES: Record<LocaleCode, string> = {
  es: "Spanish (Spain)",
  "pt-BR": "Brazilian Portuguese",
  fr: "French (France)",
  de: "German (Germany)",
};

interface CliFlags {
  locales: LocaleCode[];
  dryRun: boolean;
  force: boolean;
}

function parseArgs(): CliFlags {
  const args = process.argv.slice(2);
  let locales: LocaleCode[] = [...ALL_LOCALES];
  let dryRun = false;
  let force = false;
  for (const a of args) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (a.startsWith("--locales=")) {
      const val = a.slice("--locales=".length);
      locales = val.split(",").map((s) => s.trim()) as LocaleCode[];
      for (const l of locales) {
        if (!ALL_LOCALES.includes(l)) {
          throw new Error(`Unknown locale: ${l}`);
        }
      }
    }
  }
  return { locales, dryRun, force };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

type FlatKV = Record<string, string>;

function flattenBlocksToKeys(
  blocks: DocBlock[],
  baseKey: string,
  out: FlatKV,
) {
  blocks.forEach((b, i) => {
    const k = `${baseKey}.${i}`;
    switch (b.type) {
      case "p":
      case "h2":
      case "h3":
      case "callout":
        out[k] = b.text;
        break;
      case "ul":
      case "ol":
        b.items.forEach((it, j) => {
          out[`${k}.${j}`] = it;
        });
        break;
      case "video":
        if (b.caption) out[`${k}.caption`] = b.caption;
        break;
      case "common-issues":
        b.items.forEach((it, j) => {
          out[`${k}.${j}.problem`] = it.problem;
          out[`${k}.${j}.fix`] = it.fix;
        });
        break;
      case "image":
      case "code":
        // not translated through this namespace
        break;
    }
  });
}

function extractEnglish(): FlatKV {
  const flat: FlatKV = {};
  for (const cat of docCategories) {
    flat[`categories.${cat.slug}.title`] = cat.title;
    flat[`categories.${cat.slug}.description`] = cat.description;
  }
  for (const a of docArticles) {
    flat[`articles.${a.slug}.title`] = a.title;
    flat[`articles.${a.slug}.description`] = a.description;
    flattenBlocksToKeys(a.body, `articles.${a.slug}.body`, flat);
  }
  return flat;
}

// ---------------------------------------------------------------------------
// Nested JSON helpers (for docs.json files)
// ---------------------------------------------------------------------------

type NestedValue = string | { [k: string]: NestedValue };
type Nested = { [k: string]: NestedValue };

function setDeep(obj: Nested, dottedKey: string, value: string) {
  const parts = dottedKey.split(".");
  let cur: Nested = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const existing = cur[part];
    if (existing == null || typeof existing === "string") {
      cur[part] = {};
    }
    cur = cur[part] as Nested;
  }
  cur[parts[parts.length - 1]] = value;
}

function getDeep(obj: Nested, dottedKey: string): string | undefined {
  const parts = dottedKey.split(".");
  let cur: NestedValue = obj;
  for (const p of parts) {
    if (cur == null || typeof cur === "string") return undefined;
    cur = cur[p];
  }
  return typeof cur === "string" ? cur : undefined;
}

function flattenJson(obj: Nested, prefix = ""): FlatKV {
  const out: FlatKV = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      out[key] = v;
    } else if (v && typeof v === "object") {
      Object.assign(out, flattenJson(v as Nested, key));
    }
  }
  return out;
}

function loadDocsJson(locale: string): Nested {
  const path = resolve(localesDir, locale, "docs.json");
  if (!existsSync(path)) return {};
  const txt = readFileSync(path, "utf8");
  return JSON.parse(txt) as Nested;
}

function writeDocsJson(locale: string, data: Nested) {
  const path = resolve(localesDir, locale, "docs.json");
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

const apiKey = process.env.OPENAI_API_KEY;
let openai: OpenAI | null = null;
function getClient(): OpenAI {
  if (!openai) {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    openai = new OpenAI({ apiKey, timeout: 90_000, maxRetries: 2 });
  }
  return openai;
}

async function translateBatch(
  entries: Array<[string, string]>,
  locale: LocaleCode,
): Promise<Record<string, string>> {
  if (entries.length === 0) return {};
  const langName = LANG_NAMES[locale];
  const payload: Record<string, string> = {};
  for (const [k, v] of entries) payload[k] = v;

  const system = [
    `You are a professional translator localizing help-center documentation`,
    `for QVO, a Voice AI platform for businesses, into ${langName}.`,
    `Translate each value into natural, fluent ${langName} that sounds`,
    `native and is appropriate for technical product documentation.`,
    `Preserve every key exactly as given.`,
    `Preserve URLs, file paths (e.g. /docs/foo), HTTP methods, code-style`,
    `tokens (e.g. POST, JSON, ICE, SIP, REST, API, SDK, OAuth, JWT,`,
    `webhooks), file extensions, environment variable names`,
    `(e.g. OPENAI_API_KEY), and HTML/markdown markers exactly as-is.`,
    `Keep brand names ("QVO", "Twilio", "HubSpot", "Slack", "Zapier",`,
    `"Stripe", "Google", "OpenAI", "ElevenLabs", "Azure", "AWS",`,
    `"Salesforce", "Calendly", etc.) unchanged.`,
    `Keep numeric values, percentages, currency symbols, and time units`,
    `(e.g. "300 ms", "$0.05", "10s") unchanged unless localizing the unit`,
    `is grammatically required.`,
    `Do not add or remove keys. Do not add commentary.`,
    `Return a single JSON object mapping each input key to its translation.`,
  ].join(" ");

  const user = JSON.stringify(payload);

  const client = getClient();
  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content:
          `Translate the following key/value pairs into ${langName}. ` +
          `Return JSON with the same keys and translated values.\n\n` +
          user,
      },
    ],
  });

  const content = res.choices[0]?.message?.content ?? "{}";
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `Translator returned non-JSON for ${locale} batch of ${entries.length} keys`,
    );
  }
  return parsed;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function translateLocale(
  englishFlat: FlatKV,
  locale: LocaleCode,
  force: boolean,
) {
  const existing = loadDocsJson(locale);
  const existingFlat = flattenJson(existing);

  const todo: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(englishFlat)) {
    const existing = existingFlat[k];
    const hasGoodTranslation =
      typeof existing === "string" &&
      existing.length > 0 &&
      existing !== v; // treat "still equals English" as untranslated (likely a fallback)
    if (!force && hasGoodTranslation) {
      continue;
    }
    todo.push([k, v]);
  }

  if (todo.length === 0) {
    console.log(`[${locale}] up-to-date (${Object.keys(englishFlat).length} keys)`);
    return;
  }

  console.log(`[${locale}] translating ${todo.length} keys (of ${Object.keys(englishFlat).length})`);

  const out = { ...existing };
  const BATCH = 25;
  const batches = chunk(todo, BATCH);
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    let translated: Record<string, string> = {};
    let attempt = 0;
    while (attempt < 3) {
      try {
        translated = await translateBatch(batch, locale);
        break;
      } catch (err) {
        attempt++;
        console.error(
          `[${locale}] batch ${bi + 1}/${batches.length} attempt ${attempt} failed:`,
          (err as Error).message,
        );
        if (attempt >= 3) {
          console.error(`[${locale}] giving up on batch ${bi + 1}, falling back to English for these keys.`);
          translated = {};
        } else {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }
    let written = 0;
    for (const [k] of batch) {
      const t = translated[k];
      if (typeof t === "string" && t.length > 0) {
        setDeep(out, k, t);
        written++;
      } else {
        const en = englishFlat[k];
        setDeep(out, k, en);
      }
    }
    console.log(`[${locale}] batch ${bi + 1}/${batches.length}: ${written}/${batch.length} translated`);
    writeDocsJson(locale, out);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const flags = parseArgs();
  const englishFlat = extractEnglish();
  const enExisting = loadDocsJson("en");
  const enOut: Nested = { ...enExisting };
  for (const [k, v] of Object.entries(englishFlat)) {
    setDeep(enOut, k, v);
  }
  writeDocsJson("en", enOut);
  console.log(
    `[en] wrote ${Object.keys(englishFlat).length} doc keys to en/docs.json`,
  );

  if (flags.dryRun) {
    console.log("[dry-run] skipping translation");
    return;
  }

  await Promise.all(
    flags.locales.map((loc) => translateLocale(englishFlat, loc, flags.force)),
  );
  console.log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
