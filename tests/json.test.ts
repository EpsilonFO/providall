/** Boucle de réparation JSON, et l'interface Standard Schema. */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OutputValidationError } from "../src/errors.js";
import { completeJson, completeJsonResult, tryCompleteJson } from "../src/json.js";
import { harden, isSchema, parseJsonLoose, validate } from "../src/schema.js";
import { chatReply, fakeFetch, jsonReply, testEnv } from "../src/testing.js";

const ENV = testEnv({ OPENAI_API_KEY: "sk-oa" });

/** zod passe par Standard Schema : la lib ne l'importe jamais. */
const Fiche = z.object({ nom: z.string(), genre: z.enum(["a", "b"]) });

describe("Standard Schema", () => {
  it("zod expose bien `~standard`", () => {
    expect(isSchema(Fiche)).toBe(true);
    expect(isSchema({ type: "object" })).toBe(false);
  });

  it("valide et rend des erreurs actionnables", async () => {
    expect(await validate(Fiche, { nom: "x", genre: "a" })).toEqual({
      data: { nom: "x", genre: "a" },
    });
    const echec = await validate(Fiche, { nom: "x", genre: "z" });
    // « Invalid input » seul ne permet à personne — ni au modèle — de se corriger.
    expect(echec.issues).toContain("genre");
  });
});

describe("parseJsonLoose", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['  {"a":1}  ', { a: 1 }],
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['```\n{"a":1}\n```', { a: 1 }],
    ['Voici : {"a":1} — voilà.', { a: 1 }],
    ["[1,2]", [1, 2]],
  ])("%s", (texte, attendu) => {
    expect(parseJsonLoose(texte)).toEqual(attendu);
  });

  it.each(["", "   ", "pas du json", "{cassé"])("échoue proprement sur %s", (texte) => {
    expect(parseJsonLoose(texte)).toBeNull();
  });
});

describe("harden", () => {
  it("additionalProperties: false partout, sans écraser l'existant", () => {
    const schema = {
      type: "object",
      properties: { sous: { type: "object", properties: {} } },
    };
    harden(schema);
    expect((schema as any).additionalProperties).toBe(false);
    expect((schema as any).properties.sous.additionalProperties).toBe(false);

    const explicite = { type: "object", additionalProperties: true, properties: {} };
    harden(explicite);
    expect(explicite.additionalProperties).toBe(true);
  });
});

describe("completeJson", () => {
  it("premier essai valide", async () => {
    const faux = fakeFetch([jsonReply({ nom: "x", genre: "a" })]);
    const r = await completeJsonResult(Fiche, "extrais", { env: ENV, fetch: faux.fetch });
    expect(r.data).toEqual({ nom: "x", genre: "a" });
    expect(r.attempts).toBe(1);
    expect(faux.calls).toHaveLength(1);
  });

  it("le schéma JSON explicite est transmis au fournisseur", async () => {
    // Standard Schema n'expose pas de JSON Schema : on le passe à la main.
    const faux = fakeFetch([jsonReply({ nom: "x", genre: "a" })]);
    await completeJson(Fiche, "extrais", {
      env: ENV,
      fetch: faux.fetch,
      model: "gpt-terra",
      jsonSchema: z.toJSONSchema(Fiche) as Record<string, unknown>,
    });
    const rf = faux.bodies[0]!["response_format"] as any;
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
  });

  it("sans jsonSchema, mode JSON générique + validation", async () => {
    const faux = fakeFetch([jsonReply({ nom: "x", genre: "a" })]);
    await completeJson(Fiche, "extrais", { env: ENV, fetch: faux.fetch });
    expect(faux.bodies[0]!["response_format"]).toEqual({ type: "json_object" });
  });

  it("JSON dans un bloc balisé", async () => {
    const faux = fakeFetch([chatReply('```json\n{"nom":"x","genre":"b"}\n```')]);
    const r = await completeJson(Fiche, "extrais", { env: ENV, fetch: faux.fetch });
    expect(r.genre).toBe("b");
  });

  it("réparation après JSON non conforme", async () => {
    const faux = fakeFetch([
      jsonReply({ nom: "x", genre: "ZZZ" }),
      jsonReply({ nom: "x", genre: "a" }),
    ]);
    const r = await completeJsonResult(Fiche, "extrais", { env: ENV, fetch: faux.fetch });
    expect(r.attempts).toBe(2);

    // Le 2e appel porte la réponse fautive ET la liste des erreurs : sans elle
    // le modèle refait souvent la même erreur.
    const messages = faux.bodies[1]!["messages"] as any[];
    expect(messages.at(-2).role).toBe("assistant");
    expect(messages.at(-2).content).toContain("ZZZ");
    expect(messages.at(-1).content).toContain("ne respecte pas le format attendu");
    expect(messages.at(-1).content).toContain("genre");
  });

  it("réparation après JSON illisible", async () => {
    const faux = fakeFetch([chatReply("désolé, je ne peux pas"), jsonReply({ nom: "x", genre: "a" })]);
    await completeJson(Fiche, "extrais", { env: ENV, fetch: faux.fetch });
    expect((faux.bodies[1]!["messages"] as any[]).at(-1).content).toContain(
      "pas du JSON parsable",
    );
  });

  it("abandon après maxRepairs", async () => {
    const faux = fakeFetch([jsonReply({ nom: "x" })]);
    await expect(
      completeJson(Fiche, "extrais", { env: ENV, fetch: faux.fetch, maxRepairs: 1 }),
    ).rejects.toBeInstanceOf(OutputValidationError);
    expect(faux.calls).toHaveLength(2);
  });

  it("l'erreur porte les issues et le dernier texte", async () => {
    const faux = fakeFetch([jsonReply({ nom: "x" })]);
    try {
      await completeJson(Fiche, "extrais", { env: ENV, fetch: faux.fetch, maxRepairs: 0 });
      expect.unreachable();
    } catch (err) {
      const e = err as OutputValidationError;
      expect(e.attempts).toBe(1);
      expect(e.issues).toContain("genre");
      expect(JSON.parse(e.lastText)).toEqual({ nom: "x" });
    }
  });

  it("tryCompleteJson ne rejette jamais", async () => {
    const faux = fakeFetch([jsonReply({ nom: "x" })]);
    const r = await tryCompleteJson(Fiche, "extrais", {
      env: ENV,
      fetch: faux.fetch,
      maxRepairs: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeInstanceOf(OutputValidationError);
  });

  it("jamais de préremplissage assistant (400 sur Claude 4.6+)", async () => {
    const faux = fakeFetch([
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"nom":"x","genre":"a"}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    ]);
    await completeJson(Fiche, "extrais", {
      env: { ...ENV, ANTHROPIC_API_KEY: "sk-an" },
      fetch: faux.fetch,
      model: "sonnet",
    });
    const messages = faux.bodies[0]!["messages"] as any[];
    expect(messages.at(-1).role).toBe("user");
  });
});
