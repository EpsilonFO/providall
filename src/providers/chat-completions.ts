/**
 * Adaptateur Chat Completions — tout le monde sauf Anthropic.
 *
 * OpenAI, Gemini, xAI, Moonshot, z.ai, Mistral, DeepSeek, OpenRouter, Groq,
 * Ollama, vLLM… parlent ce dialecte. Comme c'est le format pivot de la lib, la
 * traduction se réduit à du nettoyage — mais chaque implémentation a sa
 * particularité, et c'est leur somme qui justifie ce fichier :
 *
 *   - `max_completion_tokens` chez OpenAI (400 sur `max_tokens`) ;
 *   - `response_format` tri-état, parce que `json_object` garantit du JSON
 *     valide et pas conforme, et qu'OpenRouter le transmet tel quel au modèle
 *     routé (qui répond 400 s'il ne le connaît pas) ;
 *   - le mot « json » exigé dans le prompt par DeepSeek ;
 *   - `content: ""` et non `null` sur un assistant sans texte (Mistral) ;
 *   - des ids d'appel d'outil parfois absents ;
 *   - `reasoning_content` (DeepSeek) qui n'existe nulle part ailleurs ;
 *   - pas d'en-tête `Authorization` du tout sur un serveur local.
 *
 * L'API Responses d'OpenAI n'est pas retenue : aucun tiers ne la parle, et ce
 * qu'elle apporte ici (`reasoning_effort`) passe déjà par Chat Completions.
 */

import { EmptyResponseError } from "../errors.js";
import { joinUrl } from "../http.js";
import { clampEffort } from "../registry.js";
import { schemaInstruction } from "../schema.js";
import type { StreamEvent } from "../stream.js";
import type { ContentPart, FinishReason, Message, Response, ToolCall, Usage } from "../types.js";
import {
  arr,
  baseResponse,
  contentParts,
  mergeSystem,
  messageText,
  num,
  obj,
  resolveToolChoice,
  str,
} from "./adapter.js";
import type { Adapter, BuiltRequest, Request, StreamState } from "./adapter.js";

const FINISH: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  content_filter: "content_filter",
};

type NativeMessage = Record<string, unknown>;

/* ------------------------------------------------------------------------ */
/* build                                                                      */
/* ------------------------------------------------------------------------ */

export function build(req: Request): BuiltRequest {
  const { spec } = req;
  const { choice, instruction } = resolveToolChoice(req);
  let system = mergeSystem(req.system, instruction);

  let responseFormat: Record<string, unknown> | null = null;
  if (req.jsonSchema) {
    const mode = spec.caps.structured;
    if (mode === "json_schema") {
      responseFormat = {
        type: "json_schema",
        json_schema: { name: "response", strict: true, schema: req.jsonSchema },
      };
    } else if (mode === "json_object") {
      responseFormat = { type: "json_object" };
    }
    // `prompt` : rien sur le fil. Dans les trois cas le schéma part aussi dans
    // le système — une contrainte dure n'empêche pas le modèle d'avoir besoin
    // de savoir ce qu'on attend, et sans elle `json_object` invente des clés.
    system = mergeSystem(system, schemaInstruction(req.jsonSchema));
  } else if (req.jsonOnly && spec.caps.structured !== "prompt") {
    responseFormat = { type: "json_object" };
  }

  let messages = toNativeMessages(req.messages, system);
  if (responseFormat?.["type"] === "json_object") messages = ensureJsonHint(messages);

  const body: Record<string, unknown> = {
    model: spec.modelId,
    messages,
    [spec.wire.maxTokensParam]: req.maxTokens,
  };
  if (responseFormat) body["response_format"] = responseFormat;
  if (req.temperature !== null && spec.caps.temperature) body["temperature"] = req.temperature;

  if (spec.caps.effort) {
    const voulu = req.effort ?? spec.effort;
    if (voulu === "none" && spec.wire.thinkingToggle === "deepseek") {
      // DeepSeek V4 : « none » n'est pas sur l'échelle de reasoning_effort —
      // c'est l'interrupteur qui coupe la chaîne de pensée.
      body["thinking"] = { type: "disabled" };
    } else {
      const effort = clampEffort(voulu, spec.wire);
      if (effort) {
        if (spec.wire.effortParam === "reasoning_effort") {
          body["reasoning_effort"] = effort;
        } else if (spec.wire.effortParam === "openrouter_reasoning") {
          // Paramètre unifié d'OpenRouter, hors schéma OpenAI. Sans lui, un
          // modèle à raisonnement dépense tout son budget de sortie en chaîne
          // de pensée : 405 s par appel, mesuré.
          body["reasoning"] = { effort };
        }
      }
    }
  }

  if (req.tools?.length) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: Object.keys(t.parameters).length
          ? t.parameters
          : { type: "object", properties: {} },
      },
    }));
    body["tool_choice"] = choice;
  }

  if (req.stream) {
    body["stream"] = true;
    // Sans ça, un flux ne rapporte aucun usage : ni coût ni jetons.
    body["stream_options"] = { include_usage: true };
  }

  // En dernier : un paramètre propre au fournisseur l'emporte sur ce que la
  // lib a construit (cf. `CompleteOptions.extraBody`).
  if (req.extraBody) Object.assign(body, req.extraBody);

  return {
    url: joinUrl(req.baseUrl, "/chat/completions"),
    // Serveur local sans authentification : pas d'en-tête plutôt qu'un
    // « Bearer » vide, que certains serveurs stricts rejettent.
    headers: req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {},
    body,
  };
}

