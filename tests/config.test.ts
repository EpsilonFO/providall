/** Les six étages de la résolution du modèle, et les réglages globaux. */

import { describe, expect, it } from "vitest";

import {
  apiKeyFor,
  baseUrlFor,
  describeConfig,
  envDefaults,
  keyPresent,
  listModels,
  resolve,
  resolveModel,
} from "../src/config.js";
import { normalizeEffort } from "../src/env.js";
import { ConfigError, UnknownModelError } from "../src/errors.js";
import { resolveSpec } from "../src/registry.js";
import type { Env } from "../src/types.js";

/** Environnement vide : la machine du dev ne doit pas fausser les assertions. */
const VIDE: Env = {};

describe("ordre de résolution", () => {
  it("1. argument explicite prime", () => {
    const env = { LLM_MODEL: "sonnet", LLM_MODEL_PLANNER: "opus" };
    expect(resolveModel("haiku", { role: "planner", env }).alias).toBe("haiku");
  });

  it("2. modèle par rôle", () => {
    const env = { LLM_MODEL: "sonnet", LLM_MODEL_PLANNER: "opus" };
    expect(resolveModel(undefined, { role: "planner", env }).alias).toBe("opus");
    // Rôle sans variable dédiée : on retombe sur LLM_MODEL.
    expect(resolveModel(undefined, { role: "coach", env }).alias).toBe("sonnet");
  });

  it("2bis. le nom du rôle est normalisé", () => {
    const env = { LLM_MODEL_MON_ROLE: "haiku" };
    expect(resolveModel(undefined, { role: "mon-role", env }).alias).toBe("haiku");
  });

  it("3. LLM_MODEL", () => {
    const r = resolve(undefined, { env: { LLM_MODEL: "ds-flash" } });
    expect(r.spec.alias).toBe("ds-flash");
    expect(r.source).toBe("LLM_MODEL");
  });

  it("3bis. LLM_MODEL hors registre", () => {
    expect(resolveModel(undefined, { env: { LLM_MODEL: "zai:glm-5.4-flash" } }).modelId).toBe(
      "glm-5.4-flash",
    );
  });

  it("4. LLM_PROVIDER seul (compat agenda)", () => {
    const r = resolve(undefined, { env: { LLM_PROVIDER: "openai" } });
    expect(r.spec.modelId).toBe("gpt-5.6-terra");
    expect(r.source).toContain("LLM_PROVIDER");
  });

  it("4bis. LLM_PROVIDER par alias", () => {
    expect(resolveModel(undefined, { env: { LLM_PROVIDER: "claude" } }).modelId).toBe(
      "claude-sonnet-5",
    );
  });

  it("4ter. LLM_PROVIDER + modèle nu = provider:id", () => {
    const r = resolve(undefined, {
      env: { LLM_PROVIDER: "openai", LLM_MODEL: "gpt-5.7-nova" },
    });
    expect(r.spec.provider).toBe("openai");
    expect(r.spec.modelId).toBe("gpt-5.7-nova");
    expect(r.source).toBe("LLM_PROVIDER + LLM_MODEL");
  });

  it("4quater. un alias du registre prime sur LLM_PROVIDER", () => {
    const env = { LLM_PROVIDER: "openai", LLM_MODEL: "sonnet" };
    expect(resolveModel(undefined, { env }).provider).toBe("anthropic");
  });

  it("4quinquies. LLM_PROVIDER inconnu", () => {
    expect(() => resolveModel(undefined, { env: { LLM_PROVIDER: "nimportequoi" } })).toThrow(
      ConfigError,
    );
  });

  it("5. une seule clé suffit", () => {
    const r = resolve(undefined, { env: { ANTHROPIC_API_KEY: "sk-x" } });
    expect(r.spec.modelId).toBe("claude-sonnet-5");
    expect(r.source).toContain("ANTHROPIC_API_KEY");
  });

  it("5bis. deux clés demandent de trancher", () => {
    expect(() =>
      resolveModel(undefined, { env: { ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "b" } }),
    ).toThrow(/LLM_MODEL/);
  });

  it("5ter. une clé partagée ne compte qu'une fois", () => {
    // `zai` et `zai_anthropic` partagent ZAI_API_KEY : pas une ambiguïté.
    expect(resolveModel(undefined, { env: { ZAI_API_KEY: "sk-z" } }).provider).toBe("zai");
  });

  it("5quater. une clé vide compte comme absente", () => {
    expect(() => resolveModel(undefined, { env: { ANTHROPIC_API_KEY: "   " } })).toThrow(
      UnknownModelError,
    );
  });

  it("6. rien du tout", () => {
    expect(() => resolveModel(undefined, { env: VIDE })).toThrow(/alias du registre/);
  });
});

