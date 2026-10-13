/** Famille System One : decide(), résolution par famille, deux portes (TypeSafe, OpenRouter). */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { complete } from "../src/complete.js";
import { apiKeyFor, baseUrlFor, resolve, resolveDecision } from "../src/config.js";
import { choice, decide, noul, prepareDecision, score, tryDecide } from "../src/decide.js";
import {
  BadRequestError,
  CapabilityError,
  ConfigError,
  EmptyResponseError,
  MissingKeyError,
  UnknownModelError,
} from "../src/errors.js";
import { extractApiMessage } from "../src/http.js";
import { formatCost } from "../src/pricing.js";
import { systemOneUrl } from "../src/providers/systemone.js";
import { MODELS, PROVIDERS, priceKnown, resolveSpec } from "../src/registry.js";
import { chatReply, decisionReply, errorRes, fakeFetch } from "../src/testing.js";
import type { Decision, Env } from "../src/types.js";

const TS: Env = { TYPESAFE_API_KEY: "ts-test" };
const OR: Env = { OPENROUTER_API_KEY: "or-test" };
const MUET = { debug: () => {}, info: () => {}, warn: () => {} };

const QUESTIONS = {
  urgent: noul("Le message exprime-t-il de l'urgence ?"),
  service: choice("Quelle équipe doit traiter ?", {
    facturation: "Paiements, factures, remboursements",
    technique: "Bugs, pannes, intégrations",
  }),
  colere: score("Agacement du client ?", ["Calme", "Agacé", "Furieux"]),
};

