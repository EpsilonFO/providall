/** Adaptateur Chat Completions : une particularité de fournisseur par test. */

import { describe, expect, it } from "vitest";

import {
  ADAPTER,
  build,
  ensureJsonHint,
  parse,
  parseToolCalls,
  toNativeMessages,
} from "../src/providers/chat-completions.js";
import type { Request } from "../src/providers/adapter.js";
import { resolveSpec } from "../src/registry.js";
import type { ToolDef } from "../src/types.js";

const SCHEMA = {
  type: "object",
  properties: { x: { type: "string" } },
  additionalProperties: false,
};
const OUTIL: ToolDef = { name: "meteo", description: "Prévisions", parameters: { type: "object" } };

function req(alias = "ds-flash", partial: Partial<Request> = {}): Request {
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
    baseUrl: "https://api.deepseek.com",
    label: alias,
    ...partial,
  };
}

function reply(opts: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...opts,
  };
}

describe("build", () => {
  it("forme de base et Authorization", () => {
    const b = build(req("ds-flash", { system: "Système." }));
    expect(b.url).toBe("https://api.deepseek.com/chat/completions");
    expect(b.headers["Authorization"]).toBe("Bearer sk-test");
    expect(b.body["model"]).toBe("deepseek-v4-flash");
    expect((b.body["messages"] as any[])[0]).toEqual({ role: "system", content: "Système." });
  });

  it("pas d'en-tête Authorization sans clé (serveur local)", () => {
    // Certains serveurs stricts rejettent un « Bearer » vide.
    expect(build(req("ollama:llama3", { apiKey: "" })).headers).toEqual({});
  });

  it("max_completion_tokens chez OpenAI (400 sur max_tokens)", () => {
    const b = build(req("gpt-terra"));
    expect(b.body["max_completion_tokens"]).toBe(1000);
    expect(b.body["max_tokens"]).toBeUndefined();
  });

  it("température omise chez OpenAI et DeepSeek", () => {
    // Refusée en mode thinking chez DeepSeek, non par défaut chez OpenAI.
    expect(build(req("gpt-terra", { temperature: 0 })).body["temperature"]).toBeUndefined();
    expect(build(req("ds-flash", { temperature: 0 })).body["temperature"]).toBeUndefined();
    expect(build(req("glm-flash", { temperature: 0 })).body["temperature"]).toBe(0);
  });

  it("reasoning_effort chez OpenAI, ramené à son échelle", () => {
    expect(build(req("gpt-terra", { effort: "high" })).body["reasoning_effort"]).toBe("high");
    // `xhigh` n'existe pas chez OpenAI : ramené, pas rejeté.
    expect(build(req("gpt-terra", { effort: "max" })).body["reasoning_effort"]).toBe("high");
  });

  it("`reasoning` réservé à OpenRouter", () => {
    expect(build(req("or-glm")).body["reasoning"]).toEqual({ effort: "medium" });
    expect(build(req("gpt-terra", { effort: "high" })).body["reasoning"]).toBeUndefined();
    expect(build(req("ds-flash", { effort: "high" })).body["reasoning"]).toBeUndefined();
  });

  it("effort ignoré quand le provider ne le gère pas", () => {
    expect(build(req("glm-flash", { effort: "high" })).body["reasoning_effort"]).toBeUndefined();
  });

  it("deepseek : effort none coupe le thinking, low passe en reasoning_effort", () => {
    const none = build(req("ds-flash", { effort: "none" }));
    expect(none.body["thinking"]).toEqual({ type: "disabled" });
    expect(none.body["reasoning_effort"]).toBeUndefined();

    const low = build(req("ds-flash", { effort: "low" }));
    expect(low.body["reasoning_effort"]).toBe("low");
    expect(low.body["thinking"]).toBeUndefined();

    // `medium` n'existe pas chez DeepSeek : ramené, jamais rejeté.
    const medium = build(req("ds-flash", { effort: "medium" }));
    expect(["low", "high"]).toContain(medium.body["reasoning_effort"]);

    // L'interrupteur est propre à DeepSeek : ailleurs, `none` reste un effort.
    expect(build(req("gpt-terra", { effort: "none" })).body["thinking"]).toBeUndefined();
    expect(build(req("gpt-terra", { effort: "none" })).body["reasoning_effort"]).toBe("none");
  });
});

