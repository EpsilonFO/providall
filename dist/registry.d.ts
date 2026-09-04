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
import type { Caps, Effort, ModelSpec, Protocol, ProviderSpec, Wire } from "./types.js";
type ProtocolDefaults = {
    caps: Caps;
    wire: Wire;
    maxTokens: number;
    effort: Effort | null;
};
/**
 * Ce que garantit chaque protocole. Un provider ne déclare que ses ÉCARTS :
 * une valeur recopiée est une valeur qui ne suivra pas la prochaine correction.
 */
export declare const PROTOCOL_DEFAULTS: Record<Protocol, ProtocolDefaults>;
export declare const PROVIDERS: Map<string, ProviderSpec>;
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
export declare function spec(alias: string, provider: string, modelId: string, overrides?: SpecOverrides): ModelSpec;
export declare const MODELS: Map<string, ModelSpec>;
/** Ajoute un fournisseur sans toucher au dépôt (endpoint interne, proxy…). */
export declare function registerProvider(provider: ProviderSpec, opts?: {
    replace?: boolean;
}): void;
/** Ajoute ou corrige un modèle : nouvel identifiant, tarif enfin connu… */
export declare function registerModel(model: ModelSpec, opts?: {
    replace?: boolean;
}): void;
/** Nom canonique ou alias (`claude` → `anthropic`, `grok` → `xai`). */
export declare function findProvider(name: string): ProviderSpec | undefined;
/**
 * Alias du registre, ou `provider:model_id` pour un modèle non inscrit.
 *
 * Ne consulte PAS l'environnement : c'est `resolveModel()` qui décide QUEL nom
 * résoudre. Séparé pour que la table du registre reste testable sans variable.
 */
export declare function resolveSpec(name: string): ModelSpec;
export declare function listProviders(): ProviderSpec[];
export declare function priceKnown(spec: ModelSpec): boolean;
/**
 * Ramène un effort à l'échelle du fournisseur plutôt que d'échouer.
 *
 * `xhigh` demandé à OpenAI (qui s'arrête à `high`) doit donner `high`, pas un
 * 400. Un appel générique ne doit pas casser en changeant de fournisseur —
 * c'est tout l'intérêt de la lib.
 */
export declare function clampEffort(value: Effort | null | undefined, wire: Wire): string | null;
export {};
//# sourceMappingURL=registry.d.ts.map