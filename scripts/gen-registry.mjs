#!/usr/bin/env node
/**
 * registry/*.json → src/registry.data.ts + python/src/providall/_registry_data.py
 *
 * Le registre est de la DONNÉE, pas du code : un modèle qui sort se déclare en
 * une ligne de JSON, et les deux packages en héritent au même commit. Ce script
 * est le seul endroit qui connaît les deux syntaxes.
 *
 *   node scripts/gen-registry.mjs           écrit les deux fichiers
 *   node scripts/gen-registry.mjs --check   échoue si l'un d'eux est périmé (CI)
 *
 * Node pur, zéro dépendance : il tourne avant `npm install`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

const BANNER_LINES = [
  "GÉNÉRÉ PAR scripts/gen-registry.mjs — NE PAS ÉDITER À LA MAIN.",
  "",
  "Source : registry/providers.json et registry/models.json.",
  "Régénérer : npm run gen (ou node scripts/gen-registry.mjs).",
];

/** Retire les clés de documentation (`$comment`) avant génération. */
function loadJson(name) {
  const raw = JSON.parse(readFileSync(join(ROOT, "registry", name), "utf8"));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("$")) continue;
    out[k] = v;
  }
  return out;
}

const providers = loadJson("providers.json");
const models = loadJson("models.json");

/* ------------------------------- validation ------------------------------ */

const PROTOCOLS = new Set(["anthropic", "openai_compat"]);
const CAP_KEYS = new Set([
  "tools",
  "structured",
  "effort",
  "thinking",
  "vision",
  "temperature",
  "forced_tool_choice",
  "stream",
]);
const WIRE_KEYS = new Set([
  "max_tokens_param",
  "effort_param",
  "effort_values",
  "thinking_toggle",
]);
const DEFAULT_KEYS = new Set(["max_tokens", "effort"]);

const errors = [];
const seenAliases = new Map();

for (const [name, p] of Object.entries(providers)) {
  if (!PROTOCOLS.has(p.protocol)) {
    errors.push(`provider ${name}: protocole inconnu ${JSON.stringify(p.protocol)}`);
  }
  if (!p.api_key_env) errors.push(`provider ${name}: api_key_env manquant`);
  for (const key of Object.keys(p.caps ?? {})) {
    if (!CAP_KEYS.has(key)) errors.push(`provider ${name}: cap inconnue ${key}`);
  }
  for (const key of Object.keys(p.wire ?? {})) {
    if (!WIRE_KEYS.has(key)) errors.push(`provider ${name}: clé wire inconnue ${key}`);
  }
  for (const key of Object.keys(p.defaults ?? {})) {
    if (!DEFAULT_KEYS.has(key)) errors.push(`provider ${name}: défaut inconnu ${key}`);
  }
  for (const alias of [name, ...(p.aliases ?? [])]) {
    // Un alias en double ferait dépendre la résolution de l'ordre des clés.
    if (seenAliases.has(alias)) {
      errors.push(`alias de provider en double : ${alias} (${seenAliases.get(alias)} et ${name})`);
    }
    seenAliases.set(alias, name);
  }
}

for (const [alias, m] of Object.entries(models)) {
  if (!providers[m.provider]) {
    errors.push(`modèle ${alias}: provider inconnu ${JSON.stringify(m.provider)}`);
  }
  if (!m.model_id) errors.push(`modèle ${alias}: model_id manquant`);
  if (alias.includes(":")) {
    // `provider:model_id` est l'échappatoire hors registre : un alias qui
    // contient « : » serait inatteignable.
    errors.push(`modèle ${alias}: un alias ne peut pas contenir « : »`);
  }
  if (m.price_in === 0 || m.price_out === 0) {
    errors.push(`modèle ${alias}: prix à 0 — omettre le champ pour dire « inconnu »`);
  }
  for (const key of Object.keys(m.overrides?.caps ?? {})) {
    if (!CAP_KEYS.has(key)) errors.push(`modèle ${alias}: cap inconnue ${key}`);
  }
  for (const key of Object.keys(m.overrides?.wire ?? {})) {
    if (!WIRE_KEYS.has(key)) errors.push(`modèle ${alias}: clé wire inconnue ${key}`);
  }
  for (const key of Object.keys(m.overrides?.defaults ?? {})) {
    if (!DEFAULT_KEYS.has(key)) errors.push(`modèle ${alias}: défaut inconnu ${key}`);
  }
}

if (errors.length) {
  console.error("registry invalide :\n  " + errors.join("\n  "));
  process.exit(1);
}

/* ------------------------------ génération TS ---------------------------- */

function tsBanner() {
  return "/**\n" + BANNER_LINES.map((l) => ` * ${l}`.trimEnd()).join("\n") + "\n */\n";
}

const tsSource =
  tsBanner() +
  "\n" +
  "export const PROVIDERS_DATA = " +
  JSON.stringify(providers, null, 2) +
  " as const;\n\n" +
  "export const MODELS_DATA = " +
  JSON.stringify(models, null, 2) +
  " as const;\n\n" +
  "/** Alias du registre, en type littéral : une faute de frappe se voit à la compilation. */\n" +
  "export type ModelAlias = keyof typeof MODELS_DATA;\n" +
  "export type ProviderName = keyof typeof PROVIDERS_DATA;\n";

/* ---------------------------- génération Python -------------------------- */

/** JSON → littéral Python. Pas de `json.loads` à l'import : le module reste lisible. */
function py(value, indent = 0) {
  const pad = " ".repeat(indent);
  const padIn = " ".repeat(indent + 4);
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return (
      "[\n" + value.map((v) => padIn + py(v, indent + 4) + ",").join("\n") + "\n" + pad + "]"
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  return (
    "{\n" +
    entries.map(([k, v]) => `${padIn}${JSON.stringify(k)}: ${py(v, indent + 4)},`).join("\n") +
    "\n" +
    pad +
    "}"
  );
}

const pySource =
  '"""' +
  BANNER_LINES.join("\n") +
  '"""\n\nfrom typing import Any\n\n' +
  "PROVIDERS_DATA: dict[str, dict[str, Any]] = " +
  py(providers) +
  "\n\nMODELS_DATA: dict[str, dict[str, Any]] = " +
  py(models) +
  "\n";

/* ------------------------------- écriture -------------------------------- */

const targets = [
  { path: join(ROOT, "src", "registry.data.ts"), source: tsSource },
  { path: join(ROOT, "python", "src", "providall", "_registry_data.py"), source: pySource },
];

let stale = 0;
for (const { path, source } of targets) {
  let current = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    /* le fichier n'existe pas encore */
  }
  if (current === source) continue;
  stale++;
  if (CHECK) {
    console.error(`périmé : ${path.slice(ROOT.length + 1)} — lancer \`npm run gen\``);
  } else {
    writeFileSync(path, source);
    console.log(`écrit : ${path.slice(ROOT.length + 1)}`);
  }
}

if (CHECK && stale) process.exit(1);
if (!stale) console.log(`registry à jour (${Object.keys(models).length} modèles, ${Object.keys(providers).length} providers)`);
