/** Pipeline complet avec un faux `fetch` : retry, tryComplete, coût, hooks. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { complete, createClient, prepare, stream, tryComplete } from "../src/complete.js";
import { CapabilityError, MissingKeyError, ServerError } from "../src/errors.js";
import {
  anthropicReply,
  chatReply,
  errorRes,
  fakeFetch,
  sseRes,
  testEnv,
  toolCall,
} from "../src/testing.js";
import type { Env, Message, Response } from "../src/types.js";

const ENV: Env = testEnv({ ANTHROPIC_API_KEY: "sk-an" });

/** Les relances écrivent sur `console.warn` par défaut : ici on veut le silence. */
const MUET = { debug: () => {}, info: () => {}, warn: () => {} };

/** Sans ça, un test de retry attendrait vraiment 2 s puis 4 s. */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Lance une promesse ET fait avancer les timers factices. */
async function courir<T>(promesse: Promise<T>): Promise<T> {
  // Le `catch` évite un rejet « non géré » pendant l'avance des timers : la
  // vraie assertion l'attrapera juste après.
  promesse.catch(() => undefined);
  await vi.runAllTimersAsync();
  return promesse;
}

describe("appel nominal", () => {
  it("texte, usage, modèle et corps envoyé", async () => {
    const faux = fakeFetch([chatReply("bonjour", { promptTokens: 100, completionTokens: 50 })]);
    const r = await courir(complete("salut", { env: ENV, fetch: faux.fetch }));

    expect(r.text).toBe("bonjour");
    expect(r.attempts).toBe(1);
    expect(r.alias).toBe("ds-flash");
    expect(r.model).toBe("deepseek-v4-flash");
    expect(faux.bodies[0]!["messages"]).toEqual([{ role: "user", content: "salut" }]);
  });

  it("coût calculé, et null quand le tarif est inconnu", async () => {
    const faux = fakeFetch([
      chatReply("x", { promptTokens: 1_000_000, completionTokens: 1_000_000 }),
    ]);
    const r = await courir(complete("salut", { env: ENV, fetch: faux.fetch }));
    expect(r.costUsd).toBeCloseTo(0.28 + 0.42);

    const faux2 = fakeFetch([chatReply("x")]);
    const r2 = await courir(
      complete("salut", { env: ENV, fetch: faux2.fetch, model: "deepseek:tout-neuf" }),
    );
    // Un 0,00 $ faux se retrouve additionné dans un rapport sans qu'on le voie.
    expect(r2.costUsd).toBeNull();
  });

  it("system et messages system fusionnés", async () => {
    const faux = fakeFetch([chatReply("ok")]);
    const conversation: Message[] = [
      { role: "system", content: "B" },
      { role: "user", content: "q" },
    ];
    await courir(complete(conversation, { env: ENV, fetch: faux.fetch, system: "A" }));
    expect((faux.bodies[0]!["messages"] as any[])[0].content).toBe("A\n\nB");
  });

  it("le modèle se choisit à l'appel", async () => {
    const faux = fakeFetch([anthropicReply("ok")]);
    const r = await courir(complete("salut", { env: ENV, fetch: faux.fetch, model: "sonnet" }));
    expect(r.provider).toBe("anthropic");
    expect(faux.calls[0]!.url).toContain("/messages");
    expect(faux.bodies[0]!["model"]).toBe("claude-sonnet-5");
  });
});