describe("response_format tri-état", () => {
  it("json_schema strict", () => {
    const rf = build(req("gpt-terra", { jsonSchema: SCHEMA })).body["response_format"] as any;
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema).toEqual(SCHEMA);
  });

  it("json_object + indice « json » exigé par DeepSeek", () => {
    const b = build(req("ds-flash", { jsonSchema: SCHEMA }));
    expect(b.body["response_format"]).toEqual({ type: "json_object" });
    expect(JSON.stringify(b.body["messages"]).toLowerCase()).toContain("json");
  });

  it("prompt seul chez OpenRouter", () => {
    // `response_format` est transmis tel quel au modèle routé, qui répond 400.
    const b = build(req("openrouter:un/modele", { jsonSchema: SCHEMA }));
    expect(b.body["response_format"]).toBeUndefined();
    expect((b.body["messages"] as any[])[0].content).toContain("schéma");
  });

  it("le schéma part TOUJOURS dans le système", () => {
    // `json_object` garantit du JSON valide, pas conforme.
    for (const alias of ["gpt-terra", "ds-flash", "openrouter:x/y"]) {
      const b = build(req(alias, { jsonSchema: SCHEMA }));
      expect((b.body["messages"] as any[])[0].content, alias).toContain('"x"');
    }
  });

  it("json: true sans schéma = mode JSON générique", () => {
    expect(build(req("ds-flash", { jsonOnly: true })).body["response_format"]).toEqual({
      type: "json_object",
    });
  });
});

describe("outils et flux", () => {
  it("outils et tool_choice", () => {
    const b = build(req("ds-flash", { tools: [OUTIL], toolChoice: "required" }));
    expect((b.body["tools"] as any[])[0].function.name).toBe("meteo");
    expect(b.body["tool_choice"]).toBe("required");
  });

  it("stream demande l'usage", () => {
    const b = build(req("ds-flash", { stream: true }));
    expect(b.body["stream"]).toBe(true);
    expect(b.body["stream_options"]).toEqual({ include_usage: true });
  });
});

describe("traduction des messages", () => {
  it("assistant sans texte a content vide, pas null (Mistral)", () => {
    const natif = toNativeMessages(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "meteo", arguments: "{}" } }],
        },
      ],
      null,
    )[0]!;
    expect(natif["content"]).toBe("");
    expect((natif["tool_calls"] as any[])[0].function.name).toBe("meteo");
  });

  it("message tool", () => {
    expect(
      toNativeMessages([{ role: "tool", tool_call_id: "c1", name: "meteo", content: "15°C" }], null)[0],
    ).toEqual({ role: "tool", tool_call_id: "c1", content: "15°C", name: "meteo" });
  });

  it("images en data URI", () => {
    const parties = toNativeMessages(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "décris" },
            { type: "image_base64", media_type: "image/png", data: "AAAA" },
          ],
        },
      ],
      null,
    )[0]!["content"] as any[];
    expect(parties[1].image_url.url).toBe("data:image/png;base64,AAAA");
  });

  it("ensureJsonHint n'ajoute rien si « json » est déjà là", () => {
    const messages = [{ role: "system", content: "rends du JSON" }];
    expect(ensureJsonHint(messages)).toBe(messages);
  });

  it("ensureJsonHint crée un system si besoin", () => {
    expect(ensureJsonHint([{ role: "user", content: "salut" }])[0]!["role"]).toBe("system");
  });
});

