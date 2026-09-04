/**
 * Adaptateur Anthropic — API Messages native (/v1/messages).
 *
 * Jamais via une couche compatible OpenAI : elle masque `output_config.format`,
 * `output_config.effort`, le raisonnement adaptatif et `stop_reason=refusal`,
 * qui sont exactement les quatre raisons d'utiliser Anthropic.
 *
 * C'est la traduction la plus éloignée du pivot :
 *   - le prompt système est un champ à part, pas un message ;
 *   - les appels d'outils sont des blocs `tool_use` dans le contenu assistant,
 *     et les résultats des blocs `tool_result` dans un message **user** ;
 *   - `max_tokens` est obligatoire ;
 *   - les rôles doivent alterner, donc plusieurs réponses d'outils
 *     consécutives se regroupent dans un seul message.
 *
 * Le raisonnement produit des blocs signés qu'il faut renvoyer intacts au tour
 * suivant : d'où le rejeu verbatim de `Message._raw`.
 */
import type { Message, Response } from "../types.js";
import type { Adapter, BuiltRequest, Request } from "./adapter.js";
export declare const API_VERSION = "2023-06-01";
export declare const PROVIDER_TAG = "anthropic";
type Block = Record<string, unknown>;
/**
 * Effort → budget de raisonnement, pour les modèles d'avant la 4.6 qui ne
 * connaissent que `budget_tokens` (Haiku 4.5). Sur la famille 5,
 * `budget_tokens` répond 400 : c'est `output_config.effort` qui règle la
 * profondeur.
 */
export declare const THINKING_BUDGET: Record<string, number>;
export declare function build(req: Request): BuiltRequest;
/** Pivot → messages Anthropic, rôles alternés et `tool_result` groupés. */
export declare function toNativeMessages(messages: Message[]): Block[];
export declare function parse(raw: unknown, req: Request): Response;
export declare const ADAPTER: Adapter;
export {};
//# sourceMappingURL=anthropic.d.ts.map