describe("garde-fous avant envoi", () => {
  it("clé manquante : aucun octet envoyé", async () => {
    const faux = fakeFetch([chatReply("ok")]);
    await expect(
      complete("salut", { env: { LLM_MODEL: "sonnet" }, fetch: faux.fetch }),
    ).rejects.toBeInstanceOf(MissingKeyError);
    expect(faux.calls).toHaveLength(0);
  });

  it("le message nomme la variable ET l'URL de la clé", async () => {
    await expect(
      complete("salut", { env: { LLM_MODEL: "sonnet" } }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY.*console\.anthropic\.com/s);
  });

  it("capacité manquante : aucun octet envoyé", async () => {
    const faux = fakeFetch([chatReply("ok")]);
    const image: Message[] = [
      { role: "user", content: [{ type: "image_url", url: "http://x" }] },
    ];
    await expect(
      complete(image, {
        env: { ...ENV, LLM_BASE_URL: "http://local/v1" },
        fetch: faux.fetch,
        model: "openai_compat:local",
      }),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(faux.calls).toHaveLength(0);
  });

  it("`prepare` n'envoie rien et rend la requête résolue", () => {
    const req = prepare("salut", { env: ENV, model: "sonnet", maxTokens: 42 });
    expect(req.spec.modelId).toBe("claude-sonnet-5");
    expect(req.maxTokens).toBe(42);
  });
});

describe("retry", () => {
  const opts = (fetch: any, extra: Record<string, unknown> = {}) => ({
    env: ENV,
    fetch,
    logger: MUET,
    ...extra,
  });

  it("retente sur transitoire", async () => {
    const faux = fakeFetch([errorRes(503, "indispo"), errorRes(503, "indispo"), chatReply("enfin")]);
    const r = await courir(complete("salut", opts(faux.fetch)));
    expect(r.text).toBe("enfin");
    expect(r.attempts).toBe(3);
    expect(faux.calls).toHaveLength(3);
  });

  it("ne retente pas sur 400", async () => {
    const faux = fakeFetch([errorRes(400, "mauvaise requête")]);
    await expect(courir(complete("salut", opts(faux.fetch)))).rejects.toMatchObject({
      status: 400,
    });
    expect(faux.calls).toHaveLength(1);
  });

  it("`retries` surchargeable à l'appel et par l'env", async () => {
    const faux = fakeFetch([errorRes(503, "x")]);
    await expect(
      courir(complete("salut", opts(faux.fetch, { retries: 0 }))),
    ).rejects.toBeInstanceOf(ServerError);
    expect(faux.calls).toHaveLength(1);

    const faux2 = fakeFetch([errorRes(503, "x")]);
    await expect(
      courir(complete("salut", { ...opts(faux2.fetch), env: { ...ENV, LLM_RETRIES: "1" } })),
    ).rejects.toBeInstanceOf(ServerError);
    expect(faux2.calls).toHaveLength(2);
  });

  it("une réponse vide inexpliquée est rejouée, une troncature non", async () => {
    const faux = fakeFetch([chatReply("", { finishReason: "stop" }), chatReply("ok")]);
    expect((await courir(complete("salut", opts(faux.fetch)))).text).toBe("ok");
    expect(faux.calls).toHaveLength(2);

    const faux2 = fakeFetch([chatReply("", { finishReason: "length" })]);
    await expect(courir(complete("salut", opts(faux2.fetch)))).rejects.toMatchObject(
      { name: "EmptyResponseError", retryable: false },
    );
    expect(faux2.calls).toHaveLength(1);
  });
});

describe("tryComplete", () => {
  it("ne rejette jamais", async () => {
    const faux = fakeFetch([errorRes(400, "mauvaise requête")]);
    const r = await courir(tryComplete("salut", { env: ENV, fetch: faux.fetch }));
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("BadRequestError");
  });

  it("attrape aussi les erreurs de configuration", async () => {
    const r = await tryComplete("salut", { env: {} });
    expect(r.ok).toBe(false);
    expect(r.error?.name).toBe("UnknownModelError");
  });

  it("rend la réponse en cas de succès", async () => {
    const faux = fakeFetch([chatReply("ok")]);
    const r = await courir(tryComplete("salut", { env: ENV, fetch: faux.fetch }));
    expect(r.ok).toBe(true);
    expect(r.value?.text).toBe("ok");
  });
});

describe("createClient", () => {
  it("la config du client sert de défaut, l'appel la surcharge", async () => {
    const faux = fakeFetch([chatReply("ok"), chatReply("ok")]);
    const client = createClient({ env: ENV, fetch: faux.fetch, maxTokens: 100 });
    await courir(client.complete("a"));
    await courir(client.complete("b", { maxTokens: 555 }));
    expect(faux.bodies[0]!["max_tokens"]).toBe(100);
    expect(faux.bodies[1]!["max_tokens"]).toBe(555);
  });

  it("LLM_MAX_TOKENS prime sur le défaut du modèle", async () => {
    const faux = fakeFetch([chatReply("ok")]);
    await courir(complete("a", { env: { ...ENV, LLM_MAX_TOKENS: "4096" }, fetch: faux.fetch }));
    expect(faux.bodies[0]!["max_tokens"]).toBe(4096);
  });

  it("onResponse est appelé", async () => {
    const vues: Response[] = [];
    const faux = fakeFetch([chatReply("ok")]);
    await courir(
      complete("a", { env: ENV, fetch: faux.fetch, onResponse: (r) => vues.push(r) }),
    );
    expect(vues).toHaveLength(1);
    expect(vues[0]!.text).toBe("ok");
  });

  it("un logger injecté reçoit la ligne d'appel", async () => {
    const lignes: string[] = [];
    const faux = fakeFetch([chatReply("ok")]);
    await courir(
      complete("a", {
        env: ENV,
        fetch: faux.fetch,
        logger: { debug: () => {}, info: (m) => lignes.push(m), warn: () => {} },
      }),
    );
    expect(lignes[0]).toMatch(/deepseek:deepseek-v4-flash .* in=10 out=5/);
  });
});

describe("stream", () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    choices: [{ delta, finish_reason: finish }],
  });

  it("rend les deltas puis la réponse complète", async () => {
    const faux = fakeFetch([
      sseRes([
        chunk({ content: "bon" }),
        chunk({ content: "jour" }, "stop"),
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      ]),
    ]);
    const flux = stream("salut", { env: ENV, fetch: faux.fetch });

    const morceaux: string[] = [];
    for await (const m of flux) morceaux.push(m);
    expect(morceaux).toEqual(["bon", "jour"]);

    const finale = await flux.response;
    expect(finale.text).toBe("bonjour");
    expect(finale.usage.inputTokens).toBe(5);
    expect(finale.costUsd).not.toBeNull();
  });

  it("le corps demande bien un flux", async () => {
    const faux = fakeFetch([sseRes([chunk({ content: "a" }, "stop")])]);
    const flux = stream("salut", { env: ENV, fetch: faux.fetch });
    await flux.response;
    expect(faux.bodies[0]!["stream"]).toBe(true);
  });

  it("les événements bruts portent les appels d'outils", async () => {
    const faux = fakeFetch([
      sseRes([
        chunk({
          tool_calls: [{ index: 0, id: "t1", function: { name: "m", arguments: "{}" } }],
        }),
        chunk({}, "tool_calls"),
      ]),
    ]);
    const flux = stream("salut", { env: ENV, fetch: faux.fetch });
    const types: string[] = [];
    for await (const e of flux.events) types.push(e.type);
    expect(types).toContain("tool_call");
    expect(types.at(-1)).toBe("done");
  });

  it("relance avant le premier octet, jamais après", async () => {
    const faux = fakeFetch([errorRes(503, "x"), sseRes([chunk({ content: "ok" }, "stop")])]);
    const flux = stream("salut", { env: ENV, fetch: faux.fetch, logger: MUET });
    const promesse = (async () => {
      const morceaux: string[] = [];
      for await (const m of flux) morceaux.push(m);
      return morceaux;
    })();
    await vi.runAllTimersAsync();
    expect(await promesse).toEqual(["ok"]);
    expect(faux.calls).toHaveLength(2);
  });

  it("le flux Anthropic passe par le même pipeline", async () => {
    const faux = fakeFetch([
      sseRes([
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "salut" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      ]),
    ]);
    const flux = stream("q", { env: ENV, fetch: faux.fetch, model: "sonnet" });
    const morceaux: string[] = [];
    for await (const m of flux) morceaux.push(m);
    expect(morceaux).toEqual(["salut"]);
    expect((await flux.response).usage.outputTokens).toBe(3);
  });
});

describe("toolCall (helper de test)", () => {
  it("produit un appel au format chat-completions", () => {
    expect(toolCall("meteo", { ville: "Lyon" })).toEqual({
      id: "call_0",
      type: "function",
      function: { name: "meteo", arguments: '{"ville":"Lyon"}' },
    });
  });
});
