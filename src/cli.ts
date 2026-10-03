#!/usr/bin/env node
/**
 * CLI `providall` : `models`, `check`, `ask`.
 *
 * Même sortie que la commande Python, à la ligne près : c'est le test le plus
 * simple qu'un seul registre sert bien les deux packages.
 *
 * La CLI est la SEULE partie qui lit des fichiers `.env` — elle est
 * l'application, pas la bibliothèque.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { complete, stream } from "./complete.js";
import {
  baseUrlFor,
  envDefaults,
  keyPresent,
  listModels,
  resolve,
} from "./config.js";
import { defaultEnv, envBool } from "./env.js";
import { ProvidallError } from "./errors.js";
import { consoleLogger } from "./log.js";
import { formatCost } from "./pricing.js";
import { PROVIDERS, priceKnown } from "./registry.js";
import type { Env, ModelSpec } from "./types.js";

const VERSION = "0.3.0";

/** `.env` puis `.env.local` (qui prime), sans écraser l'environnement du process. */
function loadEnvFiles(): string[] {
  const charges: string[] = [];
  // Ordre inverse de la priorité : `loadEnvFile` n'écrase pas ce qui existe
  // déjà, donc le plus prioritaire doit être chargé en premier.
  for (const nom of [".env.local", ".env"]) {
    const chemin = resolvePath(process.cwd(), nom);
    if (!existsSync(chemin)) continue;
    try {
      process.loadEnvFile(chemin);
      charges.push(nom);
    } catch {
      // Node < 20.12 n'a pas `loadEnvFile` : on continue sans.
    }
  }
  return charges.reverse();
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

/** Port de `table_registre()` (monumia), colonnes comprises. */
export function modelsTable(env: Env = defaultEnv(), onlyAvailable = false): string {
  const lignes: string[] = [];
  try {
    const { spec, source } = resolve(undefined, { env });
    lignes.push(`modèle par défaut : ${spec.alias} (${spec.modelId})  ← ${source}`);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    lignes.push(`modèle par défaut : aucun — ${message}`);
  }
  lignes.push("");
  lignes.push(
    `${pad("alias", 15)} ${pad("provider", 14)} ${pad("identifiant", 24)} ` +
      `${padStart("$/Mtok in/out", 15)} ${pad("clé", 5)} ${pad("id vérifié", 11)} note`,
  );
  lignes.push("-".repeat(130));

  for (const spec of listModels(env, onlyAvailable)) {
    const tarif = priceKnown(spec)
      ? `${padStart(spec.priceIn!.toFixed(2), 7)}/${pad(spec.priceOut!.toFixed(2), 7)}`
      : `${padStart("?", 7)}/${pad("?", 7)}`;
    lignes.push(
      `${pad(spec.alias, 15)} ${pad(spec.provider, 14)} ${pad(spec.modelId, 24)} ${tarif} ` +
        `${pad(keyPresent(spec, env) ? "oui" : "NON", 5)} ` +
        `${pad(spec.idVerified ? "oui" : "À VÉRIFIER", 11)} ${spec.note}`,
    );
  }

  lignes.push("");
  lignes.push("Une clé par provider :");
  lignes.push(
    "  " +
      [...PROVIDERS.values()]
        .filter((p) => p.requiresKey)
        .map((p) => `${p.name}=${p.apiKeyEnv}`)
        .join("   "),
  );
  lignes.push("");
  lignes.push("Changer de modèle : LLM_MODEL=<alias> dans .env, ou");
  lignes.push("LLM_MODEL=<provider>:<identifiant> pour un modèle hors registre");
  lignes.push("(ex. LLM_MODEL=zai:glm-5.4-flash, ou LLM_MODEL=openrouter:z-ai/glm-4.6).");
  return lignes.join("\n");
}

function describeCaps(spec: ModelSpec): string {
  const c = spec.caps;
  return (
    `tools=${c.tools} structured=${c.structured} effort=${c.effort} ` +
    `thinking=${c.thinking} vision=${c.vision} temperature=${c.temperature}`
  );
}

/** État de la configuration. Deuxième membre : tout va bien ? */
export function checkReport(
  model?: string,
  env: Env = defaultEnv(),
  loaded: string[] = [],
): [string, boolean] {
  const lignes: string[] = [];
  lignes.push(`.env chargés : ${loaded.length ? loaded.join(", ") : "aucun"}`);
  const d = envDefaults(env);
  lignes.push(
    `réglages : LLM_MAX_TOKENS=${d.maxTokens ?? "(défaut du modèle)"} ` +
      `LLM_EFFORT=${d.effort ?? "(défaut du modèle)"} ` +
      `LLM_TIMEOUT=${(d.timeoutMs ?? 600_000) / 1000}s ` +
      `LLM_RETRIES=${d.retries ?? 2}`,
  );
  lignes.push("");
  lignes.push(`${pad("provider", 16)} ${pad("clé", 5)} ${pad("variable", 22)} base url`);
  lignes.push("-".repeat(90));
  for (const p of PROVIDERS.values()) {
    const presente = !p.requiresKey || Boolean(env[p.apiKeyEnv]?.trim()) ? "oui" : "NON";
    lignes.push(
      `${pad(p.name, 16)} ${pad(presente, 5)} ${pad(p.apiKeyEnv, 22)} ${p.baseUrl || "(à poser)"}`,
    );
  }
  lignes.push("");

  try {
    const { spec, source } = resolve(model, { env });
    const [url, sourceUrl] = baseUrlFor(spec, env);
    lignes.push(`modèle actif : ${spec.alias} → ${spec.modelId}  ← ${source}`);
    lignes.push(`  provider ${spec.provider} · ${url} (${sourceUrl})`);
    lignes.push(`  caps : ${describeCaps(spec)}`);
    if (!keyPresent(spec, env)) {
      lignes.push(`  ⚠️  ${spec.apiKeyEnv} absente — ${spec.keyUrl}`);
      return [lignes.join("\n"), false];
    }
    return [lignes.join("\n"), true];
  } catch (err) {
    lignes.push(`⚠️  ${err instanceof Error ? err.message : String(err)}`);
    return [lignes.join("\n"), false];
  }
}

type Args = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): Args {
  const [command = "", ...reste] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const ALIAS: Record<string, string> = { s: "system", e: "effort", m: "model" };
  const AVEC_VALEUR = new Set(["model", "system", "effort", "max-tokens"]);

  for (let i = 0; i < reste.length; i++) {
    const brut = reste[i]!;
    if (!brut.startsWith("-")) {
      positional.push(brut);
      continue;
    }
    const nom = ALIAS[brut.replace(/^-+/, "")] ?? brut.replace(/^-+/, "");
    if (AVEC_VALEUR.has(nom)) {
      flags[nom] = reste[++i] ?? "";
    } else {
      flags[nom] = true;
    }
  }
  return { command, positional, flags };
}

