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
 * La lib ne lit jamais de fichier `.env` : Next.js le fait lui-même, Node a
 * `process.loadEnvFile()`. Seule la CLI en charge un.
 */

export {
  complete,
  createClient,
  errorResponse,
  prepare,
  stream,
  tryComplete,
} from "./complete.js";
export type { Client, ClientConfig } from "./complete.js";

export {
  completeJson,
  completeJsonResult,
  tryCompleteJson,
  DEFAULT_MAX_REPAIRS,
  REPAIR_PROMPT,
} from "./json.js";
export type { JsonOptions, JsonResult } from "./json.js";

export { defineTool, toolLoop, DEFAULT_MAX_TURNS } from "./tools.js";
export type { Tool, ToolLoopOptions, ToolLoopResult } from "./tools.js";

export { toTextStream } from "./stream.js";
export type {
  DoneEvent,
  ReasoningDelta,
  StreamEvent,
  TextDelta,
  TextStream,
  ToolCallDelta,
} from "./stream.js";

export {
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  apiKeyFor,
  baseUrlFor,
  describeConfig,
  envDefaults,
  keyPresent,
  listModels,
  resolve,
  resolveModel,
} from "./config.js";
export type { EnvDefaults, Resolution, ResolveOptions } from "./config.js";

export {
  MODELS,
  PROTOCOL_DEFAULTS,
  PROVIDERS,
  clampEffort,
  findProvider,
  listProviders,
  priceKnown,
  registerModel,
  registerProvider,
  resolveSpec,
  spec,
} from "./registry.js";
export type { SpecOverrides } from "./registry.js";

export { CACHE_WRITE_MULTIPLIER, addCost, computeCost, formatCost } from "./pricing.js";
export { consoleLogger, logLine, silentLogger } from "./log.js";
export { formatIssues, harden, isSchema, parseJsonLoose, schemaInstruction, validate } from "./schema.js";
export { defaultEnv, envBool, envNum, envStr, normalizeEffort } from "./env.js";

export {
  APIError,
  AuthError,
  BadRequestError,
  CapabilityError,
  ConfigError,
  EmptyResponseError,
  MissingKeyError,
  NetworkError,
  NotFoundError,
  OutputValidationError,
  ProvidallError,
  RateLimitError,
  RefusalError,
  ServerError,
  TimeoutError,
  UnknownModelError,
  fromHttp,
  toProvidallError,
} from "./errors.js";

export { adapterFor, ADAPTERS } from "./providers/index.js";
export type { Adapter, BuiltRequest, Request } from "./providers/index.js";

export { EFFORTS } from "./types.js";
export type {
  Caps,
  CompleteOptions,
  ContentPart,
  Effort,
  Env,
  FetchLike,
  FinishReason,
  InferSchema,
  JsonSchema,
  Logger,
  Message,
  ModelSpec,
  Prompt,
  Protocol,
  ProviderSpec,
  Response,
  Role,
  Schema,
  StandardSchemaV1,
  Structured,
  Thinking,
  ToolCall,
  ToolChoice,
  ToolDef,
  ToolHandler,
  TryResult,
  Usage,
  Wire,
} from "./types.js";

export type { ModelAlias, ProviderName } from "./registry.data.js";

export const VERSION = "0.1.0";
