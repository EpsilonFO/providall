/**
 * Registre : providers, modèles, et l'échappatoire `provider:model_id`.
 *
 * Trois étages, du plus stable au plus volatil :
 *   - PROTOCOL_DEFAULTS : ce que le protocole garantit. Deux entrées.
 *   - providers          : protocole, adresse, nom de clé, écarts au protocole.
 *   - modèles            : alias, identifiant, tarif. Une ligne par modèle.
 *
 * Les données viennent de `registry/*.json`, partagées avec le package Python
 * et régénérées par `npm run gen`. Un modèle qui vient de sortir n'a pas besoin
 * d'entrer au registre : `LLM_MODEL=zai:glm-5.4-flash` suffit.
 */

import { UnknownModelError } from "./errors.js";
import { MODELS_DATA, PROVIDERS_DATA } from "./registry.data.js";
import type { Caps, Effort, ModelSpec, Protocol, ProviderSpec, Structured, Thinking, Wire } from "./types.js";

type RawProvider = {
  protocol: string;
  base_url?: string;
  api_key_env: string;
  aliases?: readonly string[];
  default_model?: string;
  key_url?: string;
  requires_key?: boolean;
  caps?: Partial<Record<string, unknown>>;
  wire?: Partial<Record<string, unknown>>;
  defaults?: Partial<Record<string, unknown>>;
  note?: string;
};

type RawModel = {
  provider: string;
  model_id: string;
  price_in?: number;
  price_out?: number;
  price_cache_read?: number;
  id_verified?: boolean;
  note?: string;
  overrides?: {
    caps?: Partial<Record<string, unknown>>;
    wire?: Partial<Record<string, unknown>>;
    defaults?: Partial<Record<string, unknown>>;
  };
};

type ProtocolDefaults = { caps: Caps; wire: Wire; maxTokens: number; effort: Effort | null };

/**
 * Ce que garantit chaque protocole. Un provider ne déclare que ses ÉCARTS :
 * une valeur recopiée est une valeur qui ne suivra pas la prochaine correction.
 */
export const PROTOCOL_DEFAULTS: Record<Protocol, ProtocolDefaults> = {
  anthropic: {
    caps: {
      tools: true,
      structured: "json_schema",
      effort: true,
      thinking: "adaptive",
      vision: true,
      // La famille Claude 5 rejette tout paramètre d'échantillonnage non par
      // défaut par un 400 : `temperature` est opt-in, pas opt-out.
      temperature: false,
      forced_tool_choice: true,
      stream: true,
    },
    wire: {
      maxTokensParam: "max_tokens",
      effortParam: "output_config",
      effortValues: ["low", "medium", "high", "xhigh", "max"],
    },
    maxTokens: 16000,
    effort: null,
  },
  openai_compat: {
    caps: {
      tools: true,
      // `json_object` garantit du JSON VALIDE, pas CONFORME : le schéma part
      // quand même dans le prompt système (leçon monumia).
      structured: "json_object",
      effort: false,
      thinking: "none",
      vision: true,
      temperature: true,
      forced_tool_choice: true,
      stream: true,
    },
    wire: { maxTokensParam: "max_tokens", effortParam: null, effortValues: [] },
    maxTokens: 16000,
    effort: null,
  },
};

/** Les clés du JSON sont snake_case (partagées avec Python) ; le wire est camelCase ici. */
const WIRE_KEYS: Record<string, keyof Wire> = {
  max_tokens_param: "maxTokensParam",
  effort_param: "effortParam",
  effort_values: "effortValues",
};