const REPONSES = {
  urgent: { type: "noul", noul: 0.95 },
  service: {
    type: "choice",
    choice: "facturation",
    probabilities: { facturation: 0.88, technique: 0.12 },
    confidence: 0.81,
  },
  colere: {
    type: "score",
    score: 1.05,
    legend: { "0": "Calme", "1": "Agacé", "2": "Furieux" },
    probabilities: { "0": 0, "1": 0.95, "2": 0.05 },
    confidence: 0.92,
  },
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function courir<T>(promesse: Promise<T>): Promise<T> {
  promesse.catch(() => undefined);
  await vi.runAllTimersAsync();
  return promesse;
}

describe("questions", () => {
  it("les trois fabriques produisent le format du fil", () => {
    expect(noul("Urgent ?")).toEqual({ type: "noul", instructions: "Urgent ?" });
    expect(noul("Urgent ?", { true: "pressé", false: "rien" }).criteria).toEqual({
      true: "pressé",
      false: "rien",
    });
    expect(choice("Équipe ?", ["a", "b"]).criteria).toEqual({ a: null, b: null });
    expect(score("Note ?", ["bas", "haut"])).toEqual({
      type: "score",
      instructions: "Note ?",
      criteria: ["bas", "haut"],
    });
  });

  it.each([
    [{}, /aucune question/],
    [{ q: { type: "choice", instructions: "?", criteria: {} } }, /au moins une option/],
    [{ q: { type: "score", instructions: "?", criteria: ["seul"] } }, /deux niveaux/],
    [{ q: { type: "oui", instructions: "?" } }, /inconnu/],
  ])("refusées avant l'envoi : %j", (questions, motif) => {
    expect(() => prepareDecision("x", questions as never, { env: TS })).toThrow(motif);
  });
});

describe("appel nominal (TypeSafe)", () => {
  it("URL, en-tête, corps, réponses typées, version servie", async () => {
    const faux = fakeFetch([decisionReply(REPONSES, { requestId: "req_1" })]);
    const d = await courir(
      decide("Mes virements échouent depuis 3 jours.", QUESTIONS, {
        env: TS,
        fetch: faux.fetch,
        model: "jev",
      }),
    );

    expect(faux.calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(faux.calls[0]!.headers["Authorization"]).toBe("Bearer ts-test");
    expect(faux.bodies[0]).toEqual({
      model: "jev-latest",
      state: "Mes virements échouent depuis 3 jours.",
      questions: QUESTIONS,
    });

    // Typage : `service.choice` est "facturation" | "technique".
    const service: "facturation" | "technique" = d.answers.service.choice;
    expect(service).toBe("facturation");
    expect(d.answers.urgent.noul).toBe(0.95);
    expect(d.answers.colere.score).toBe(1.05);
    expect(d.model).toBe("jev-latest");
    expect(d.servedModel).toBe("jev-1.13.0");
    expect(d.alias).toBe("jev");
    expect(d.requestId).toBe("req_1");
    expect(d.attempts).toBe(1);
  });

  it("coût au tarif du registre : entrée seule, sortie gratuite", async () => {
    const faux = fakeFetch([
      decisionReply(REPONSES, { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ]);
    const d = await courir(decide("x", QUESTIONS, { env: TS, fetch: faux.fetch, model: "jev" }));
    expect(d.costUsd).toBeCloseTo(0.042);
  });

  it("state structuré et extraBody passent tels quels", async () => {
    const faux = fakeFetch([decisionReply({ urgent: REPONSES.urgent })]);
    await courir(
      decide(
        { ticket: "page blanche", tier: "enterprise" },
        { urgent: QUESTIONS.urgent },
        { env: TS, fetch: faux.fetch, model: "jev", extraBody: { trace: true } },
      ),
    );
    expect(faux.bodies[0]!["state"]).toEqual({ ticket: "page blanche", tier: "enterprise" });
    expect(faux.bodies[0]!["trace"]).toBe(true);
  });

  it("onDecision reçoit la décision finie", async () => {
    const vues: Decision[] = [];
    const faux = fakeFetch([decisionReply(REPONSES)]);
    await courir(
      decide("x", QUESTIONS, {
        env: TS,
        fetch: faux.fetch,
        model: "jev",
        onDecision: (d) => vues.push(d),
      }),
    );
    expect(vues).toHaveLength(1);
    expect(vues[0]!.costUsd).not.toBeNull();
  });
});

describe("porte OpenRouter", () => {
  it("même format, coût facturé (usage.cost) préféré au tarif", async () => {
    const faux = fakeFetch([
      decisionReply(REPONSES, {
        model: "typesafe/jev-1.13-20260917",
        id: "gen-dec-1",
        cost: 0.00003,
        inputTokens: 1_000_000,
      }),
    ]);
    const d = await courir(
      decide("x", QUESTIONS, { env: OR, fetch: faux.fetch, model: "or-jev" }),
    );
    expect(faux.calls[0]!.url).toBe("https://openrouter.ai/api/v1/systemone");
    expect(faux.calls[0]!.headers["Authorization"]).toBe("Bearer or-test");
    expect(faux.bodies[0]!["model"]).toBe("typesafe/jev-1.13");
    expect(d.costUsd).toBe(0.00003);
    expect(d.requestId).toBe("gen-dec-1");
    expect(d.servedModel).toBe("typesafe/jev-1.13-20260917");
  });

  it("racine nue façon SDK TypeSafe (TYPESAFE_BASE_URL=https://openrouter.ai/api)", () => {
    expect(systemOneUrl("https://openrouter.ai/api")).toBe(
      "https://openrouter.ai/api/v1/systemone",
    );
    expect(systemOneUrl("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/v1/systemone",
    );
    const env = { TYPESAFE_API_KEY: "sk-or", TYPESAFE_BASE_URL: "https://openrouter.ai/api" };
    const req = prepareDecision("x", QUESTIONS, { env, model: "jev" });
    expect(systemOneUrl(req.baseUrl)).toBe("https://openrouter.ai/api/v1/systemone");
  });
});

describe("erreurs et relances", () => {
  it("un 529 se rejoue", async () => {
    const faux = fakeFetch([errorRes(529, "overloaded"), decisionReply(REPONSES)]);
    const d = await courir(
      decide("x", QUESTIONS, { env: TS, fetch: faux.fetch, model: "jev", logger: MUET }),
    );
    expect(d.attempts).toBe(2);
  });

  it("un 422 nomme le champ fautif, et ne se rejoue pas", async () => {
    const corps = {
      detail: [{ loc: ["body", "questions", "colere", "criteria"], msg: "too many levels" }],
    };
    const faux = fakeFetch([new Response(JSON.stringify(corps), { status: 422 })]);
    const err = await courir(
      decide("x", QUESTIONS, { env: TS, fetch: faux.fetch, model: "jev" }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as Error).message).toContain("body.questions.colere.criteria : too many levels");
    expect(faux.calls).toHaveLength(1);
  });

  it("une réponse manquante est une réponse vide, rejouable", async () => {
    const partielle = decisionReply({ urgent: REPONSES.urgent });
    const faux = fakeFetch([partielle, decisionReply(REPONSES)]);
    const d = await courir(
      decide("x", QUESTIONS, { env: TS, fetch: faux.fetch, model: "jev", logger: MUET }),
    );
    expect(d.attempts).toBe(2);

    const toujours = fakeFetch([partielle]);
    const err = await courir(
      decide("x", QUESTIONS, {
        env: TS,
        fetch: toujours.fetch,
        model: "jev",
        logger: MUET,
        retries: 0,
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmptyResponseError);
    expect((err as Error).message).toMatch(/service.*colere/);
  });

  it("tryDecide ne rejette jamais", async () => {
    const faux = fakeFetch([errorRes(401, "bad key")]);
    const r = await courir(tryDecide("x", QUESTIONS, { env: TS, fetch: faux.fetch, model: "jev" }));
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("AuthError");
  });

  it("clé absente : nommée, avec l'URL où la prendre", () => {
    expect(() => prepareDecision("x", QUESTIONS, { env: {}, model: "jev" })).toThrow(
      MissingKeyError,
    );
    expect(() => prepareDecision("x", QUESTIONS, { env: {}, model: "jev" })).toThrow(
      /TYPESAFE_API_KEY.*console\.typesafe\.ai/,
    );
  });
});

describe("familles séparées", () => {
  it("complete() refuse un modèle System One, avant même la clé", async () => {
    const err = await complete("salut", { env: {}, model: "jev" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as Error).message).toMatch(/decide\(\)/);
  });

  it("decide() refuse un modèle de chat", () => {
    const env = { ...TS, ANTHROPIC_API_KEY: "sk-an" };
    expect(() => prepareDecision("x", QUESTIONS, { env, model: "sonnet" })).toThrow(
      CapabilityError,
    );
    expect(() => prepareDecision("x", QUESTIONS, { env, model: "sonnet" })).toThrow(
      /LLM_MODEL_DECIDE/,
    );
  });

  it("TYPESAFE_API_KEY seule : decide() part chez TypeSafe, complete() ne part nulle part", () => {
    expect(resolveDecision(undefined, { env: TS }).spec.modelId).toBe("jev-latest");
    expect(() => resolve(undefined, { env: TS })).toThrow(UnknownModelError);
  });

  it("OPENROUTER_API_KEY seule : chat d'OpenRouter pour complete(), Jev d'OpenRouter pour decide()", () => {
    expect(resolve(undefined, { env: OR }).spec.provider).toBe("openrouter");
    const r = resolveDecision(undefined, { env: OR });
    expect(r.spec.provider).toBe("openrouter_systemone");
    expect(r.spec.modelId).toBe("typesafe/jev-1.13");
    expect(r.source).toContain("OPENROUTER_API_KEY");
  });

  it("ajouter une clé TypeSafe ne casse pas le défaut implicite du chat", () => {
    const env = { ...TS, DEEPSEEK_API_KEY: "sk-ds" };
    expect(resolve(undefined, { env }).spec.provider).toBe("deepseek");
    expect(resolveDecision(undefined, { env }).spec.provider).toBe("typesafe");
  });

  it("deux clés System One : il faut trancher", () => {
    expect(() => resolveDecision(undefined, { env: { ...TS, ...OR } })).toThrow(
      /plusieurs clés System One[\s\S]*LLM_MODEL_DECIDE/,
    );
  });

  it("aucune : l'erreur dit quoi poser", () => {
    expect(() => resolveDecision(undefined, { env: {} })).toThrow(ConfigError);
    expect(() => resolveDecision(undefined, { env: {} })).toThrow(
      /LLM_MODEL_DECIDE.*jev.*or-jev[\s\S]*TYPESAFE_API_KEY ou OPENROUTER_API_KEY/,
    );
  });

  it("ordre : argument > LLM_MODEL_<ROLE> > LLM_MODEL_DECIDE > LLM_MODEL System One", () => {
    const env = { ...TS, ...OR, LLM_MODEL_DECIDE: "or-jev", LLM_MODEL_TRIAGE: "jev-1.13" };
    expect(resolveDecision("jev", { env }).spec.alias).toBe("jev");
    expect(resolveDecision(undefined, { env, role: "triage" }).spec.alias).toBe("jev-1.13");
    expect(resolveDecision(undefined, { env }).spec.alias).toBe("or-jev");
    expect(resolveDecision(undefined, { env: { ...TS, LLM_MODEL: "jev-1.13" } }).source).toBe(
      "LLM_MODEL",
    );
  });

  it("LLM_MODEL de chat : sauté par decide(), pas refusé", () => {
    const env = { ...TS, LLM_MODEL: "sonnet" };
    expect(resolveDecision(undefined, { env }).spec.provider).toBe("typesafe");
    expect(resolveDecision(undefined, { env: { ...TS, LLM_MODEL: "faute" } }).spec.alias).toBe(
      "typesafe:jev-latest",
    );
  });

  it("LLM_API_KEY et LLM_BASE_URL ne fuient jamais vers un fournisseur System One", () => {
    const env = { LLM_API_KEY: "cle-du-serveur-local", LLM_BASE_URL: "http://localhost:8000/v1" };
    const jev = resolveSpec("jev");
    expect(apiKeyFor(jev, env)).toBe("");
    expect(baseUrlFor(jev, env)[0]).toBe("https://api.typesafe.ai/v1");
    // Le chat, lui, garde ses replis.
    expect(apiKeyFor(resolveSpec("compat:x"), env)).toBe("cle-du-serveur-local");
  });
});

describe("registre", () => {
  it("deux fournisseurs, un protocole, trois modèles", () => {
    expect(PROVIDERS.get("typesafe")!.protocol).toBe("systemone");
    expect(PROVIDERS.get("openrouter_systemone")!.apiKeyEnv).toBe("OPENROUTER_API_KEY");
    for (const alias of ["jev", "jev-1.13", "or-jev"]) {
      const m = MODELS.get(alias)!;
      expect(m.priceOut).toBe(0);
      expect(priceKnown(m)).toBe(true);
      expect(m.caps.stream).toBe(false);
    }
  });

  it("l'échappatoire provider:model_id marche aussi", () => {
    const s = resolveSpec("typesafe:jev-preview");
    expect(s.protocol).toBe("systemone");
    expect(s.modelId).toBe("jev-preview");
  });
});

describe("affichage", () => {
  it("un coût de décision ne s'affiche pas $0.0000", () => {
    expect(formatCost(0.0000124)).toBe("$0.000012");
    expect(formatCost(0.00412)).toBe("$0.0041");
    expect(formatCost(0)).toBe("$0.0000");
  });

  it("422 de validation : chaque champ fautif", () => {
    const texte = JSON.stringify({
      detail: [
        { loc: ["body", "state"], msg: "Field required" },
        { loc: ["body", "model"], msg: "unknown model" },
      ],
    });
    expect(extractApiMessage(texte)).toBe(
      "body.state : Field required ; body.model : unknown model",
    );
  });
});

describe("le chat n'a pas bougé", () => {
  it("complete() nominal avec une clé TypeSafe en plus", async () => {
    const faux = fakeFetch([chatReply("bonjour")]);
    const r = await courir(
      complete("salut", {
        env: { DEEPSEEK_API_KEY: "sk", TYPESAFE_API_KEY: "ts" },
        fetch: faux.fetch,
      }),
    );
    expect(r.text).toBe("bonjour");
    expect(r.provider).toBe("deepseek");
  });
});
