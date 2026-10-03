/**
 * Types du format pivot et des réponses.
 *
 * Le pivot interne est celui de chat-completions (messages + `tool_calls`) :
 * c'est le dialecte que huit fournisseurs sur dix parlent nativement, donc
 * c'est là que la traduction coûte le moins cher. L'adaptateur Anthropic est
 * le seul à faire un vrai travail de conversion.
 *
 * Convention de nommage (identique en Python) : tout ce qui voyage sur le fil
 * — `tool_calls`, `tool_call_id`, `image_url` — garde son nom snake_case dans
 * les deux langages. Le reste suit la convention du langage.
 */

import type { ProvidallError } from "./errors.js";

export type Effort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["none", "low", "medium", "high", "xhigh", "max"];

export type Protocol = "anthropic" | "openai_compat";
export type Structured = "json_schema" | "json_object" | "prompt";
export type Thinking = "adaptive" | "budget" | "none";
export type Role = "system" | "user" | "assistant" | "tool";
export type ToolChoice = "auto" | "none" | "required";
export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "refusal"
  | "pause"
  | "other";

/** Ce qu'un modèle sait faire. Vérifié AVANT l'envoi, pas découvert en 400. */
export type Caps = {
  tools: boolean;
  structured: Structured;
  effort: boolean;
  thinking: Thinking;
  vision: boolean;
  temperature: boolean;
  forced_tool_choice: boolean;
  stream: boolean;
};

/**
 * Détails de protocole qui varient d'un fournisseur à l'autre.
 *
 * `maxTokensParam` : les modèles à raisonnement d'OpenAI ont renommé
 * `max_tokens` en `max_completion_tokens` et rejettent l'ancien par un 400.
 * `effortValues` : l'échelle acceptée par le fournisseur ; une valeur hors
 * échelle est ramenée à la plus proche plutôt que de faire échouer l'appel.
 */
export type Wire = {
  maxTokensParam: string;
  effortParam: string | null;
  effortValues: readonly string[];
  /** Fournisseur dont `effort: "none"` se dit par un interrupteur dédié
   *  (`thinking.type = disabled` chez DeepSeek), hors échelle d'effort. */
  thinkingToggle: "deepseek" | null;
};

export type ProviderSpec = {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKeyEnv: string;
  aliases: readonly string[];
  defaultModel: string;
  keyUrl: string;
  requiresKey: boolean;
  caps: Caps;
  wire: Wire;
  maxTokens: number;
  effort: Effort | null;
  note: string;
};

/**
 * Un modèle résolu : tout ce qu'il faut pour construire une requête.
 *
 * Fusion de `ModelSpec` (monumia) et `ProviderSpec` (agenda) : le fournisseur
 * n'est plus qu'un jeu de valeurs par défaut, aplati ici une fois pour toutes.
 */
export type ModelSpec = {
  alias: string;
  provider: string;
  protocol: Protocol;
  modelId: string;
  apiKeyEnv: string;
  baseUrl: string;
  requiresKey: boolean;
  keyUrl: string;
  caps: Caps;
  wire: Wire;
  maxTokens: number;
  effort: Effort | null;
  priceIn: number | null;
  priceOut: number | null;
  priceCacheRead: number | null;
  idVerified: boolean;
  note: string;
};

export type ToolCall = {
  id: string;
  /** JSON brut : les modèles échappent différemment, on ne parse qu'au besoin. */
  function: { name: string; arguments: string };
};

/** Partie de contenu multimodal. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; url: string }
  | { type: "image_base64"; media_type: string; data: string };

export type Message = {
  role: Role;
  content?: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  /** Sur un message `role: "tool"` : l'id de l'appel auquel il répond. */
  tool_call_id?: string;
  name?: string;
  /**
   * Réponse native brute du provider qui a produit ce message, à rejouer telle
   * quelle si on le renvoie dans l'historique. Indispensable chez Anthropic :
   * un `tool_use` détaché du bloc de raisonnement signé qui l'a produit est
   * refusé.
   *
   * Étiqueté par provider : si la conversation change de fournisseur en cours
   * de route, le bloc est ignoré et le message reconstruit en texte + outils.
   */
  _raw?: { provider: string; items: unknown };
};

export type Prompt = string | Message[];

export type Usage = {
  /** Jetons d'entrée HORS cache — normalisé ainsi dans les deux adaptateurs. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

/** Retour uniforme, quel que soit le fournisseur. */
export type Response = {
  text: string;
  message: Message;
  toolCalls: ToolCall[];
  reasoning: string | null;
  usage: Usage;
  costUsd: number | null;
  latencyMs: number;
  /** Identifiant réellement envoyé au fournisseur. */
  model: string;
  /** Alias du registre, ou `null` pour un modèle hors registre. */
  alias: string | null;
  provider: string;
  finishReason: FinishReason | null;
  attempts: number;
  raw: unknown;
  /** Renseigné uniquement par `tryComplete`, qui ne rejette jamais. */
  error?: ProvidallError;
};

/** `tryComplete` : succès ou échec, jamais d'exception. */
export type TryResult<T> =
  | { ok: true; value: T; error?: undefined }
  | { ok: false; value?: undefined; error: ProvidallError };

/**
 * Interface Standard Schema — zod 4, valibot, arktype… sans importer aucun
 * des trois. C'est ce qui permet à ce package d'avoir zéro dépendance runtime
 * tout en validant des sorties.
 */
export type StandardSchemaV1<Output = unknown> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: unknown; readonly output: Output } | undefined;
  };
};

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[]; readonly value?: undefined };

export type StandardIssue = {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
};

export type Schema<T> = StandardSchemaV1<T>;
export type InferSchema<S> = S extends StandardSchemaV1<infer T> ? T : never;

export type JsonSchema = Record<string, unknown>;

export type Env = Record<string, string | undefined>;

export type FetchLike = (input: string, init: RequestInit) => Promise<globalThis.Response>;

export type Logger = {
  debug: (message: string, ...rest: unknown[]) => void;
  info: (message: string, ...rest: unknown[]) => void;
  warn: (message: string, ...rest: unknown[]) => void;
};

/** Outil au format pivot. */
export type ToolDef = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export type CompleteOptions = {
  model?: string;
  role?: string;
  system?: string;
  maxTokens?: number;
  effort?: Effort | string;
  temperature?: number;
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  /** Schéma JSON à imposer au fournisseur. `true` = simple mode JSON. */
  json?: JsonSchema | true;
  timeoutMs?: number;
  retries?: number;
  label?: string;
  signal?: AbortSignal;
  fetch?: FetchLike;
  env?: Env;
  logger?: Logger;
  apiKey?: string;
  baseUrl?: string;
  /**
   * Paramètres propres à un fournisseur, ajoutés tels quels au corps de la
   * requête après tout le reste. Échappatoire pour ce que providall ne
   * modélise pas : `prompt_cache_key` chez Mistral, un réglage de sécurité,
   * un paramètre sorti ce matin. Il l'emporte en cas de conflit.
   */
  extraBody?: Record<string, unknown>;
  onResponse?: (response: Response) => void;
};
