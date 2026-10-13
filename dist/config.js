/**
 * Résolution du modèle et des réglages depuis l'environnement.
 *
 * Le seul levier obligatoire est `LLM_MODEL`. Tout le reste a un défaut, et
 * l'ordre de résolution est conçu pour qu'un `.env` contenant une seule clé
 * API suffise à faire marcher `complete("bonjour")` :
 *
 *     argument explicite
 *   > LLM_MODEL_<ROLE>          (rôle passé à l'appel)
 *   > LLM_MODEL
 *   > LLM_PROVIDER              (compat agenda)
 *   > une seule clé *_API_KEY présente → defaultModel de ce provider
 *   > ConfigError listant alias et providers
 *
 * C'est la résolution de la famille chat. `decide()` a la sienne
 * (`resolveDecision`), qui ne regarde que les fournisseurs System One.
 */
import { envNum, envStr, defaultEnv, normalizeEffort } from "./env.js";
import { ConfigError, UnknownModelError } from "./errors.js";
import { MODELS, PROVIDERS, findProvider, isSystemOne, priceKnown, resolveSpec, } from "./registry.js";
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_RETRIES = 2;
function roleVar(role) {
    return `LLM_MODEL_${role.trim().toUpperCase().replace(/-/g, "_")}`;
}
/**
 * Providers dont la clé est posée, dédupliqués par nom de variable, dans UNE
 * famille.
 *
 * `zai` et `zai_anthropic` partagent `ZAI_API_KEY` : ce n'est pas une
 * ambiguïté pour l'utilisateur, on garde le premier déclaré. La famille, elle,
 * sépare : `TYPESAFE_API_KEY` seule ne doit pas faire partir `complete()` vers
 * un modèle qui ne produit pas de texte, et `OPENROUTER_API_KEY` seule désigne
 * le chat d'OpenRouter pour `complete()` ET Jev chez OpenRouter pour `decide()`.
 */
