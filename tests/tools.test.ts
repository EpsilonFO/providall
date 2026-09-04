/** `defineTool` et la boucle d'agent. */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineTool, toolLoop } from "../src/tools.js";
import { anthropicReply, chatReply, fakeFetch, testEnv, toolCall } from "../src/testing.js";
import type { ToolCall } from "../src/types.js";

const ENV = testEnv({ ANTHROPIC_API_KEY: "sk-an" });

const meteo = defineTool({
  name: "meteo",
  description: "Prévisions pour une ville",
  parameters: {
    type: "object",
    properties: { ville: { type: "string" }, jours: { type: "integer" } },
    required: ["ville"],
    additionalProperties: false,
  },
  handler: ({ ville, jours }) => `${jours ?? 1}j à ${String(ville)} : soleil`,
});

describe("defineTool", () => {
  it("garde le JSON Schema tel quel", () => {
    expect(meteo.parameters["required"]).toEqual(["ville"]);
    expect(meteo.description).toBe("Prévisions pour une ville");
  });

  it("accepte un schéma Standard Schema avec son JSON Schema", () => {
    const Args = z.object({ ville: z.string() });
    const t = defineTool({
      name: "x",
      parameters: Args,
      jsonSchema: z.toJSONSchema(Args) as Record<string, unknown>,
    });
    expect((t.parameters as any).properties.ville.type).toBe("string");
  });

  it("un Standard Schema sans jsonSchema donne un objet vide, pas une erreur", () => {
    // Standard Schema n'expose pas de JSON Schema : mieux vaut un outil sans
    // paramètres décrits qu'un crash au démarrage.
    const t = defineTool({ name: "x", parameters: z.object({ a: z.string() }) });
    expect(t.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("toolLoop", () => {
  it("un tour d'outil puis la réponse", async () => {
    const faux = fakeFetch([
      chatReply("", { finishReason: "tool_calls", toolCalls: [toolCall("meteo", { ville: "Lyon" })] }),
      chatReply("Il fera beau."),
    ]);
    const r = await toolLoop("météo à Lyon ?", {
      env: ENV,
      fetch: faux.fetch,
      tools: [meteo],
    });

    expect(r.text).toBe("Il fera beau.");
    expect(r.turns).toBe(2);
    expect(r.stopped).toBe("done");
    expect(r.calls[0]!.function.name).toBe("meteo");
    const dernier = (faux.bodies[1]!["messages"] as any[]).at(-1);
    expect(dernier.role).toBe("tool");
    expect(dernier.content).toContain("soleil");
  });

  it("usage et coût cumulés sur tous les tours", async () => {
    const faux = fakeFetch([
      chatReply("", {
        finishReason: "tool_calls",
        toolCalls: [toolCall("meteo", { ville: "L" })],
        promptTokens: 100,
        completionTokens: 10,
      }),
      chatReply("fini", { promptTokens: 200, completionTokens: 20 }),
    ]);
    const r = await toolLoop("q", { env: ENV, fetch: faux.fetch, tools: [meteo] });
    expect(r.usage.inputTokens).toBe(300);
    expect(r.usage.outputTokens).toBe(30);
    expect(r.costUsd).toBeCloseTo((300 * 0.28 + 30 * 0.42) / 1e6);
  });

  it("plafond de tours", async () => {
    const faux = fakeFetch([
      chatReply("", { finishReason: "tool_calls", toolCalls: [toolCall("meteo", { ville: "L" })] }),
    ]);
    const r = await toolLoop("q", { env: ENV, fetch: faux.fetch, tools: [meteo], maxTurns: 3 });
    expect(r.stopped).toBe("max_turns");
    expect(r.turns).toBe(3);
    expect(faux.calls).toHaveLength(3);
  });

  it("une erreur de handler repart au modèle", async () => {
    // Le modèle sait souvent se corriger ; lever ferait perdre tout le tour.
    const casse = defineTool({
      name: "casse",
      parameters: { type: "object", properties: {} },
      handler: () => {
        throw new Error("boum");
      },
    });
    const faux = fakeFetch([
      chatReply("", { finishReason: "tool_calls", toolCalls: [toolCall("casse", {})] }),
      chatReply("désolé"),
    ]);
    const r = await toolLoop("q", { env: ENV, fetch: faux.fetch, tools: [casse] });
    expect(r.stopped).toBe("done");
    expect((faux.bodies[1]!["messages"] as any[]).at(-1).content).toContain("Error: boum");
  });

  it("un outil inconnu est signalé au modèle", async () => {
    const faux = fakeFetch([
      chatReply("", { finishReason: "tool_calls", toolCalls: [toolCall("fantome", {})] }),
      chatReply("ah"),
    ]);
    await toolLoop("q", { env: ENV, fetch: faux.fetch, tools: [meteo] });
    expect((faux.bodies[1]!["messages"] as any[]).at(-1).content).toContain("outil inconnu");
  });

  it("les tool_result d'un tour tiennent dans un seul message (Anthropic)", async () => {
    // Les séparer apprend au modèle à ne plus paralléliser ses appels.
    const faux = fakeFetch([
      anthropicReply("", {
        stopReason: "tool_use",
        toolUses: [
          { id: "t1", name: "meteo", input: { ville: "Lyon" } },
          { id: "t2", name: "meteo", input: { ville: "Paris" } },
        ],
      }),
      anthropicReply("voilà"),
    ]);
    const r = await toolLoop("q", {
      env: ENV,
      fetch: faux.fetch,
      tools: [meteo],
      model: "sonnet",
    });
    expect(r.calls).toHaveLength(2);
    const dernier = (faux.bodies[1]!["messages"] as any[]).at(-1);
    expect(dernier.role).toBe("user");
    expect(dernier.content.map((b: any) => b.type)).toEqual(["tool_result", "tool_result"]);
  });

  it("le rejeu des blocs signés est préservé", async () => {
    const faux = fakeFetch([
      anthropicReply("", {
        stopReason: "tool_use",
        thinking: "je réfléchis",
        toolUses: [{ id: "t1", name: "meteo", input: { ville: "L" } }],
      }),
      anthropicReply("voilà"),
    ]);
    await toolLoop("q", { env: ENV, fetch: faux.fetch, tools: [meteo], model: "sonnet" });
    const blocs = (faux.bodies[1]!["messages"] as any[])[1].content;
    expect(blocs[0].type).toBe("thinking");
  });

  it("handler asynchrone et onCall", async () => {
    const lent = defineTool({
      name: "lent",
      parameters: { type: "object", properties: {} },
      handler: async () => ({ resultat: 42 }),
    });
    const vus: [string, string][] = [];
    const faux = fakeFetch([
      chatReply("", { finishReason: "tool_calls", toolCalls: [toolCall("lent", {})] }),
      chatReply("fini"),
    ]);
    await toolLoop("q", {
      env: ENV,
      fetch: faux.fetch,
      tools: [lent],
      onCall: (appel: ToolCall, res) => vus.push([appel.function.name, res]),
    });
    expect(vus).toEqual([["lent", '{"resultat":42}']]);
  });

  it("un outil sans handler est signalé plutôt que d'échouer", async () => {
    const declaratif = defineTool({ name: "sansmain", parameters: { type: "object" } });
    const faux = fakeFetch([
      chatReply("", { finishReason: "tool_calls", toolCalls: [toolCall("sansmain", {})] }),
      chatReply("bon"),
    ]);
    await toolLoop("q", { env: ENV, fetch: faux.fetch, tools: [declaratif] });
    expect((faux.bodies[1]!["messages"] as any[]).at(-1).content).toContain("sans handler");
  });
});
