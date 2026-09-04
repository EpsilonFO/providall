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

import { complete } from "./complete.js";
import { OutputValidationError, toProvidallError } from "./errors.js";
import { parseJsonLoose, validate } from "./schema.js";
import type { CompleteOptions, JsonSchema, Message, Prompt, Response, Schema, TryResult } from "./types.js";

export const REPAIR_PROMPT =
  "Ta réponse ne respecte pas le format attendu :\n{issues}\n" +
  "Renvoie UNIQUEMENT l'objet JSON corrigé, sans texte autour.";

export const DEFAULT_MAX_REPAIRS = 2;

export type JsonOptions = Omit<CompleteOptions, "json"> & {
  /**
   * JSON Schema à imposer au fournisseur. Sans lui, la contrainte native est
   * perdue mais la validation et la réparation restent : `z.toJSONSchema(S)`.
   */
  jsonSchema?: JsonSchema;
  /** Nombre de RÉPARATIONS après le premier essai (défaut 2). */
  maxRepairs?: number;
};

export type JsonResult<T> = { data: T; response: Response; attempts: number };

/** Réponse validée par le schéma. Rejette `OutputValidationError` si rien ne passe. */
export async function completeJson<T>(
  schema: Schema<T>,
  input: Prompt,
  opts: JsonOptions = {},
): Promise<T> {
  return (await completeJsonResult(schema, input, opts)).data;
}

/** Comme `completeJson`, mais rend aussi la `Response` et le nombre d'essais. */
export async function completeJsonResult<T>(
  schema: Schema<T>,
  input: Prompt,
  opts: JsonOptions = {},
): Promise<JsonResult<T>> {
  const { jsonSchema, maxRepairs = DEFAULT_MAX_REPAIRS, ...reste } = opts;
  const conversation: Message[] = toMessages(input);
  let derniersSoucis = "";
  let dernierTexte = "";
  let derniere: Response | undefined;

  for (let tentative = 0; tentative <= maxRepairs; tentative++) {
    const reponse = await complete(conversation, { ...reste, json: jsonSchema ?? true });
    derniere = reponse;
    dernierTexte = reponse.text;

    const donnees = parseJsonLoose(dernierTexte);
    if (donnees !== null) {
      const resultat = await validate(schema, donnees);
      if (resultat.issues === undefined) {
        return { data: resultat.data, response: reponse, attempts: tentative + 1 };
      }
      derniersSoucis = resultat.issues;
    } else {
      derniersSoucis = "- la réponse n'est pas du JSON parsable";
    }

    // On garde la réponse fautive dans l'historique : sans elle le modèle ne
    // sait pas ce qu'on lui reproche, et il refait souvent la même erreur.
    conversation.push({ role: "assistant", content: dernierTexte });
    conversation.push({
      role: "user",
      content: REPAIR_PROMPT.replace("{issues}", derniersSoucis),
    });
  }

  throw new OutputValidationError(
    `sortie invalide après ${maxRepairs + 1} tentative(s) :\n${derniersSoucis}`,
    {
      attempts: maxRepairs + 1,
      issues: derniersSoucis,
      lastText: dernierTexte,
      provider: derniere?.provider,
      model: derniere?.model,
    },
  );
}

/** Ne rejette jamais. */
export async function tryCompleteJson<T>(
  schema: Schema<T>,
  input: Prompt,
  opts: JsonOptions = {},
): Promise<TryResult<JsonResult<T>>> {
  try {
    return { ok: true, value: await completeJsonResult(schema, input, opts) };
  } catch (err) {
    return { ok: false, error: toProvidallError(err) };
  }
}

function toMessages(input: Prompt): Message[] {
  return typeof input === "string" ? [{ role: "user", content: input }] : [...input];
}
