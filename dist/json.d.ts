/**
 * Sortie JSON validée, avec boucle de réparation.
 *
 * Trois couches, de la plus dure à la plus molle, parce qu'aucune ne suffit
 * seule :
 *
 * 1. La contrainte du fournisseur (`output_config.format`, `response_format`
 *    json_schema strict) — mais elle exige un JSON Schema, que Standard Schema
 *    n'expose pas : à passer via `jsonSchema` (`z.toJSONSchema(MonSchema)`).
 * 2. Le schéma dans le prompt système, dès qu'un `jsonSchema` est fourni.
 * 3. La validation côté lib, puis la RÉPARATION : on renvoie au modèle la
 *    liste de ses erreurs et on redemande. Port de `planner/llm.ts` (agenda),
 *    où deux réparations suffisent dans la quasi-totalité des cas.
 *
 * Sans `jsonSchema`, seules les couches 3 (et le mode JSON générique) jouent —
 * et ça marche : c'est la boucle de réparation qui fait le gros du travail.
 *
 * Jamais de préremplissage assistant pour forcer le `{` : refusé par un 400
 * sur toute la famille Claude 4.6+.
 */
import type { CompleteOptions, JsonSchema, Prompt, Response, Schema, TryResult } from "./types.js";
export declare const REPAIR_PROMPT: string;
export declare const DEFAULT_MAX_REPAIRS = 2;
export type JsonOptions = Omit<CompleteOptions, "json"> & {
    /**
     * JSON Schema à imposer au fournisseur. Sans lui, la contrainte native est
     * perdue mais la validation et la réparation restent : `z.toJSONSchema(S)`.
     */
    jsonSchema?: JsonSchema;
    /** Nombre de RÉPARATIONS après le premier essai (défaut 2). */
    maxRepairs?: number;
};
export type JsonResult<T> = {
    data: T;
    response: Response;
    attempts: number;
};
/** Réponse validée par le schéma. Rejette `OutputValidationError` si rien ne passe. */
export declare function completeJson<T>(schema: Schema<T>, input: Prompt, opts?: JsonOptions): Promise<T>;
/** Comme `completeJson`, mais rend aussi la `Response` et le nombre d'essais. */
export declare function completeJsonResult<T>(schema: Schema<T>, input: Prompt, opts?: JsonOptions): Promise<JsonResult<T>>;
/** Ne rejette jamais. */
export declare function tryCompleteJson<T>(schema: Schema<T>, input: Prompt, opts?: JsonOptions): Promise<TryResult<JsonResult<T>>>;
//# sourceMappingURL=json.d.ts.map