function providersWithKey(env, systemOne) {
    const vus = new Set();
    const trouves = [];
    for (const [nom, p] of PROVIDERS) {
        if (isSystemOne(p) !== systemOne)
            continue;
        // Un provider sans clé (ollama, openai_compat) n'est jamais un défaut
        // implicite : il faudrait aussi deviner base_url et modèle.
        if (!p.requiresKey || !p.defaultModel)
            continue;
        if (vus.has(p.apiKeyEnv))
            continue;
        if (envStr(p.apiKeyEnv, env)) {
            vus.add(p.apiKeyEnv);
            trouves.push(nom);
        }
    }
    return trouves;
}
/** Résout le modèle ET la raison de ce choix. */
export function resolve(name, opts = {}) {
    const env = opts.env ?? defaultEnv();
    if (name)
        return { spec: resolveSpec(name), source: "argument" };
    if (opts.role) {
        const variable = roleVar(opts.role);
        const depuisRole = envStr(variable, env);
        if (depuisRole)
            return { spec: resolveSpec(depuisRole), source: variable };
    }
    const depuisModele = envStr("LLM_MODEL", env);
    const depuisProvider = envStr("LLM_PROVIDER", env);
    if (depuisModele) {
        if (depuisProvider && !depuisModele.includes(":") && !MODELS.has(depuisModele)) {
            // Compat agenda : `LLM_PROVIDER=openai` + `LLM_MODEL=gpt-5.6-terra`
            // désignait un identifiant nu chez ce provider. Un alias du registre ou
            // une forme `provider:id` restent prioritaires sur cette lecture.
            const provider = findProvider(depuisProvider);
            if (provider) {
                return {
                    spec: resolveSpec(`${provider.name}:${depuisModele}`),
                    source: "LLM_PROVIDER + LLM_MODEL",
                };
            }
        }
        return { spec: resolveSpec(depuisModele), source: "LLM_MODEL" };
    }
    if (depuisProvider) {
        const provider = findProvider(depuisProvider);
        if (!provider) {
            throw new ConfigError(`LLM_PROVIDER=${JSON.stringify(depuisProvider)} inconnu — connus : ` +
                [...PROVIDERS.keys()].sort().join(", "));
        }
        if (!provider.defaultModel) {
            throw new ConfigError(`LLM_PROVIDER=${JSON.stringify(depuisProvider)} n'a pas de modèle par défaut : ` +
                "poser aussi LLM_MODEL (et LLM_BASE_URL pour un serveur compatible).");
        }
        return {
            spec: resolveSpec(`${provider.name}:${provider.defaultModel}`),
            source: `LLM_PROVIDER (${provider.name})`,
        };
    }
    const candidats = providersWithKey(env, false);
    if (candidats.length === 1) {
        const provider = PROVIDERS.get(candidats[0]);
        return {
            spec: resolveSpec(`${provider.name}:${provider.defaultModel}`),
            source: `seule clé présente (${provider.apiKeyEnv})`,
        };
    }
    if (candidats.length > 1) {
        throw new ConfigError("plusieurs clés API présentes (" +
            candidats.map((c) => PROVIDERS.get(c).apiKeyEnv).join(", ") +
            ") : poser LLM_MODEL pour trancher.\n" +
            `  alias du registre : ${[...MODELS.keys()].sort().join(", ")}`);
    }
    throw new UnknownModelError("(aucun)", [...MODELS.keys()], [...PROVIDERS.keys()]);
}
/** Le modèle actif. Point d'entrée public. */
export function resolveModel(name, opts = {}) {
    return resolve(name, opts).spec;
}
/** Modèle de `decide()`. Le pendant de `LLM_MODEL` pour la famille System One. */
export const DECISION_MODEL_VAR = "LLM_MODEL_DECIDE";
/**
 * Résolution de la famille System One, pour `decide()` :
 *
 *     argument explicite
 *   > LLM_MODEL_<ROLE>          (rôle passé à l'appel)
 *   > LLM_MODEL_DECIDE
 *   > LLM_MODEL, s'il désigne un modèle System One
 *   > une seule clé System One présente → defaultModel de ce provider
 *   > ConfigError
 *
 * `LLM_MODEL` désigne d'ordinaire le modèle de chat : il est SAUTÉ, pas
 * refusé, quand il n'est pas System One. Ce que désignent les trois premiers
 * étages est rendu tel quel — c'est `prepareDecision()` qui refuse un modèle
 * de chat, avec un message qui dit quoi faire.
 */
export function resolveDecision(name, opts = {}) {
    const env = opts.env ?? defaultEnv();
    if (name)
        return { spec: resolveSpec(name), source: "argument" };
    if (opts.role) {
        const variable = roleVar(opts.role);
        const depuisRole = envStr(variable, env);
        if (depuisRole)
            return { spec: resolveSpec(depuisRole), source: variable };
    }
    const dedie = envStr(DECISION_MODEL_VAR, env);
    if (dedie)
        return { spec: resolveSpec(dedie), source: DECISION_MODEL_VAR };
    const general = envStr("LLM_MODEL", env);
    if (general) {
        const s = specOrNull(general);
        if (s && isSystemOne(s))
            return { spec: s, source: "LLM_MODEL" };
    }
    const candidats = providersWithKey(env, true);
    if (candidats.length === 1) {
        const provider = PROVIDERS.get(candidats[0]);
        return {
            spec: resolveSpec(`${provider.name}:${provider.defaultModel}`),
            source: `seule clé System One présente (${provider.apiKeyEnv})`,
        };
    }
    const modeles = [...MODELS.values()]
        .filter(isSystemOne)
        .map((m) => m.alias)
        .sort()
        .join(", ");
    if (candidats.length > 1) {
        throw new ConfigError("plusieurs clés System One présentes (" +
            candidats.map((c) => PROVIDERS.get(c).apiKeyEnv).join(", ") +
            `) : poser ${DECISION_MODEL_VAR} pour trancher.\n` +
            `  modèles System One : ${modeles}`);
    }
    const cles = [
        ...new Set([...PROVIDERS.values()].filter(isSystemOne).map((p) => p.apiKeyEnv)),
    ].join(" ou ");
    throw new ConfigError(`aucun modèle System One : poser ${DECISION_MODEL_VAR} (${modeles}) ` +
        `et la clé de son fournisseur (${cles}).`);
}
function specOrNull(name) {
    try {
        return resolveSpec(name);
    }
    catch (err) {
        if (err instanceof UnknownModelError)
            return null;
        throw err;
    }
}
/**
 * URL de base effective, et d'où elle vient.
 *
 * `<PROVIDER>_BASE_URL` surcharge un provider connu (proxy d'entreprise) ;
 * `LLM_BASE_URL` sert au provider générique `openai_compat`.
 */
