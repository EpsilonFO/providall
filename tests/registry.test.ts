/** Registre : parité avec le JSON, héritage, surcharges, échappatoire. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { UnknownModelError } from "../src/errors.js";
import {
  MODELS,
  PROVIDERS,
  clampEffort,
  findProvider,
  priceKnown,
  registerModel,
  resolveSpec,
  spec,
} from "../src/registry.js";
import type { Wire } from "../src/types.js";

const RACINE = join(import.meta.dirname, "..");

function lireJson(nom: string): Record<string, any> {
  const brut = JSON.parse(readFileSync(join(RACINE, "registry", nom), "utf8")) as Record<
    string,
    any
  >;
  return Object.fromEntries(Object.entries(brut).filter(([k]) => !k.startsWith("$")));
}

const instantane = { providers: new Map(PROVIDERS), models: new Map(MODELS) };

afterEach(() => {
  // Le registre est un global : un test qui l'étend doit le restaurer, sinon
  // l'ordre des tests décide qui casse.
  PROVIDERS.clear();
  for (const [k, v] of instantane.providers) PROVIDERS.set(k, v);
  MODELS.clear();
  for (const [k, v] of instantane.models) MODELS.set(k, v);
});

describe("parité avec registry/*.json", () => {
  it("mêmes providers et mêmes modèles", () => {
    expect(new Set(Object.keys(lireJson("providers.json")))).toEqual(new Set(PROVIDERS.keys()));
    expect(new Set(Object.keys(lireJson("models.json")))).toEqual(new Set(MODELS.keys()));
  });

  it("mêmes champs de modèle", () => {
    for (const [alias, data] of Object.entries(lireJson("models.json"))) {
      const s = MODELS.get(alias)!;
      expect(s.modelId).toBe(data.model_id);
      expect(s.provider).toBe(data.provider);
      expect(s.priceIn).toBe(data.price_in ?? null);
      expect(s.idVerified).toBe(data.id_verified ?? true);
    }
  });

  it("aucun alias de provider en double", () => {
    const vus = new Map<string, string>();
    for (const [nom, p] of PROVIDERS) {
      for (const alias of [nom, ...p.aliases]) {
        expect(vus.has(alias), `${alias} : ${vus.get(alias)} et ${nom}`).toBe(false);
        vus.set(alias, nom);
      }
    }
  });
});

describe("héritage et surcharges", () => {
  it("ce qu'un provider ne déclare pas vient du protocole", () => {
    expect(PROVIDERS.get("gemini")!.caps.tools).toBe(true);
    expect(PROVIDERS.get("gemini")!.wire.maxTokensParam).toBe("max_tokens");
    expect(PROVIDERS.get("anthropic")!.caps.thinking).toBe("adaptive");
    expect(PROVIDERS.get("anthropic")!.caps.temperature).toBe(false);
  });

  it("surcharges de provider", () => {
    expect(PROVIDERS.get("openai")!.wire.maxTokensParam).toBe("max_completion_tokens");
    expect(PROVIDERS.get("openai")!.caps.temperature).toBe(false);
    expect(PROVIDERS.get("openai")!.caps.effort).toBe(true);
    expect(PROVIDERS.get("deepseek")!.maxTokens).toBe(32_000);
    expect(PROVIDERS.get("openrouter")!.effort).toBe("medium");
    expect(PROVIDERS.get("openrouter")!.caps.structured).toBe("prompt");
    expect(PROVIDERS.get("ollama")!.requiresKey).toBe(false);
  });

  it("surcharges de modèle", () => {
    expect(MODELS.get("haiku")!.caps.effort).toBe(false);
    expect(MODELS.get("haiku")!.caps.thinking).toBe("budget");
    expect(MODELS.get("haiku")!.caps.temperature).toBe(true);
    expect(MODELS.get("fable")!.caps.forced_tool_choice).toBe(false);
    // Surcharge le `prompt` du provider openrouter.
    expect(MODELS.get("or-glm")!.caps.structured).toBe("json_schema");
    expect(MODELS.get("sonnet-4.6")!.wire.effortValues).toEqual(["low", "medium", "high", "max"]);
  });
});

describe("tarifs", () => {
  it("un tarif inconnu reste inconnu", () => {
    expect(priceKnown(MODELS.get("glm-flash")!)).toBe(false);
    expect(MODELS.get("glm-flash")!.priceIn).toBeNull();
    expect(priceKnown(MODELS.get("sonnet")!)).toBe(true);
  });

  it("prix de lecture de cache par défaut = entrée / 10", () => {
    expect(MODELS.get("opus")!.priceCacheRead).toBeCloseTo(0.5);
    expect(MODELS.get("fable")!.priceCacheRead).toBe(0.25); // explicite dans le JSON
  });
});

describe("échappatoire provider:model_id", () => {
  it("prend l'identifiant tel quel", () => {
    const s = resolveSpec("zai:glm-5.4-flash");
    expect(s.provider).toBe("zai");
    expect(s.modelId).toBe("glm-5.4-flash");
    expect(s.idVerified).toBe(false);
    expect(priceKnown(s)).toBe(false);
  });

  it("hérite des réglages du provider", () => {
    const s = resolveSpec("openrouter:z-ai/glm-4.6");
    expect(s.effort).toBe("medium");
    expect(s.maxTokens).toBe(32_000);
    expect(s.modelId).toBe("z-ai/glm-4.6"); // le « / » n'est pas un séparateur
  });

  it("accepte un alias de provider", () => {
    expect(resolveSpec("claude:claude-opus-5").provider).toBe("anthropic");
    expect(resolveSpec("grok:grok-9").provider).toBe("xai");
  });

  it.each(["inconnu", "pasunprovider:x", "zai:", ":x", ""])("rejette %s", (nom) => {
    expect(() => resolveSpec(nom)).toThrow(UnknownModelError);
  });

  it("le message d'erreur liste les options", () => {
    expect(() => resolveSpec("sonnnet")).toThrow(/sonnet[\s\S]*anthropic/);
  });
});

describe("findProvider", () => {
  it("nom canonique, alias, casse", () => {
    expect(findProvider("claude")).toBe(PROVIDERS.get("anthropic"));
    expect(findProvider("ANTHROPIC")).toBe(PROVIDERS.get("anthropic"));
    expect(findProvider("kimi")).toBe(PROVIDERS.get("moonshot"));
    expect(findProvider("inexistant")).toBeUndefined();
  });
});

describe("enregistrement à l'exécution", () => {
  it("ajoute puis remplace un modèle", () => {
    const maison = spec("maison", "openai_compat", "mon-modele", { priceIn: 1, priceOut: 2 });
    registerModel(maison);
    expect(resolveSpec("maison").modelId).toBe("mon-modele");
    expect(() => registerModel(maison)).toThrow(/déjà enregistré/);
    registerModel(spec("maison", "openai_compat", "v2"), { replace: true });
    expect(resolveSpec("maison").modelId).toBe("v2");
  });
});

describe("clampEffort", () => {
  const wire = (values: string[]): Wire => ({
    maxTokensParam: "max_tokens",
    effortParam: "x",
    effortValues: values,
    thinkingToggle: null,
  });

  it.each([
    ["xhigh", ["none", "low", "medium", "high"], "high"],
    ["none", ["low", "medium", "high", "xhigh", "max"], "low"],
    ["medium", ["low", "medium", "high"], "medium"],
    ["max", ["low", "medium", "high", "max"], "max"],
    [null, ["low"], null],
    ["high", [], null],
  ] as const)("%s sur %j → %s", (demande, echelle, attendu) => {
    // Un effort hors échelle est ramené, jamais rejeté : changer de provider
    // ne doit pas casser un appel générique.
    expect(clampEffort(demande as any, wire([...echelle]))).toBe(attendu);
  });
});
