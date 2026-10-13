/**
 * Adaptateur System One — modèles de décision (Jev, de TypeSafe).
 *
 * Pas un troisième dialecte de chat : un autre contrat. On envoie un `state`
 * et des questions typées (`noul`, `choice`, `score`), on reçoit des
 * probabilités, jamais de texte. D'où un adaptateur à part, hors de `ADAPTERS`,
 * que seul `decide()` atteint.
 *
 * Un seul format pour deux portes : TypeSafe (`api.typesafe.ai/v1/systemone`)
 * et OpenRouter (`openrouter.ai/api/v1/systemone`), qui reprend le format à
 * l'identique et ajoute `id`, `provider` et `usage.cost`. Comme les deux autres
 * adaptateurs, `build` et `parse` sont purs.
 */
import type { DecisionState, Decision, ModelSpec, Questions } from "../types.js";
import type { BuiltRequest } from "./adapter.js";
/** Tout ce dont l'adaptateur a besoin. Aucune lecture d'environnement au-delà. */
export type DecisionRequest<Q extends Questions = Questions> = {
    spec: ModelSpec;
    state: DecisionState;
    questions: Q;
    apiKey: string;
    baseUrl: string;
    label: string;
    extraBody: Record<string, unknown> | null;
};
/**
 * `…/v1` (convention providall, comme les autres fournisseurs) ou racine nue
 * (convention des SDK TypeSafe : `TYPESAFE_BASE_URL=https://openrouter.ai/api`
 * dans la doc d'OpenRouter) : les deux mènent à `…/v1/systemone`.
 */
export declare function systemOneUrl(base: string): string;
export declare function build(req: DecisionRequest): BuiltRequest;
/**
 * Réponse native → `Decision`. Le coût, la latence et le nombre de tentatives
 * sont posés ensuite par `decide()`, comme pour `complete()`.
 *
 * Chaque question posée doit revenir, avec le bon type : une réponse partielle
 * est traitée en réponse vide inexpliquée (rejouable), pas rendue trouée à un
 * appelant qui brancherait dessus.
 */
export declare function parse<Q extends Questions>(raw: unknown, req: DecisionRequest<Q>, requestId?: string | null): Decision<Q>;
//# sourceMappingURL=systemone.d.ts.map