const USAGE = `providall ${VERSION} — appel LLM multi-provider

  providall models [--available]
  providall check [--model X] [--ping]
  providall ask "prompt" [--model X] [--system S] [--json] [--effort E]
                         [--max-tokens N] [--stream]
`;

async function ping(model: string | undefined, env: Env): Promise<number> {
  const debut = Date.now();
  const resultat = await import("./complete.js").then((m) =>
    m.tryComplete("Réponds uniquement : OK", { model, maxTokens: 16, label: "check", env }),
  );
  if (!resultat.ok) {
    console.error(`ping : ÉCHEC — ${resultat.error.message}`);
    return 1;
  }
  const r = resultat.value;
  console.log(
    `ping : OK — ${JSON.stringify(r.text.trim().slice(0, 40))} en ` +
      `${((Date.now() - debut) / 1000).toFixed(1)}s, in=${r.usage.inputTokens} ` +
      `out=${r.usage.outputTokens} ${formatCost(r.costUsd)}`,
  );
  return 0;
}

async function ask(args: Args, env: Env): Promise<number> {
  const prompt = args.positional[0];
  if (!prompt) {
    console.error("providall ask : un prompt est requis");
    return 2;
  }
  const opts = {
    env,
    label: "ask",
    ...(typeof args.flags["model"] === "string" ? { model: args.flags["model"] } : {}),
    ...(typeof args.flags["system"] === "string" ? { system: args.flags["system"] } : {}),
    ...(typeof args.flags["effort"] === "string" ? { effort: args.flags["effort"] } : {}),
    ...(typeof args.flags["max-tokens"] === "string"
      ? { maxTokens: Number(args.flags["max-tokens"]) }
      : {}),
    ...(args.flags["json"] ? { json: true as const } : {}),
    ...(envBool("LLM_DEBUG", env) ? { logger: consoleLogger } : {}),
  };

  try {
    if (args.flags["stream"]) {
      const flux = stream(prompt, opts);
      for await (const morceau of flux) process.stdout.write(morceau);
      process.stdout.write("\n");
      metriques(await flux.response);
    } else {
      const reponse = await complete(prompt, opts);
      console.log(reponse.text);
      metriques(reponse);
    }
    return 0;
  } catch (err) {
    console.error(`échec : ${err instanceof ProvidallError ? err.message : String(err)}`);
    return 1;
  }
}

/** Métriques sur stderr : `providall ask … > f` ne contient que la réponse. */
function metriques(r: Awaited<ReturnType<typeof complete>>): void {
  console.error(
    `[${r.provider}:${r.model}] ${(r.latencyMs / 1000).toFixed(1)}s ` +
      `in=${r.usage.inputTokens} out=${r.usage.outputTokens} ${formatCost(r.costUsd)} ` +
      `finish=${r.finishReason} attempts=${r.attempts}`,
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const charges = loadEnvFiles();
  const env = defaultEnv();
  const args = parseArgs(argv);

  switch (args.command) {
    case "models":
      console.log(modelsTable(env, Boolean(args.flags["available"])));
      return 0;
    case "check": {
      const cible = typeof args.flags["model"] === "string" ? args.flags["model"] : undefined;
      const [rapport, ok] = checkReport(cible, env, charges);
      console.log(rapport);
      if (args.flags["ping"]) return ok ? await ping(cible, env) : 1;
      return ok ? 0 : 1;
    }
    case "ask":
      return await ask(args, env);
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    default:
      console.log(USAGE);
      return args.command ? 2 : 0;
  }
}

/**
 * Ne s'exécute que lancé en CLI, pas quand les tests importent ce module.
 *
 * `realpathSync` est indispensable : npm installe le binaire en LIEN
 * SYMBOLIQUE (`node_modules/.bin/providall` → `dist/cli.js`), donc
 * `process.argv[1]` est le lien et `import.meta.url` la cible. Sans résoudre
 * le lien, la CLI installée ne faisait rien du tout.
 */
function lanceEnCli(): boolean {
  const entree = process.argv[1];
  if (!entree) return false;
  try {
    return realpathSync(entree) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (lanceEnCli()) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
