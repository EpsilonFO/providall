/**
 * Socle des adaptateurs : requête résolue, normalisation, vérifications.
 *
 * Le pipeline d'un appel est identique dans les deux langages :
 *
 *     résoudre le modèle
 *   → vérifier clé et capacités          (ConfigError avant tout octet envoyé)
 *   → normaliser le prompt               (system fusionné, parties multimodales)
 *   → build(request)      ← PUR          (testable sans réseau)
 *   → fetch / SSE         ← le seul I/O
 *   → parse(raw)          ← PUR
 *   → coût, hook, Response
 *
 * `build` et `parse` purs, c'est ce qui permet de tester la totalité de la
 * traduction sans une seule requête.
 */

import { CapabilityError } from "../errors.js";
import type { StreamEvent } from "../stream.js";
import type {
  ContentPart,
  Effort,
  FinishReason,
  JsonSchema,
  Message,
  ModelSpec,
  Prompt,
  Response,
  ToolChoice,
  ToolDef,
  Usage,
} from "../types.js";

/** Tout ce dont un adaptateur a besoin. Aucune lecture d'environnement au-delà. */
export type Request = {
  spec: ModelSpec;
  messages: Message[];
  system: string | null;
  maxTokens: number;
  effort: Effort | null;
  temperature: number | null;
  tools: ToolDef[] | null;
  toolChoice: ToolChoice | null;
  jsonSchema: JsonSchema | null;
  /** Mode JSON demandé sans schéma exploitable (`json: true`). */
  jsonOnly: boolean;
  stream: boolean;
  apiKey: string;
  baseUrl: string;
  label: string;
  /** Ajouté au corps après tout le reste (`extraBody` à l'appel). */
  extraBody?: Record<string, unknown> | null;
};

export type BuiltRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type Adapter = {
  protocol: string;
  build: (req: Request) => BuiltRequest;
  parse: (raw: unknown, req: Request) => Response;
  /** Traduit un événement SSE natif en événements providall. */
  streamEvents: (event: Record<string, unknown>, state: StreamState) => StreamEvent[];
  /** Assemble l'état d'un flux en objet de la même forme qu'une réponse non streamée. */
  finalize: (state: StreamState) => unknown;
  newStreamState: () => StreamState;
};

/** État mutable d'un flux en cours d'assemblage. */
export type StreamState = Record<string, unknown>;

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/* ------------------------------------------------------------------------ */
/* Normalisation du prompt                                                    */
/* ------------------------------------------------------------------------ */

/**
 * `string | Message[]` → `{ messages, system }`.
 *
 * Les messages `role: "system"` du prompt sont extraits et fusionnés avec
 * l'argument `system`, dans cet ordre. Un seul endroit décide, donc les deux
 * adaptateurs n'ont plus à se poser la question.
 */
export function normalizePrompt(
  prompt: Prompt,
  system?: string,
): { messages: Message[]; system: string | null } {
  const entrants: Message[] =
    typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;

  const systemes: string[] = [];
  if (system?.trim()) systemes.push(system.trim());
  const restants: Message[] = [];
  for (const m of entrants) {
    if (m.role === "system") {
      const texte = messageText(m).trim();
      if (texte) systemes.push(texte);
    } else {
      restants.push(m);
    }
  }
  return { messages: restants, system: systemes.join("\n\n") || null };
}

export function messageText(m: Message): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

/** Contenu d'un message en liste de parties, quelle que soit sa forme d'entrée. */
export function contentParts(m: Message): ContentPart[] {
  if (typeof m.content === "string") {
    return m.content ? [{ type: "text", text: m.content }] : [];
  }
  return Array.isArray(m.content) ? m.content : [];
}

export function mergeSystem(...morceaux: (string | null | undefined)[]): string | null {
  const gardes = morceaux.map((m) => m?.trim()).filter((m): m is string => Boolean(m));
  return gardes.length ? gardes.join("\n\n") : null;
}

/**
 * Refuse AVANT d'envoyer ce que le modèle ne sait pas faire.
 *
 * Un `ConfigError` immédiat vaut mieux qu'un 400 obscur trois secondes plus
 * tard, et mieux encore qu'un `tools` silencieusement ignoré.
 */
export function checkCapabilities(req: Request): void {
  const { spec } = req;
  const ctx = { provider: spec.provider, model: spec.alias };
  if (req.tools?.length && !spec.caps.tools) {
    throw new CapabilityError("appels d'outils", {
      ...ctx,
      hint: "choisir un autre modèle, ou retirer `tools`",
    });
  }
  if (req.stream && !spec.caps.stream) throw new CapabilityError("streaming", ctx);
  for (const m of req.messages) {
    for (const part of contentParts(m)) {
      if ((part.type === "image_url" || part.type === "image_base64") && !spec.caps.vision) {
        throw new CapabilityError("images en entrée", {
          ...ctx,
          hint: "`caps.vision` est faux pour ce provider dans registry/providers.json",
        });
      }
    }
  }
}

/**
 * `tool_choice` effectif, et l'instruction de repli s'il a fallu dégrader.
 *
 * Claude Fable 5.1 répond 400 à `tool_choice` `any`/`tool` : on retombe sur
 * `auto` en demandant l'outil dans le prompt, plutôt que de faire échouer
 * l'appel.
 */
export function resolveToolChoice(req: Request): { choice: string; instruction: string | null } {
  const choix = req.toolChoice ?? (req.tools?.length ? "auto" : "none");
  if (choix !== "required") return { choice: choix, instruction: null };
  if (req.spec.caps.forced_tool_choice) return { choice: "required", instruction: null };
  const noms = (req.tools ?? []).map((t) => t.name).join(", ");
  return {
    choice: "auto",
    instruction:
      `Tu dois appeler l'un de ces outils pour répondre : ${noms}. ` +
      "N'écris pas de réponse en texte à la place.",
  };
}

/* ------------------------------------------------------------------------ */
/* Lecture défensive des réponses                                             */
/* ------------------------------------------------------------------------ */

export function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function baseResponse(req: Request, finishReason: FinishReason | null): Response {
  return {
    text: "",
    message: { role: "assistant", content: "" },
    toolCalls: [],
    reasoning: null,
    usage: emptyUsage(),
    costUsd: null,
    latencyMs: 0,
    model: req.spec.modelId,
    // `alias` est null hors registre : c'est ce qui distingue `sonnet` de
    // `anthropic:un-modele-tout-neuf` dans les logs et les rapports.
    alias: req.spec.alias.includes(":") ? null : req.spec.alias,
    provider: req.spec.provider,
    finishReason,
    attempts: 1,
    raw: null,
  };
}

export function parseArguments(raw: string): Record<string, unknown> {
  try {
    const valeur: unknown = JSON.parse(raw || "{}");
    return typeof valeur === "object" && valeur !== null
      ? (valeur as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