describe("parse", () => {
  it("texte, usage et cache normalisé hors cache", () => {
    const r = parse(
      reply({
        choices: [{ message: { content: "bonjour" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
      req(),
    );
    expect(r.text).toBe("bonjour");
    // `prompt_tokens` inclut le cache ici : on le retire pour que
    // `inputTokens` veuille dire la même chose que chez Anthropic.
    expect(r.usage.inputTokens).toBe(60);
    expect(r.usage.cacheReadTokens).toBe(40);
  });

  it("reasoning_content (DeepSeek) et reasoning_tokens", () => {
    const r = parse(
      reply({
        choices: [
          { message: { content: "r", reasoning_content: "je pense" }, finish_reason: "stop" },
        ],
        usage: { completion_tokens_details: { reasoning_tokens: 800 } },
      }),
      req(),
    );
    expect(r.reasoning).toBe("je pense");
    expect(r.usage.reasoningTokens).toBe(800);
  });

  it("ids d'outils fabriqués quand le serveur les omet", () => {
    // Sans id, le message `tool` de réponse ne peut pas être rattaché.
    expect(parseToolCalls([{ function: { name: "a", arguments: "{}" } }])[0]!.id).toBe("call_0");
  });

  it("arguments d'outil non stringifiés", () => {
    const appels = parseToolCalls([{ id: "x", function: { name: "a", arguments: { v: 1 } } }]);
    expect(JSON.parse(appels[0]!.function.arguments)).toEqual({ v: 1 });
  });

  it("vide par `length` : pas rejouable, et la cause est nommée", () => {
    let capturee: any;
    try {
      parse(
        reply({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { completion_tokens: 8000 },
        }),
        req(),
      );
    } catch (err) {
      capturee = err;
    }
    expect(capturee.retryable).toBe(false);
    expect(capturee.message).toContain("budget de sortie épuisé");
    expect(capturee.message).toContain("8000 jetons de sortie facturés");
  });

  it("vide par filtre : pas rejouable ; vide inexpliqué : rejouable", () => {
    const cas = (finish: string) => {
      try {
        parse(reply({ choices: [{ message: { content: "" }, finish_reason: finish }] }), req());
      } catch (err: any) {
        return err.retryable as boolean;
      }
      throw new Error("aurait dû lever");
    };
    expect(cas("content_filter")).toBe(false);
    expect(cas("stop")).toBe(true);
  });

  it("un appel d'outil sans texte n'est pas vide", () => {
    const r = parse(
      reply({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "t", function: { name: "meteo", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      req(),
    );
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls[0]!.function.name).toBe("meteo");
  });

  it("alias null pour un modèle hors registre", () => {
    const r = parse(
      reply({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
      req("deepseek:un-modele-neuf"),
    );
    expect(r.alias).toBeNull();
    expect(r.model).toBe("un-modele-neuf");
  });
});

describe("streaming", () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    choices: [{ delta, finish_reason: finish }],
  });

  it("réassemble le texte et les arguments par index", () => {
    const etat = ADAPTER.newStreamState();
    const rendus = [
      chunk({ content: "bon" }),
      chunk({ content: "jour" }),
      chunk({
        tool_calls: [{ index: 0, id: "t1", function: { name: "meteo", arguments: '{"v' } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ille":"Lyon"}' } }] }),
      { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 7 } },
    ].flatMap((e) => ADAPTER.streamEvents(e, etat));

    expect(rendus.filter((e) => e.type === "text").map((e: any) => e.text)).toEqual([
      "bon",
      "jour",
    ]);

    // Le flux repasse par le MÊME `parse()` que le non-flux.
    const r = parse(ADAPTER.finalize(etat), req());
    expect(r.text).toBe("bonjour");
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ ville: "Lyon" });
    expect(r.usage.inputTokens).toBe(7);
  });

  it("un chunk d'usage sans `choices` ne casse rien", () => {
    const etat = ADAPTER.newStreamState();
    ADAPTER.streamEvents(chunk({ content: "a" }, "stop"), etat);
    expect(ADAPTER.streamEvents({ choices: [], usage: { prompt_tokens: 3 } }, etat)).toEqual([]);
    expect(parse(ADAPTER.finalize(etat), req()).usage.inputTokens).toBe(3);
  });
});

describe("extraBody", () => {
  it("ajouté au premier niveau du corps, après tout le reste", () => {
    const b = build(req("mistral-small", { extraBody: { prompt_cache_key: "app" } }));
    expect(b.body["prompt_cache_key"]).toBe("app");
    expect(build(req("mistral-small")).body["prompt_cache_key"]).toBeUndefined();
  });

  it("l'emporte sur ce que la lib a construit", () => {
    const b = build(req("or-glm", { extraBody: { reasoning: { effort: "low" } } }));
    expect(b.body["reasoning"]).toEqual({ effort: "low" });
  });

  it("mistral-small : effort none coupe le raisonnement", () => {
    expect(build(req("mistral-small", { effort: "none" })).body["reasoning_effort"]).toBe("none");
    expect(build(req("mistral-small", { effort: "high" })).body["reasoning_effort"]).toBe("high");
    // `low` n'est pas sur l'échelle : ramené à la valeur la plus proche.
    expect(build(req("mistral-small", { effort: "low" })).body["reasoning_effort"]).toBe("none");
    expect(build(req("mistral", { effort: "high" })).body["reasoning_effort"]).toBeUndefined();
  });
});