describe("URL de base et clé", () => {
  const spec = resolveSpec("ds-flash");

  it("registre, puis LLM_BASE_URL, puis <PROVIDER>_BASE_URL", () => {
    expect(baseUrlFor(spec, VIDE)).toEqual(["https://api.deepseek.com", "registre"]);
    expect(baseUrlFor(spec, { LLM_BASE_URL: "http://local/v1" })).toEqual([
      "http://local/v1",
      "LLM_BASE_URL",
    ]);
    expect(
      baseUrlFor(spec, { LLM_BASE_URL: "http://local/v1", DEEPSEEK_BASE_URL: "http://proxy/v1" }),
    ).toEqual(["http://proxy/v1", "DEEPSEEK_BASE_URL"]);
  });

  it("absente pour le provider générique", () => {
    expect(() => baseUrlFor(resolveSpec("openai_compat:mon-modele"), VIDE)).toThrow(
      /LLM_BASE_URL/,
    );
  });

  it("LLM_API_KEY est le repli", () => {
    expect(apiKeyFor(spec, VIDE)).toBe("");
    expect(apiKeyFor(spec, { LLM_API_KEY: "generique" })).toBe("generique");
    expect(apiKeyFor(spec, { LLM_API_KEY: "generique", DEEPSEEK_API_KEY: "propre" })).toBe(
      "propre",
    );
  });

  it("un provider sans clé est toujours « présent »", () => {
    expect(keyPresent(resolveSpec("ollama:llama"), VIDE)).toBe(true);
    expect(keyPresent(spec, VIDE)).toBe(false);
  });
});

describe("réglages globaux", () => {
  it("lus depuis l'environnement", () => {
    const d = envDefaults({
      LLM_MAX_TOKENS: "4096",
      LLM_EFFORT: "HIGH",
      LLM_TEMPERATURE: "0",
      LLM_RETRIES: "0",
    });
    expect(d.maxTokens).toBe(4096);
    expect(d.effort).toBe("high");
    expect(d.temperature).toBe(0);
    expect(d.retries).toBe(0);
  });

  it("LLM_TIMEOUT en secondes, LLM_TIMEOUT_MS en repli (agenda)", () => {
    expect(envDefaults(VIDE).timeoutMs).toBeUndefined();
    expect(envDefaults({ LLM_TIMEOUT_MS: "90000" }).timeoutMs).toBe(90_000);
    expect(envDefaults({ LLM_TIMEOUT: "30", LLM_TIMEOUT_MS: "90000" }).timeoutMs).toBe(30_000);
  });

  it.each([
    ["high", "high"],
    ["HIGH", "high"],
    [" max ", "max"],
    ["turbo", undefined],
    ["", undefined],
  ])("normalizeEffort(%s)", (valeur, attendu) => {
    expect(normalizeEffort(valeur)).toBe(attendu);
  });
});

describe("listModels et describeConfig", () => {
  it("filtre sur la clé", () => {
    expect(listModels(VIDE, true)).toEqual([]);
    const dispos = listModels({ DEEPSEEK_API_KEY: "x" }, true).map((m) => m.alias);
    expect(new Set(dispos)).toEqual(new Set(["ds-flash", "ds-pro"]));
  });

  it("describeConfig ne lève jamais", () => {
    expect(describeConfig(VIDE)).toContain("⚠️");
    const ligne = describeConfig({ ANTHROPIC_API_KEY: "sk-x" });
    expect(ligne).toContain("claude-sonnet-5");
    expect(ligne).not.toContain("⚠️");
  });

  it("describeConfig signale une clé absente", () => {
    expect(describeConfig({ LLM_MODEL: "sonnet" })).toContain("ANTHROPIC_API_KEY absente");
  });
});
