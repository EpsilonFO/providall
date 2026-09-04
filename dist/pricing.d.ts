/**
 * Coût d'un appel. `null` quand le tarif est inconnu — jamais un faux 0.
 *
 * Un 0,00 $ affiché pour un modèle dont on n'a pas saisi le tarif est pire que
 * pas de chiffre du tout : il se retrouve additionné dans un rapport de
 * benchmark et fausse la comparaison sans que personne ne le voie.
 */
import type { ModelSpec, Usage } from "./types.js";
/** L'écriture de cache est facturée 1,25× le tarif d'entrée chez Anthropic. */
export declare const CACHE_WRITE_MULTIPLIER = 1.25;
export declare function computeCost(spec: ModelSpec, usage: Usage): number | null;
export declare function formatCost(cost: number | null): string;
/** Somme de coûts : `null` (tarif inconnu) contamine, il ne vaut pas zéro. */
export declare function addCost(a: number | null, b: number | null): number | null;
//# sourceMappingURL=pricing.d.ts.map