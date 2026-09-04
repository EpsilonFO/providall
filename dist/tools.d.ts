/**
 * Outils et boucle d'agent.
 *
 * Port de `run_agent_loop` (monumia) et d'`agent.ts` (agenda), avec leurs deux
 * règles apprises à l'usage :
 *   - TOUS les `tool_result` d'un tour partent dans un seul message — les
 *     séparer apprend au modèle à ne plus paralléliser ses appels (l'adaptateur
 *     Anthropic s'en charge en fusionnant les rôles consécutifs) ;
 *   - une erreur de handler est RENVOYÉE au modèle, pas levée : il sait souvent
 *     se corriger, et une exception ferait perdre tout le tour.
 */
import type { CompleteOptions, JsonSchema, Message, Prompt, Response, Schema, ToolCall, ToolDef, ToolHandler, Usage } from "./types.js";
export declare const DEFAULT_MAX_TURNS = 20;
/** Un outil : sa définition pour le modèle, et le code qui l'exécute. */
export type Tool = ToolDef & {
    handler?: ToolHandler;
};
/**
 * Déclare un outil.
 *
 * `parameters` accepte un JSON Schema brut. Un schéma Standard Schema est
 * accepté aussi, mais il faut alors fournir le JSON Schema : l'interface ne
 * l'expose pas (`z.toJSONSchema(S)`).
 */
export declare function defineTool(t: {
    name: string;
    description?: string;
    parameters: JsonSchema | Schema<unknown>;
    jsonSchema?: JsonSchema;
    handler?: ToolHandler;
}): Tool;
export type ToolLoopOptions = CompleteOptions & {
    tools: Tool[];
    maxTurns?: number;
    onCall?: (call: ToolCall, result: string) => void;
};
/** Résultat d'une boucle : la réponse finale, plus ce qui s'est passé. */
export type ToolLoopResult = {
    response: Response;
    text: string;
    messages: Message[];
    turns: number;
    /** `done` (le modèle a fini) ou `max_turns` (plafond atteint). */
    stopped: "done" | "max_turns";
    usage: Usage;
    costUsd: number | null;
    calls: ToolCall[];
};
export declare function toolLoop(input: Prompt, opts: ToolLoopOptions): Promise<ToolLoopResult>;
//# sourceMappingURL=tools.d.ts.map