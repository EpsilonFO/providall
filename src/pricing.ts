/**
 * Coût d'un appel. `null` quand le tarif est inconnu — jamais un faux 0.
 *
 * Un 0,00 $ affiché pour un modèle dont on n'a pas saisi le tarif est pire que
 * pas de chiffre du tout : il se retrouve additionné dans un rapport de
 * benchmark et fausse la comparaison sans que personne ne le voie.
 */

import { priceKnown } from "./registry.js";
import type { ModelSpec, Usage } from "./types.js";

/** L'écriture de cache est facturée 1,25× le tarif d'entrée chez Anthropic. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

export function computeCost(spec: ModelSpec, usage: Usage): number | null {
  if (!priceKnown(spec)) return null;
  const prixIn = spec.priceIn ?? 0;
  const prixOut = spec.priceOut ?? 0;
  const prixCache = spec.priceCacheRead ?? prixIn / 10;
  return (
    (usage.inputTokens * prixIn +
      usage.cacheReadTokens * prixCache +
      usage.cacheWriteTokens * prixIn * CACHE_WRITE_MULTIPLIER +
      usage.outputTokens * prixOut) /
    1e6
  );
}

export function formatCost(cost: number | null): string {
  // Quatre décimales : un appel court coûte quelques dixièmes de centime, et
  // « $0.00 » ne dit rien.
  return cost === null ? "$?" : `$${cost.toFixed(4)}`;
}

/** Somme de coûts : `null` (tarif inconnu) contamine, il ne vaut pas zéro. */
export function addCost(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}