export function baseUrlFor(spec, env = defaultEnv()) {
    const variable = `${spec.provider.toUpperCase()}_BASE_URL`;
    const depuisProvider = envStr(variable, env);
    if (depuisProvider)
        return [depuisProvider, variable];
    // Les replis génériques `LLM_BASE_URL` et `LLM_API_KEY` désignent un serveur
    // de CHAT compatible : les appliquer à un fournisseur System One enverrait
    // la requête — ou la clé — au mauvais service.
    const generique = isSystemOne(spec) ? undefined : envStr("LLM_BASE_URL", env);
    if (generique)
        return [generique, "LLM_BASE_URL"];
    if (!spec.baseUrl) {
        throw new ConfigError(`aucune URL de base pour ${spec.provider} : poser LLM_BASE_URL (ou ${variable}).`, { provider: spec.provider, model: spec.alias });
    }
    return [spec.baseUrl, "registre"];
}
/**
 * Clé du provider, `LLM_API_KEY` en repli (famille chat seulement). Vide
 * autorisée si `requiresKey` est faux.
 */
export function apiKeyFor(spec, env = defaultEnv()) {
    const repli = isSystemOne(spec) ? undefined : envStr("LLM_API_KEY", env);
    return envStr(spec.apiKeyEnv, env) ?? repli ?? "";
}
export function keyPresent(spec, env = defaultEnv()) {
    return !spec.requiresKey || Boolean(apiKeyFor(spec, env));
}
export function listModels(env = defaultEnv(), onlyAvailable = false) {
    const tous = [...MODELS.values()];
    return onlyAvailable ? tous.filter((m) => keyPresent(m, env)) : tous;
}
/** Réglages globaux du `.env`, tous surchargeables à l'appel. */
export function envDefaults(env = defaultEnv()) {
    return {
        maxTokens: envNum("LLM_MAX_TOKENS", env),
        effort: normalizeEffort(envStr("LLM_EFFORT", env)),
        temperature: envNum("LLM_TEMPERATURE", env),
        timeoutMs: timeoutMs(env),
        retries: envNum("LLM_RETRIES", env),
    };
}
/**
 * `LLM_TIMEOUT` est en SECONDES (convention Python), `LLM_TIMEOUT_MS` en
 * millisecondes. Le second est le repli hérité d'agenda, dont le `.env.local`
 * le porte déjà.
 */
function timeoutMs(env) {
    const secondes = envNum("LLM_TIMEOUT", env);
    if (secondes !== undefined)
        return secondes * 1000;
    return envNum("LLM_TIMEOUT_MS", env);
}
/**
 * Résumé une ligne de la config active, pour un log de démarrage.
 * Ne lève JAMAIS : elle sert justement à diagnostiquer une config cassée.
 */
export function describeConfig(env = defaultEnv()) {
    try {
        const { spec, source } = resolve(undefined, { env });
        const defauts = envDefaults(env);
        const tarif = priceKnown(spec) ? `${spec.priceIn}/${spec.priceOut} $/Mtok` : "tarif inconnu";
        return (`${spec.provider} · ${spec.modelId} (${source})` +
            ` · effort ${defauts.effort ?? spec.effort ?? "défaut"}` +
            ` · ${tarif}` +
            (keyPresent(spec, env) ? "" : ` · ⚠️ ${spec.apiKeyEnv} absente`));
    }
    catch (err) {
        return `⚠️ ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    }
}
