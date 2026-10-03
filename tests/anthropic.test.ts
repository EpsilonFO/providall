/** Adaptateur Anthropic : `build()`, `parse()`, flux SSE — sans réseau. */

import { describe, expect, it } from "vitest";

import { EmptyResponseError, RefusalError } from "../src/errors.js";
import { ADAPTER, build, parse, toNativeMessages } from "../src/providers/anthropic.js";
import type { Request } from "../src/providers/adapter.js";
import { resolveSpec } from "../src/registry.js";
import type { Message, ToolDef } from "../src/types.js";

const OUTIL: ToolDef = {
  name: "meteo",
  description: "Prévisions",
  parameters: { type: "object", properties: { ville: { type: "string" } } },
};

function req(alias = "sonnet", partial: Partial<Request> = {}): Request {
  return {
    spec: resolveSpec(alias),
    messages: [{ role: "user", content: "salut" }],
    system: null,
    maxTokens: 1000,
    effort: null,
    temperature: null,
    tools: null,
    toolChoice: null,
    jsonSchema: null,
    jsonOnly: false,
    stream: false,
    apiKey: "sk-test",
    baseUrl: "https://api.anthropic.com/v1",
    label: alias,
    ...partial,
  };
}

/** Réponse Messages minimale, telle que `parse()` la reçoit. */
function reply(opts: Record<string, unknown> = {}): unknown {
  return {
    content: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...opts,
  };
}

describe("build", () => {
  it("forme de base et en-têtes", () => {
    const b = build(req("sonnet", { system: "Tu es utile." }));
    expect(b.url).toBe("https://api.anthropic.com/v1/messages");
    expect(b.headers).toEqual({ "x-api-key": "sk-test", "anthropic-version": "2023-06-01" });
    expect(b.body["model"]).toBe("claude-sonnet-5");
    expect(b.body["max_tokens"]).toBe(1000);
    expect(b.body["system"]).toBe("Tu es utile.");
    expect(b.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "salut" }] },
    ]);
  });

  it("thinking adaptatif, jamais budget_tokens", () => {
    // `budget_tokens` répond 400 sur la famille 5 : seul `adaptive` est valide.
    const b = build(req("sonnet"));
    expect(b.body["thinking"]).toEqual({ type: "adaptive" });
    expect(JSON.stringify(b.body)).not.toContain("budget_tokens");
  });

  it("thinking budget sur haiku", () => {
    const b = build(req("haiku", { effort: "medium", maxTokens: 16_000 }));
    expect(b.body["thinking"]).toEqual({ type: "enabled", budget_tokens: 6000 });
  });

  it("le budget de raisonnement laisse la place à la réponse", () => {
    const b = build(req("haiku", { effort: "max", maxTokens: 8000 }));
    expect((b.body["thinking"] as any).budget_tokens).toBe(8000 - 4096);
  });

  it("effort omis sur haiku (il errore)", () => {
    expect(build(req("haiku", { effort: "high" })).body["output_config"]).toBeUndefined();
  });

  it("effort posé sur sonnet, ramené à l'échelle du modèle", () => {
    expect(build(req("sonnet", { effort: "xhigh" })).body["output_config"]).toEqual({
      effort: "xhigh",
    });
    // Sonnet 4.6 n'a pas `xhigh` : on descend à `high` plutôt que de lever.
    expect((build(req("sonnet-4.6", { effort: "xhigh" })).body["output_config"] as any).effort).toBe(
      "high",
    );
  });

  it("température omise par défaut (400 sur la famille 5)", () => {
    expect(build(req("sonnet", { temperature: 0 })).body["temperature"]).toBeUndefined();
    expect(build(req("haiku", { temperature: 0 })).body["temperature"]).toBe(0);
  });

  it("sortie structurée par output_config", () => {
    const schema = { type: "object", properties: { x: { type: "string" } } };
    const b = build(req("sonnet", { jsonSchema: schema }));
    expect((b.body["output_config"] as any).format).toEqual({ type: "json_schema", schema });
    // Le fournisseur contraint : inutile d'encombrer le système du schéma.
    expect(b.body["system"]).toBeUndefined();
  });

  it("schéma dans le système si caps prudentes (z.ai anthropic-compat)", () => {
    const schema = { type: "object", properties: { x: { type: "string" } } };
    const b = build(req("zai_anthropic:glm-5.3", { jsonSchema: schema }));
    expect(b.body["output_config"]).toBeUndefined();
    expect(b.body["system"]).toContain('"x"');
  });

  it("outils et tool_choice", () => {
    const b = build(req("sonnet", { tools: [OUTIL], toolChoice: "required" }));
    expect((b.body["tools"] as any[])[0].input_schema).toEqual(OUTIL.parameters);
    expect(b.body["tool_choice"]).toEqual({ type: "any" });
  });

  it("tool_choice dégradé sur Fable (400 sur `any`)", () => {
    const b = build(req("fable", { tools: [OUTIL], toolChoice: "required" }));
    expect(b.body["tool_choice"]).toEqual({ type: "auto" });
    expect(b.body["system"]).toContain("meteo");
  });
});

