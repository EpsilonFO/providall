/**
 * providall — un appel LLM, n'importe quel fournisseur.
 *
 *     import { complete, completeJson } from "providall";
 *
 *     const r = await complete("Résume ce texte en une phrase.");
 *     const plan = await completeJson(MonSchema, prompt);
 *
 * Le modèle vient de `LLM_MODEL` dans l'environnement (`sonnet`, `ds-flash`,
 * ou `provider:identifiant` pour un modèle qui vient de sortir). Avec une
 * seule clé `*_API_KEY` posée, même `LLM_MODEL` est facultatif.
 *
 * Pour un modèle de décision (System One : Jev), `decide()` remplace
 * `complete()` — questions typées en entrée, probabilités en sortie.
 *
 * La lib ne lit jamais de fichier `.env` : Next.js le fait lui-même, Node a
 * `process.loadEnvFile()`. Seule la CLI en charge un.
 */
export { complete, createClient, errorResponse, prepare, stream, tryComplete, } from "./complete.js";
export type { Client, ClientConfig } from "./complete.js";
export { completeJson, completeJsonResult, tryCompleteJson, DEFAULT_MAX_REPAIRS, REPAIR_PROMPT, } from "./json.js";
export type { JsonOptions, JsonResult } from "./json.js";
export { choice, decide, noul, prepareDecision, score, tryDecide } from "./decide.js";
export { systemOneUrl } from "./providers/systemone.js";
export type { DecisionRequest } from "./providers/systemone.js";
export { defineTool, toolLoop, DEFAULT_MAX_TURNS } from "./tools.js";
export type { Tool, ToolLoopOptions, ToolLoopResult } from "./tools.js";
export { toTextStream } from "./stream.js";
export type { DoneEvent, ReasoningDelta, StreamEvent, TextDelta, TextStream, ToolCallDelta, } from "./stream.js";
export { DECISION_MODEL_VAR, DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, apiKeyFor, baseUrlFor, describeConfig, envDefaults, keyPresent, listModels, resolve, resolveDecision, resolveModel, } from "./config.js";
export type { EnvDefaults, Resolution, ResolveOptions } from "./config.js";
export { MODELS, PROTOCOL_DEFAULTS, PROVIDERS, clampEffort, findProvider, isSystemOne, listProviders, priceKnown, registerModel, registerProvider, resolveSpec, spec, } from "./registry.js";
export type { SpecOverrides } from "./registry.js";
export { CACHE_WRITE_MULTIPLIER, addCost, computeCost, formatCost } from "./pricing.js";
export { consoleLogger, decisionLogLine, logLine, silentLogger } from "./log.js";
export { formatIssues, harden, isSchema, parseJsonLoose, schemaInstruction, validate } from "./schema.js";
export { defaultEnv, envBool, envNum, envStr, normalizeEffort } from "./env.js";
export { APIError, AuthError, BadRequestError, CapabilityError, ConfigError, EmptyResponseError, MissingKeyError, NetworkError, NotFoundError, OutputValidationError, ProvidallError, RateLimitError, RefusalError, ServerError, TimeoutError, UnknownModelError, fromHttp, toProvidallError, } from "./errors.js";
export { adapterFor, ADAPTERS } from "./providers/index.js";
export type { Adapter, BuiltRequest, Request } from "./providers/index.js";
export { EFFORTS } from "./types.js";
export type { Answer, AnswerFor, Answers, Caps, ChoiceAnswer, ChoiceQuestion, CompleteOptions, ContentPart, DecideOptions, Decision, DecisionState, Effort, Env, FetchLike, FinishReason, InferSchema, Instructions, JsonSchema, Logger, Message, ModelSpec, NoulAnswer, NoulQuestion, Prompt, Protocol, ProviderSpec, Question, Questions, Response, Role, Schema, ScoreAnswer, ScoreQuestion, StandardSchemaV1, Structured, Thinking, ToolCall, ToolChoice, ToolDef, ToolHandler, TryResult, Usage, Wire, } from "./types.js";
export type { ModelAlias, ProviderName } from "./registry.data.js";
export declare const VERSION = "0.3.1";
//# sourceMappingURL=index.d.ts.map