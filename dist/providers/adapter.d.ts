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
import type { StreamEvent } from "../stream.js";
import type { ContentPart, Effort, FinishReason, JsonSchema, Message, ModelSpec, Prompt, Response, ToolChoice, ToolDef, Usage } from "../types.js";
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
export declare function emptyUsage(): Usage;
export declare function addUsage(a: Usage, b: Usage): Usage;
/**
 * `string | Message[]` → `{ messages, system }`.
 *
 * Les messages `role: "system"` du prompt sont extraits et fusionnés avec
 * l'argument `system`, dans cet ordre. Un seul endroit décide, donc les deux
 * adaptateurs n'ont plus à se poser la question.
 */
export declare function normalizePrompt(prompt: Prompt, system?: string): {
    messages: Message[];
    system: string | null;
};
export declare function messageText(m: Message): string;
/** Contenu d'un message en liste de parties, quelle que soit sa forme d'entrée. */
export declare function contentParts(m: Message): ContentPart[];
export declare function mergeSystem(...morceaux: (string | null | undefined)[]): string | null;
/**
 * Refuse AVANT d'envoyer ce que le modèle ne sait pas faire.
 *
 * Un `ConfigError` immédiat vaut mieux qu'un 400 obscur trois secondes plus
 * tard, et mieux encore qu'un `tools` silencieusement ignoré.
 */
export declare function checkCapabilities(req: Request): void;
/**
 * `tool_choice` effectif, et l'instruction de repli s'il a fallu dégrader.
 *
 * Claude Fable 5.1 répond 400 à `tool_choice` `any`/`tool` : on retombe sur
 * `auto` en demandant l'outil dans le prompt, plutôt que de faire échouer
 * l'appel.
 */
export declare function resolveToolChoice(req: Request): {
    choice: string;
    instruction: string | null;
};
export declare function obj(value: unknown): Record<string, unknown>;
export declare function str(value: unknown, fallback?: string): string;
export declare function num(value: unknown, fallback?: number): number;
export declare function arr(value: unknown): unknown[];
export declare function baseResponse(req: Request, finishReason: FinishReason | null): Response;
export declare function parseArguments(raw: string): Record<string, unknown>;
//# sourceMappingURL=adapter.d.ts.map