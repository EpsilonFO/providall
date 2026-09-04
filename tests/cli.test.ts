/** CLI : table du registre, contrôle, analyse d'arguments. */

import { describe, expect, it } from "vitest";

import { checkReport, modelsTable, parseArgs } from "../src/cli.js";
import { logLine } from "../src/log.js";
import { computeCost, formatCost } from "../src/pricing.js";
import { resolveSpec, spec } from "../src/registry.js";
import type { Env, Response, Usage } from "../src/types.js";

const VIDE: Env = {};

function usage(partial: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...partial,
  };
}

describe("modelsTable", () => {
  it("liste tous les modèles et rappelle la syntaxe", () => {
    const table = modelsTable(VIDE);
    expect(table).toContain("sonnet");
    expect(table).toContain("claude-sonnet-5");
    expect(table).toContain("ds-flash");
    // Les ids tiers non confirmés sont signalés, comme chez monumia.
    expect(table).toContain("À VÉRIFIER");
    expect(table).toContain("LLM_MODEL=<provider>:<identifiant>");
  });

  it("affiche le défaut et sa source", () => {
    expect(modelsTable(VIDE).split("\n")[0]).toContain("aucun");
    const avec = modelsTable({ LLM_MODEL: "haiku" }).split("\n")[0]!;
    expect(avec).toContain("modèle par défaut : haiku");
    expect(avec).toContain("LLM_MODEL");
  });

  it("un tarif inconnu s'affiche « ? », pas « 0.00 »", () => {
    const ligne = modelsTable(VIDE)
      .split("\n")
      .find((l) => l.startsWith("glm-flash"))!;
    expect(ligne).toContain("?");
    expect(ligne).not.toContain("0.00");
  });

  it("--available filtre sur la clé", () => {
    expect(modelsTable(VIDE, true)).not.toContain("sonnet ");
    const table = modelsTable({ ANTHROPIC_API_KEY: "sk-x" }, true);
    expect(table).toContain("sonnet");
    expect(table).not.toContain("ds-flash");
  });
});

describe("checkReport", () => {
  it("sans clé : échec, et la table des providers", () => {
    const [rapport, ok] = checkReport(undefined, VIDE);
    expect(ok).toBe(false);
    expect(rapport).toContain("anthropic");
    expect(rapport).toContain("NON");
  });

  it("avec clé : succès, modèle actif et capacités", () => {
    const [rapport, ok] = checkReport(undefined, { ANTHROPIC_API_KEY: "sk-x" });
    expect(ok).toBe(true);
    expect(rapport).toContain("claude-sonnet-5");
    expect(rapport).toContain("seule clé présente");
    expect(rapport).toContain("structured=json_schema");
  });

  it("signale la clé absente du modèle demandé", () => {
    const [rapport, ok] = checkReport("ds-flash", { ANTHROPIC_API_KEY: "sk-x" });
    expect(ok).toBe(false);
    expect(rapport).toContain("DEEPSEEK_API_KEY absente");
  });

  it("montre la source de l'URL de base", () => {
    const [rapport] = checkReport(undefined, {
      ANTHROPIC_API_KEY: "sk-x",
      ANTHROPIC_BASE_URL: "http://proxy/v1",
    });
    expect(rapport).toContain("http://proxy/v1 (ANTHROPIC_BASE_URL)");
  });

  it("liste les .env chargés", () => {
    expect(checkReport(undefined, VIDE, [".env"])[0]).toContain(".env chargés : .env");
    expect(checkReport(undefined, VIDE)[0]).toContain("aucun");
  });
});

describe("parseArgs", () => {
  it("commande, positionnels, drapeaux et alias courts", () => {
    const args = parseArgs([
      "ask",
      "mon prompt",
      "--model",
      "sonnet",
      "-s",
      "Système",
      "--json",
      "-e",
      "low",
      "--max-tokens",
      "99",
    ]);
    expect(args.command).toBe("ask");
    expect(args.positional).toEqual(["mon prompt"]);
    expect(args.flags).toEqual({
      model: "sonnet",
      system: "Système",
      json: true,
      effort: "low",
      "max-tokens": "99",
    });
  });

  it("commande vide", () => {
    expect(parseArgs([]).command).toBe("");
  });
});

describe("logLine", () => {
  const reponse = (partial: Partial<Response> = {}): Response => ({
    text: "",
    message: { role: "assistant", content: "" },
    toolCalls: [],
    reasoning: null,
    usage: usage({ inputTokens: 100, outputTokens: 20 }),
    costUsd: 0.0041,
    latencyMs: 3200,
    model: "claude-sonnet-5",
    alias: "sonnet",
    provider: "anthropic",
    finishReason: "stop",
    attempts: 1,
    raw: null,
    ...partial,
  });

  it("forme canonique, identique côté Python", () => {
    expect(logLine(reponse(), "veille")).toBe(
      "[veille] anthropic:claude-sonnet-5 3.2s in=100 out=20 $0.0041 finish=stop",
    );
  });

  it("cache, raisonnement et tentatives n'apparaissent que s'ils existent", () => {
    const ligne = logLine(
      reponse({
        usage: usage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, reasoningTokens: 4 }),
        attempts: 2,
      }),
    );
    expect(ligne).toContain("cache=3/0");
    expect(ligne).toContain("reasoning=4");
    expect(ligne).toContain("attempts=2");
  });
});

describe("coût", () => {
  it("formule complète", () => {
    const s = spec("t", "anthropic", "m", { priceIn: 3, priceOut: 15 });
    const cout = computeCost(
      s,
      usage({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    );
    expect(cout).toBeCloseTo(3 + 15 + 0.3 + 3 * 1.25);
  });

  it("tarif inconnu → null, jamais un faux 0", () => {
    expect(computeCost(resolveSpec("glm-flash"), usage({ inputTokens: 1000 }))).toBeNull();
    expect(formatCost(null)).toBe("$?");
    expect(formatCost(0.00412)).toBe("$0.0041");
  });
});
