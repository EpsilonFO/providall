/**
 * `decide()` — la famille System One.
 *
 *     import { decide, noul, choice, score } from "providall";
 *
 *     const d = await decide("Mes virements échouent depuis 3 jours.", {
 *       urgent: noul("Le message exprime-t-il de l'urgence ?"),
 *       service: choice("Quelle équipe doit traiter ?", {
 *         facturation: "Paiements, factures, remboursements",
 *         technique: "Bugs, pannes, intégrations",
 *       }),
 *       colere: score("Agacement du client ?", ["Calme", "Agacé", "Furieux"]),
 *     });
 *     d.answers.service.choice; // "facturation" | "technique"
 *
 * Même plomberie que `complete()` — clé, retry, erreurs typées, coût, latence,
 * faux `fetch` — mais une autre résolution du modèle (`LLM_MODEL_DECIDE`) et un
 * autre retour : des probabilités, jamais de texte. Passer de TypeSafe à
 * OpenRouter, c'est changer `LLM_MODEL_DECIDE=jev` en `or-jev`.
 */
import type { DecisionRequest } from "./providers/systemone.js";
import type { ChoiceQuestion, DecideOptions, Decision, DecisionState, Instructions, NoulQuestion, Questions, ScoreQuestion, TryResult } from "./types.js";
/** Oui/non. `criteria` dit ce que valent un oui et un non, si ce n'est pas évident. */
export declare function noul(instructions: Instructions, criteria?: {
    true?: Instructions;
    false?: Instructions;
}): NoulQuestion;
/**
 * Une option parmi plusieurs. Les options viennent en liste (`["a", "b"]`)
 * ou avec leur description (`{ a: "…", b: null }`) ; leurs noms typent la
 * réponse.
 */
export declare function choice<const O extends string>(instructions: Instructions, options: readonly O[] | Record<O, Instructions | null>): ChoiceQuestion<O>;
/** Position sur une échelle, du plus bas au plus haut niveau. */
export declare function score(instructions: Instructions, levels: Instructions[]): ScoreQuestion;
/** Résout tout et vérifie tout, sans rien envoyer. Le pendant de `prepare()`. */
export declare function prepareDecision<Q extends Questions>(state: DecisionState, questions: Q, opts?: DecideOptions): DecisionRequest<Q>;
/** Un aller-retour. Rejette avec une `ProvidallError` typée en cas d'échec. */
export declare function decide<Q extends Questions>(state: DecisionState, questions: Q, opts?: DecideOptions): Promise<Decision<Q>>;
/**
 * Ne rejette JAMAIS : `{ ok, value, error }`. Pour les traitements en lot —
 * un 529 sur un élément ne doit pas arrêter le passage sur tous les autres.
 */
export declare function tryDecide<Q extends Questions>(state: DecisionState, questions: Q, opts?: DecideOptions): Promise<TryResult<Decision<Q>>>;
//# sourceMappingURL=decide.d.ts.map