export function toNativeMessages(messages: Message[], system: string | null): NativeMessage[] {
  const natifs: NativeMessage[] = [];
  if (system) natifs.push({ role: "system", content: system });

  for (const m of messages) {
    if (m.role === "tool") {
      const natif: NativeMessage = {
        role: "tool",
        tool_call_id: m.tool_call_id ?? "",
        content: messageText(m),
      };
      if (m.name) natif["name"] = m.name;
      natifs.push(natif);
      continue;
    }
    if (m.role === "assistant") {
      const sortie: NativeMessage = {
        role: "assistant",
        // Un assistant qui n'appelle que des outils a un content vide, pas
        // null : Mistral rejette null.
        content: messageText(m),
      };
      if (m.tool_calls?.length) {
        sortie["tool_calls"] = m.tool_calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.function.name, arguments: c.function.arguments || "{}" },
        }));
      }
      natifs.push(sortie);
      continue;
    }
    const parties = contentParts(m);
    const multimodal = parties.some((p) => p.type !== "text");
    natifs.push({
      role: m.role,
      content: multimodal ? parties.map(partToNative) : messageText(m),
    });
  }
  return natifs;
}

function partToNative(part: ContentPart): Record<string, unknown> {
  if (part.type === "image_url") {
    return { type: "image_url", image_url: { url: part.url } };
  }
  if (part.type === "image_base64") {
    return {
      type: "image_url",
      image_url: { url: `data:${part.media_type};base64,${part.data}` },
    };
  }
  return { type: "text", text: part.text };
}

/**
 * DeepSeek (et d'autres) exigent le mot « json » dans le prompt en mode JSON.
 * Sans lui, l'API refuse la requête ou boucle à vide. On l'ajoute seulement si
 * l'appelant ne l'a pas déjà écrit.
 */
export function ensureJsonHint(messages: NativeMessage[]): NativeMessage[] {
  if (messages.some((m) => /json/i.test(String(m["content"] ?? "")))) return messages;
  const indice = " Réponds uniquement avec un objet JSON valide.";
  const index = messages.findIndex((m) => m["role"] === "system");
  if (index >= 0) {
    const copie = [...messages];
    copie[index] = { ...copie[index], content: `${String(copie[index]!["content"] ?? "")}${indice}` };
    return copie;
  }
  return [{ role: "system", content: indice.trim() }, ...messages];
}

/* ------------------------------------------------------------------------ */
/* parse                                                                      */
/* ------------------------------------------------------------------------ */

export function parse(raw: unknown, req: Request): Response {
  const data = obj(raw);
  const choix = obj(arr(data["choices"])[0]);
  if (!Object.keys(choix).length) {
    throw new EmptyResponseError("réponse sans `choices`", {
      provider: req.spec.provider,
      model: req.spec.alias,
    });
  }
  const msg = obj(choix["message"]);
  const finish = str(choix["finish_reason"]) || null;
  const contenu = msg["content"];
  const texte = typeof contenu === "string" ? contenu : joinTextParts(contenu);
  const appels = parseToolCalls(msg["tool_calls"]);
  const usage = parseUsage(obj(data["usage"]));

  if (!texte && !appels.length) {
    throw new EmptyResponseError(diagnosticVide(finish, req.maxTokens, usage.outputTokens), {
      finishReason: finish,
      // `length` et `content_filter` sont des CAUSES, pas des ratés : elles se
      // reproduiraient. Seul le vide inexpliqué se rejoue.
      retryable: finish !== "length" && finish !== "content_filter",
      provider: req.spec.provider,
      model: req.spec.alias,
    });
  }

  const reponse = baseResponse(req, finish ? (FINISH[finish] ?? "other") : null);
  reponse.text = texte;
  reponse.toolCalls = appels;
  // DeepSeek expose sa chaîne de pensée ici ; personne d'autre ne le fait.
  reponse.reasoning = str(msg["reasoning_content"]) || null;
  reponse.usage = usage;
  reponse.raw = raw;
  reponse.message = {
    role: "assistant",
    content: texte,
    ...(appels.length ? { tool_calls: appels } : {}),
    // Rien à rejouer : ce dialecte accepte qu'on lui renvoie le message pivot.
  };
  return reponse;
}

