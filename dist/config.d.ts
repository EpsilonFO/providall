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
 */
import type { Effort, Env, ModelSpec } from "./types.js";
export declare const DEFAULT_TIMEOUT_MS = 600000;
export declare const DEFAULT_RETRIES = 2;
/** Le modèle retenu, et POURQUOI. La raison est affichée par la CLI. */
export type Resolution = {
    spec: ModelSpec;
    source: string;
};
export type ResolveOptions = {
    role?: string;
    env?: Env;
};
/** Résout le modèle ET la raison de ce choix. */
export declare function resolve(name?: string, opts?: ResolveOptions): Resolution;
/** Le modèle actif. Point d'entrée public. */
export declare function resolveModel(name?: string, opts?: ResolveOptions): ModelSpec;
/**
 * URL de base effective, et d'où elle vient.
 *
 * `<PROVIDER>_BASE_URL` surcharge un provider connu (proxy d'entreprise) ;
 * `LLM_BASE_URL` sert au provider générique `openai_compat`.
 */
export declare function baseUrlFor(spec: ModelSpec, env?: Env): [string, string];
/** Clé du provider, `LLM_API_KEY` en repli. Vide autorisée si `requiresKey` est faux. */
export declare function apiKeyFor(spec: ModelSpec, env?: Env): string;
export declare function keyPresent(spec: ModelSpec, env?: Env): boolean;
export declare function listModels(env?: Env, onlyAvailable?: boolean): ModelSpec[];
export type EnvDefaults = {
    maxTokens?: number;
    effort?: Effort;
    temperature?: number;
    timeoutMs?: number;
    retries?: number;
};
/** Réglages globaux du `.env`, tous surchargeables à l'appel. */
export declare function envDefaults(env?: Env): EnvDefaults;
/**
 * Résumé une ligne de la config active, pour un log de démarrage.
 * Ne lève JAMAIS : elle sert justement à diagnostiquer une config cassée.
 */
export declare function describeConfig(env?: Env): string;
//# sourceMappingURL=config.d.ts.map