function mergeCaps(base: Caps, layer?: Partial<Record<string, unknown>>): Caps {
  if (!layer) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (key === "structured") out.structured = value as Structured;
    else if (key === "thinking") out.thinking = value as Thinking;
    else (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function mergeWire(base: Wire, layer?: Partial<Record<string, unknown>>): Wire {
  if (!layer) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    const cible = WIRE_KEYS[key];
    if (!cible) continue;
    if (cible === "effortValues") out.effortValues = value as readonly string[];
    else if (cible === "effortParam") out.effortParam = value as string | null;
    else out.maxTokensParam = value as string;
  }
  return out;
}

function buildProvider(name: string, data: RawProvider): ProviderSpec {
  const protocol = data.protocol as Protocol;
  const defaults = PROTOCOL_DEFAULTS[protocol];
  if (!defaults) throw new Error(`protocole inconnu dans le registre : ${data.protocol}`);
  const surcharges = data.defaults ?? {};
  return {
    name,
    protocol,
    baseUrl: data.base_url ?? "",
    apiKeyEnv: data.api_key_env,
    aliases: data.aliases ?? [],
    defaultModel: data.default_model ?? "",
    keyUrl: data.key_url ?? "",
    requiresKey: data.requires_key ?? true,
    caps: mergeCaps(defaults.caps, data.caps),
    wire: mergeWire(defaults.wire, data.wire),
    maxTokens: (surcharges["max_tokens"] as number | undefined) ?? defaults.maxTokens,
    effort: (surcharges["effort"] as Effort | null | undefined) ?? defaults.effort,
    note: data.note ?? "",
  };
}

export const PROVIDERS: Map<string, ProviderSpec> = new Map(
  Object.entries(PROVIDERS_DATA as Record<string, RawProvider>).map(([name, data]) => [
    name,
    buildProvider(name, data),
  ]),
);

export type SpecOverrides = {
  priceIn?: number | null;
  priceOut?: number | null;
  priceCacheRead?: number | null;
  idVerified?: boolean;
  note?: string;
  caps?: Partial<Record<string, unknown>>;
  wire?: Partial<Record<string, unknown>>;
  defaults?: Partial<Record<string, unknown>>;
};

/**
 * Un modèle = son alias, son fournisseur, son identifiant. Le reste est hérité.
 *
 * Exposé publiquement : c'est ce qu'un projet consommateur appelle pour
 * déclarer un modèle à lui sans toucher au dépôt.
 */
export function spec(
  alias: string,
  provider: string,
  modelId: string,
  overrides: SpecOverrides = {},
): ModelSpec {
  const p = PROVIDERS.get(provider);
  if (!p) {
    throw new UnknownModelError(
      `${provider}:${modelId}`,
      [...MODELS.keys()],
      [...PROVIDERS.keys()],
    );
  }
  const priceIn = overrides.priceIn ?? null;
  const surcharges = overrides.defaults ?? {};
  return {
    alias,
    provider,
    protocol: p.protocol,
    modelId,
    apiKeyEnv: p.apiKeyEnv,
    baseUrl: p.baseUrl,
    requiresKey: p.requiresKey,
    keyUrl: p.keyUrl,
    // On part du `ProviderSpec` DÉJÀ résolu, pas du JSON brut : sinon un
    // fournisseur enregistré à l'exécution verrait ses capacités
    // silencieusement remplacées par celles du protocole.
    caps: mergeCaps(p.caps, overrides.caps),
    wire: mergeWire(p.wire, overrides.wire),
    maxTokens: (surcharges["max_tokens"] as number | undefined) ?? p.maxTokens,
    effort: (surcharges["effort"] as Effort | null | undefined) ?? p.effort,
    priceIn,
    priceOut: overrides.priceOut ?? null,
    // Tarif de lecture de cache : un dixième de l'entrée, sauf indication
    // contraire (barème Anthropic usuel). Inconnu si le tarif l'est.
    priceCacheRead: overrides.priceCacheRead ?? (priceIn !== null ? priceIn / 10 : null),
    idVerified: overrides.idVerified ?? true,
    note: overrides.note ?? "",
  };
}

function buildModel(alias: string, data: RawModel): ModelSpec {
  return spec(alias, data.provider, data.model_id, {
    priceIn: data.price_in ?? null,
    priceOut: data.price_out ?? null,
    priceCacheRead: data.price_cache_read ?? null,
    idVerified: data.id_verified ?? true,
    note: data.note ?? "",
    caps: data.overrides?.caps,
    wire: data.overrides?.wire,
    defaults: data.overrides?.defaults,
  });
}

export const MODELS: Map<string, ModelSpec> = new Map(
  Object.entries(MODELS_DATA as Record<string, RawModel>).map(([alias, data]) => [
    alias,
    buildModel(alias, data),
  ]),
);

/* ------------------------------------------------------------------------ */
/* Enregistrement à l'exécution                                               */
/* ------------------------------------------------------------------------ */

/** Ajoute un fournisseur sans toucher au dépôt (endpoint interne, proxy…). */
export function registerProvider(provider: ProviderSpec, opts: { replace?: boolean } = {}): void {
  if (PROVIDERS.has(provider.name) && !opts.replace) {
    throw new Error(`provider déjà enregistré : ${provider.name} (replace: true pour forcer)`);
  }
  PROVIDERS.set(provider.name, provider);
}

/** Ajoute ou corrige un modèle : nouvel identifiant, tarif enfin connu… */
export function registerModel(model: ModelSpec, opts: { replace?: boolean } = {}): void {
  if (MODELS.has(model.alias) && !opts.replace) {
    throw new Error(`alias déjà enregistré : ${model.alias} (replace: true pour forcer)`);
  }
  MODELS.set(model.alias, model);
}

/* ------------------------------------------------------------------------ */
/* Résolution                                                                 */
/* ------------------------------------------------------------------------ */

/** Nom canonique ou alias (`claude` → `anthropic`, `grok` → `xai`). */
export function findProvider(name: string): ProviderSpec | undefined {
  const cle = name.trim().toLowerCase();
  const direct = PROVIDERS.get(cle);
  if (direct) return direct;
  for (const provider of PROVIDERS.values()) {
    if (provider.aliases.includes(cle)) return provider;
  }
  return undefined;
}

/**
 * Alias du registre, ou `provider:model_id` pour un modèle non inscrit.
 *
 * Ne consulte PAS l'environnement : c'est `resolveModel()` qui décide QUEL nom
 * résoudre. Séparé pour que la table du registre reste testable sans variable.
 */
export function resolveSpec(name: string): ModelSpec {
  const nom = name.trim();
  const connu = MODELS.get(nom);
  if (connu) return connu;

  const separateur = nom.indexOf(":");
  if (separateur > 0) {
    const provider = findProvider(nom.slice(0, separateur));
    const modelId = nom.slice(separateur + 1).trim();
    if (provider && modelId) {
      return spec(nom, provider.name, modelId, {
        idVerified: false,
        note: "hors registre : identifiant et tarif non vérifiés",
      });
    }
  }
  throw new UnknownModelError(nom, [...MODELS.keys()], [...PROVIDERS.keys()]);
}

export function listProviders(): ProviderSpec[] {
  return [...PROVIDERS.values()];
}

export function priceKnown(spec: ModelSpec): boolean {
  return spec.priceIn !== null && spec.priceOut !== null;
}

const ECHELLE = ["none", "low", "medium", "high", "xhigh", "max"];

/**
 * Ramène un effort à l'échelle du fournisseur plutôt que d'échouer.
 *
 * `xhigh` demandé à OpenAI (qui s'arrête à `high`) doit donner `high`, pas un
 * 400. Un appel générique ne doit pas casser en changeant de fournisseur —
 * c'est tout l'intérêt de la lib.
 */
export function clampEffort(value: Effort | null | undefined, wire: Wire): string | null {
  if (!value || wire.effortValues.length === 0) return null;
  if (wire.effortValues.includes(value)) return value;
  const voulu = ECHELLE.indexOf(value);
  if (voulu < 0) return null;
  let meilleur: string | null = null;
  let distance = Infinity;
  for (const candidat of wire.effortValues) {
    const index = ECHELLE.indexOf(candidat);
    if (index < 0) continue;
    const ecart = Math.abs(index - voulu);
    if (ecart < distance) {
      distance = ecart;
      meilleur = candidat;
    }
  }
  return meilleur;
}