export function parseToolCalls(raw: unknown): ToolCall[] {
  return arr(raw)
    .map(obj)
    .map((c, i) => {
      const fonction = obj(c["function"]);
      const nom = str(fonction["name"]);
      if (!nom) return null;
      const brut = fonction["arguments"];
      return {
        // Certains serveurs compatibles omettent l'id : sans lui, le message
        // `tool` de réponse ne peut pas être rattaché.
        id: str(c["id"]) || `call_${i}`,
        function: {
          name: nom,
          arguments: typeof brut === "string" ? brut : JSON.stringify(brut ?? {}),
        },
      };
    })
    .filter((c): c is ToolCall => c !== null);
}

function joinTextParts(contenu: unknown): string {
  return arr(contenu)
    .map(obj)
    .filter((p) => p["type"] === "text")
    .map((p) => str(p["text"]))
    .join("");
}

function parseUsage(usage: Record<string, unknown>): Usage {
  const prompt = num(usage["prompt_tokens"]);
  const cache = num(obj(usage["prompt_tokens_details"])["cached_tokens"]);
  return {
    // `prompt_tokens` inclut le cache ici, contrairement à Anthropic : on le
    // retire pour que `inputTokens` veuille dire la même chose partout.
    inputTokens: Math.max(prompt - cache, 0),
    outputTokens: num(usage["completion_tokens"]),
    cacheReadTokens: cache,
    cacheWriteTokens: 0,
    reasoningTokens: num(obj(usage["completion_tokens_details"])["reasoning_tokens"]),
  };
}

/** Message de monumia, conservé mot pour mot : il a coûté un benchmark. */
function diagnosticVide(finish: string | null, maxTokens: number, sortie: number): string {
  if (finish === "length") {
    return (
      `contenu vide — budget de sortie épuisé avant la réponse (${maxTokens} jetons), ` +
      `modèle à raisonnement : augmenter maxTokens (${sortie} jetons de sortie facturés)`
    );
  }
  if (finish === "content_filter") return "contenu vide — réponse filtrée par le fournisseur";
  return `contenu vide — finish_reason=${JSON.stringify(finish)} (${sortie} jetons de sortie facturés)`;
}

/* ------------------------------------------------------------------------ */
/* Streaming                                                                  */
/* ------------------------------------------------------------------------ */

type ChatState = {
  text: string[];
  reasoning: string[];
  finishReason: string | null;
  usage: Record<string, unknown>;
  tools: Map<number, { id: string; name: string; arguments: string }>;
};

function newStreamState(): StreamState {
  return {
    text: [],
    reasoning: [],
    finishReason: null,
    usage: {},
    tools: new Map(),
  } satisfies ChatState as unknown as StreamState;
}

function streamEvents(chunk: Record<string, unknown>, raw: StreamState): StreamEvent[] {
  const state = raw as unknown as ChatState;
  const evenements: StreamEvent[] = [];

  const usage = obj(chunk["usage"]);
  if (Object.keys(usage).length) state.usage = usage;

  const choix = obj(arr(chunk["choices"])[0]);
  if (!Object.keys(choix).length) return evenements;

  const finish = str(choix["finish_reason"]);
  if (finish) state.finishReason = finish;

  const delta = obj(choix["delta"]);
  const morceau = str(delta["content"]);
  if (morceau) {
    state.text.push(morceau);
    evenements.push({ type: "text", text: morceau });
  }
  const pensee = str(delta["reasoning_content"]);
  if (pensee) {
    state.reasoning.push(pensee);
    evenements.push({ type: "reasoning", text: pensee });
  }

  for (const brut of arr(delta["tool_calls"])) {
    // Les fragments sont repérés par `index`, pas par `id` : l'id n'arrive que
    // dans le premier fragment de chaque appel.
    const appel = obj(brut);
    const index = num(appel["index"]);
    const courant = state.tools.get(index) ?? { id: "", name: "", arguments: "" };
    const fonction = obj(appel["function"]);
    const id = str(appel["id"]);
    const nom = str(fonction["name"]);
    const arguments_ = str(fonction["arguments"]);
    if (id) courant.id = id;
    if (nom) courant.name = nom;
    if (arguments_) courant.arguments += arguments_;
    state.tools.set(index, courant);
    evenements.push({
      type: "tool_call",
      index,
      ...(id ? { id } : {}),
      ...(nom ? { name: nom } : {}),
      arguments: arguments_,
    });
  }
  return evenements;
}

/** État du flux → objet de la même forme qu'une réponse non streamée. */
function finalize(raw: StreamState): unknown {
  const state = raw as unknown as ChatState;
  const message: Record<string, unknown> = { role: "assistant", content: state.text.join("") };
  if (state.reasoning.length) message["reasoning_content"] = state.reasoning.join("");
  if (state.tools.size) {
    message["tool_calls"] = [...state.tools.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, t]) => ({
        id: t.id || `call_${index}`,
        type: "function",
        function: { name: t.name, arguments: t.arguments || "{}" },
      }));
  }
  return {
    choices: [{ message, finish_reason: state.finishReason }],
    usage: state.usage,
  };
}

export const ADAPTER: Adapter = {
  protocol: "openai_compat",
  build,
  parse,
  streamEvents,
  finalize,
  newStreamState,
};