describe("traduction des messages", () => {
  it("rejeu verbatim des blocs natifs", () => {
    const blocs = [
      { type: "thinking", thinking: "…", signature: "sig" },
      { type: "tool_use", id: "t1", name: "meteo", input: {} },
    ];
    const messages: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", _raw: { provider: "anthropic", items: blocs } },
      { role: "tool", tool_call_id: "t1", content: "15°C" },
    ];
    expect(toNativeMessages(messages)[1]!.content).toEqual(blocs); // signature préservée
  });

  it("un _raw d'un autre provider est ignoré", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "texte",
        tool_calls: [{ id: "c1", function: { name: "meteo", arguments: '{"ville":"Lyon"}' } }],
        _raw: { provider: "openai", items: [{ quelque: "chose" }] },
      },
    ];
    const blocs = toNativeMessages(messages)[0]!.content as any[];
    expect(blocs[0]).toEqual({ type: "text", text: "texte" });
    expect(blocs[1]).toEqual({
      type: "tool_use",
      id: "c1",
      name: "meteo",
      input: { ville: "Lyon" },
    });
  });

  it("rôles alternés et tool_result groupés", () => {
    const messages: Message[] = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "tool", tool_call_id: "t1", content: "r1" },
      { role: "tool", tool_call_id: "t2", content: "r2" },
    ];
    const natifs = toNativeMessages(messages);
    expect(natifs).toHaveLength(1);
    expect((natifs[0]!.content as any[]).map((b) => b.type)).toEqual([
      "text",
      "text",
      "tool_result",
      "tool_result",
    ]);
  });

  it("images", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "décris" },
          { type: "image_url", url: "https://x/y.png" },
          { type: "image_base64", media_type: "image/jpeg", data: "AAAA" },
        ],
      },
    ];
    const blocs = toNativeMessages(messages)[0]!.content as any[];
    expect(blocs[1]).toEqual({ type: "image", source: { type: "url", url: "https://x/y.png" } });
    expect(blocs[2].source).toEqual({ type: "base64", media_type: "image/jpeg", data: "AAAA" });
  });
});

describe("parse", () => {
  it("texte, usage et cache", () => {
    const r = parse(
      reply({
        content: [{ type: "text", text: "bonjour" }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 },
      }),
      req(),
    );
    expect(r.text).toBe("bonjour");
    expect(r.finishReason).toBe("stop");
    // Anthropic exclut déjà le cache de `input_tokens`.
    expect(r.usage.inputTokens).toBe(100);
    expect(r.usage.cacheReadTokens).toBe(50);
    expect(r.message._raw?.provider).toBe("anthropic");
    expect(r.alias).toBe("sonnet");
  });

  it("appels d'outils", () => {
    const r = parse(
      reply({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "meteo", input: { ville: "Lyon" } }],
      }),
      req(),
    );
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls[0]!.function.name).toBe("meteo");
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ ville: "Lyon" });
  });

  it("raisonnement", () => {
    const r = parse(
      reply({
        content: [
          { type: "thinking", thinking: "je réfléchis" },
          { type: "text", text: "r" },
        ],
      }),
      req(),
    );
    expect(r.reasoning).toBe("je réfléchis");
  });

  it("refus", () => {
    expect(() =>
      parse(
        reply({
          stop_reason: "refusal",
          stop_details: { category: "cyber", explanation: "non" },
        }),
        req(),
      ),
    ).toThrowError(
      expect.objectContaining({ name: "RefusalError", category: "cyber", retryable: false }),
    );
  });

  it("vide inexpliqué = rejouable, tronqué = non", () => {
    expect(() => parse(reply(), req())).toThrowError(
      expect.objectContaining({ name: "EmptyResponseError", retryable: true }),
    );
    let capturee: unknown;
    try {
      parse(reply({ stop_reason: "max_tokens" }), req());
    } catch (err) {
      capturee = err;
    }
    expect(capturee).toBeInstanceOf(EmptyResponseError);
    expect((capturee as EmptyResponseError).retryable).toBe(false);
    expect((capturee as Error).message).toContain("augmenter maxTokens");
  });

  it("le refus est bien une RefusalError et pas une EmptyResponseError", () => {
    let capturee: unknown;
    try {
      parse(reply({ stop_reason: "refusal" }), req());
    } catch (err) {
      capturee = err;
    }
    expect(capturee).toBeInstanceOf(RefusalError);
  });
});

describe("streaming", () => {
  it("réassemble texte, raisonnement et arguments d'outil", () => {
    const etat = ADAPTER.newStreamState();
    const evenements = [
      { type: "message_start", message: { usage: { input_tokens: 7 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "bon" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "jour" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t1", name: "meteo" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"v' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'ille":"Lyon"}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 12 },
      },
    ];

    const rendus = evenements.flatMap((e) => ADAPTER.streamEvents(e, etat));
    expect(rendus.filter((e) => e.type === "text").map((e: any) => e.text)).toEqual([
      "bon",
      "jour",
    ]);
    expect(rendus.some((e) => e.type === "tool_call")).toBe(true);

    // Le flux repasse par le MÊME `parse()` que le non-flux.
    const r = parse(ADAPTER.finalize(etat), req());
    expect(r.text).toBe("bonjour");
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ ville: "Lyon" });
    expect(r.finishReason).toBe("tool_calls");
    expect(r.usage.inputTokens).toBe(7);
    expect(r.usage.outputTokens).toBe(12);
  });

  it("les blocs de raisonnement signés sont conservés pour le rejeu", () => {
    const etat = ADAPTER.newStreamState();
    for (const e of [
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "S" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
    ]) {
      ADAPTER.streamEvents(e, etat);
    }
    const r = parse(ADAPTER.finalize(etat), req());
    const blocs = r.message._raw!.items as any[];
    expect(blocs[0]).toEqual({ type: "thinking", thinking: "hm", signature: "S" });
  });
});

describe("extraBody", () => {
  it("ajouté au premier niveau du corps", () => {
    const b = build(req("sonnet", { extraBody: { metadata: { user_id: "u1" } } }));
    expect(b.body["metadata"]).toEqual({ user_id: "u1" });
  });
});
