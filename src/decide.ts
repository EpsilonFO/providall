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

import {
  DECISION_MODEL_VAR,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  apiKeyFor,
  baseUrlFor,
  envDefaults,
  resolveDecision,
} from "./config.js";
import { defaultEnv, envBool } from "./env.js";
import { CapabilityError, ConfigError, MissingKeyError, toProvidallError } from "./errors.js";
import { postJson, retry } from "./http.js";
import { consoleLogger, decisionLogLine, silentLogger } from "./log.js";
import { computeCost } from "./pricing.js";
import { build, parse } from "./providers/systemone.js";
import type { DecisionRequest } from "./providers/systemone.js";
import { MODELS, isSystemOne } from "./registry.js";
import type {
  ChoiceQuestion,
  DecideOptions,
  Decision,
  DecisionState,
  Env,
  Instructions,
  NoulQuestion,
  Questions,
  ScoreQuestion,
  TryResult,
} from "./types.js";

/* ------------------------------------------------------------------------ */
/* Questions                                                                  */
/* ------------------------------------------------------------------------ */

/** Oui/non. `criteria` dit ce que valent un oui et un non, si ce n'est pas évident. */
export function noul(
  instructions: Instructions,
  criteria?: { true?: Instructions; false?: Instructions },
): NoulQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

/**
 * Une option parmi plusieurs. Les options viennent en liste (`["a", "b"]`)
 * ou avec leur description (`{ a: "…", b: null }`) ; leurs noms typent la
 * réponse.
 */
export function choice<const O extends string>(
  instructions: Instructions,
  options: readonly O[] | Record<O, Instructions | null>,
): ChoiceQuestion<O> {
  const criteria = Array.isArray(options)
    ? Object.fromEntries((options as readonly O[]).map((o) => [o, null]))
    : options;
  return { type: "choice", instructions, criteria: criteria as Record<O, Instructions | null> };
}

/** Position sur une échelle, du plus bas au plus haut niveau. */
export function score(instructions: Instructions, levels: Instructions[]): ScoreQuestion {
  return { type: "score", instructions, criteria: levels };
}

/**
 * Refuse avant l'envoi ce qui ne peut pas être une question. Seules les
 * règles de forme : les plafonds (255 options, 10 niveaux) sont ceux de
 * TypeSafe aujourd'hui, et un 422 nommant le champ les dira mieux qu'une copie
 * qui vieillirait ici.
 */
function checkQuestions(questions: Questions, ctx: { provider: string; model: string }): void {
  const entrees = Object.entries(questions ?? {});
  if (!entrees.length) throw new ConfigError("decide() sans aucune question", ctx);
  for (const [cle, q] of entrees) {
    const type = (q as { type?: unknown } | null)?.type;
    if (type === "choice") {
      const options = (q as ChoiceQuestion).criteria;
      if (typeof options !== "object" || options === null || !Object.keys(options).length) {
        throw new ConfigError(`question ${cle} : un choice demande au moins une option`, ctx);
      }
    } else if (type === "score") {
      const niveaux = (q as ScoreQuestion).criteria;
      if (!Array.isArray(niveaux) || niveaux.length < 2) {
        throw new ConfigError(`question ${cle} : un score demande au moins deux niveaux`, ctx);
      }
    } else if (type !== "noul") {
      throw new ConfigError(
        `question ${cle} : type ${JSON.stringify(type)} inconnu — noul, choice ou score`,
        ctx,
      );
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Préparation                                                                */
/* ------------------------------------------------------------------------ */

/** Résout tout et vérifie tout, sans rien envoyer. Le pendant de `prepare()`. */
export function prepareDecision<Q extends Questions>(
  state: DecisionState,
  questions: Q,
  opts: DecideOptions = {},
): DecisionRequest<Q> {
  const env: Env = opts.env ?? defaultEnv();
  const { spec } = resolveDecision(opts.model, { role: opts.role, env });
  const ctx = { provider: spec.provider, model: spec.alias };

  if (!isSystemOne(spec)) {
    const modeles = [...MODELS.values()]
      .filter(isSystemOne)
      .map((m) => m.alias)
      .sort()
      .join(", ");
    throw new CapabilityError("décisions System One", {
      ...ctx,
      hint: `decide() n'accepte que les modèles System One (${modeles}) : poser ${DECISION_MODEL_VAR} ou passer \`model\``,
    });
  }
  checkQuestions(questions, ctx);

  const cle = opts.apiKey ?? apiKeyFor(spec, env);
  if (!cle && spec.requiresKey) {
    throw new MissingKeyError(spec.apiKeyEnv, { provider: spec.provider, keyUrl: spec.keyUrl });
  }
  return {
    spec,
    state,
    questions,
    apiKey: cle,
    baseUrl: opts.baseUrl ?? baseUrlFor(spec, env)[0],
    label: opts.label ?? spec.alias,
    extraBody: opts.extraBody ?? null,
  };
}

/* ------------------------------------------------------------------------ */
/* decide                                                                     */
/* ------------------------------------------------------------------------ */

/** Un aller-retour. Rejette avec une `ProvidallError` typée en cas d'échec. */
export async function decide<Q extends Questions>(
  state: DecisionState,
  questions: Q,
  opts: DecideOptions = {},
): Promise<Decision<Q>> {
  const env: Env = opts.env ?? defaultEnv();
  const req = prepareDecision(state, questions, opts);
  const construit = build(req);
  const contexte = { provider: req.spec.provider, model: req.spec.alias };
  const defauts = envDefaults(env);
  const logger = opts.logger ?? (envBool("LLM_DEBUG", env) ? consoleLogger : silentLogger);
  const debut = Date.now();

  const { value, attempts } = await retry(
    { retries: opts.retries ?? defauts.retries ?? DEFAULT_RETRIES },
    async () => {
      const res = await postJson(construit.url, construit.headers, construit.body, {
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs ?? defauts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: opts.signal,
        context: contexte,
      });
      const brut: unknown = await res.json();
      return parse(brut, req, res.headers.get("x-typesafe-request-id"));
    },
    { logger, signal: opts.signal, label: req.label },
  );

  value.latencyMs = Date.now() - debut;
  value.attempts = attempts;
  // Le coût facturé, quand le fournisseur le rend, prime sur le tarif saisi.
  value.costUsd ??= computeCost(req.spec, value.usage);
  logger.info(decisionLogLine(value, req.label));
  opts.onDecision?.(value);
  return value;
}

/**
 * Ne rejette JAMAIS : `{ ok, value, error }`. Pour les traitements en lot —
 * un 529 sur un élément ne doit pas arrêter le passage sur tous les autres.
 */
export async function tryDecide<Q extends Questions>(
  state: DecisionState,
  questions: Q,
  opts: DecideOptions = {},
): Promise<TryResult<Decision<Q>>> {
  try {
    return { ok: true, value: await decide(state, questions, opts) };
  } catch (err) {
    return { ok: false, error: toProvidallError(err) };
  }
}
