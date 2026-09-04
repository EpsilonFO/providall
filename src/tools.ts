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

import { complete } from "./complete.js";
import { addCost } from "./pricing.js";
import { addUsage, emptyUsage, parseArguments } from "./providers/adapter.js";
import type {
  CompleteOptions,
  JsonSchema,
  Message,
  Prompt,
  Response,
  Schema,
  ToolCall,
  ToolDef,
  ToolHandler,
  Usage,
} from "./types.js";

export const DEFAULT_MAX_TURNS = 20;

/** Un outil : sa définition pour le modèle, et le code qui l'exécute. */
export type Tool = ToolDef & { handler?: ToolHandler };

/**
 * Déclare un outil.
 *
 * `parameters` accepte un JSON Schema brut. Un schéma Standard Schema est
 * accepté aussi, mais il faut alors fournir le JSON Schema : l'interface ne
 * l'expose pas (`z.toJSONSchema(S)`).
 */
export function defineTool(t: {
  name: string;
  description?: string;
  parameters: JsonSchema | Schema<unknown>;
  jsonSchema?: JsonSchema;
  handler?: ToolHandler;
}): Tool {
  const parameters =
    t.jsonSchema ??
    (isJsonSchema(t.parameters) ? t.parameters : { type: "object", properties: {} });
  return {
    name: t.name,
    description: t.description ?? "",
    parameters,
    ...(t.handler ? { handler: t.handler } : {}),
  };
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return (
    typeof value === "object" && value !== null && !("~standard" in value) && !Array.isArray(value)
  );
}

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

export async function toolLoop(input: Prompt, opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const { tools, maxTurns = DEFAULT_MAX_TURNS, onCall, ...reste } = opts;
  const table = new Map(tools.map((t) => [t.name, t]));
  const definitions: ToolDef[] = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));

  const conversation: Message[] = typeof input === "string"
    ? [{ role: "user", content: input }]
    : [...input];
  let cumul = emptyUsage();
  let cout: number | null = null;
  const appels: ToolCall[] = [];
  let derniere!: Response;

  for (let tour = 0; tour < maxTurns; tour++) {
    derniere = await complete(conversation, { ...reste, tools: definitions });
    cumul = addUsage(cumul, derniere.usage);
    cout = addCost(cout, derniere.costUsd);
    conversation.push(derniere.message);

    if (!derniere.toolCalls.length) {
      return resultat(derniere, conversation, tour + 1, "done", cumul, cout, appels);
    }

    // Les appels d'un même tour sont indépendants : les exécuter en parallèle,
    // et rendre tous les résultats avant le tour suivant.
    const resultats = await Promise.all(
      derniere.toolCalls.map((appel) => executer(table, appel)),
    );
    derniere.toolCalls.forEach((appel, i) => {
      appels.push(appel);
      const sortie = resultats[i]!;
      onCall?.(appel, sortie);
      conversation.push({
        role: "tool",
        tool_call_id: appel.id,
        name: appel.function.name,
        content: sortie,
      });
    });
  }

  return resultat(derniere, conversation, maxTurns, "max_turns", cumul, cout, appels);
}

function resultat(
  response: Response,
  messages: Message[],
  turns: number,
  stopped: "done" | "max_turns",
  usage: Usage,
  costUsd: number | null,
  calls: ToolCall[],
): ToolLoopResult {
  return { response, text: response.text, messages, turns, stopped, usage, costUsd, calls };
}

async function executer(table: Map<string, Tool>, appel: ToolCall): Promise<string> {
  const outil = table.get(appel.function.name);
  if (!outil?.handler) {
    return outil
      ? `ERREUR : outil ${appel.function.name} sans handler`
      : `ERREUR : outil inconnu ${JSON.stringify(appel.function.name)}. ` +
          `Outils disponibles : ${[...table.keys()].join(", ")}`;
  }
  try {
    return rendre(await outil.handler(parseArguments(appel.function.arguments)));
  } catch (err) {
    // L'erreur est une donnée pour le modèle, pas une panne pour l'appelant.
    return `ERREUR : ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }
}

function rendre(valeur: unknown): string {
  if (typeof valeur === "string") return valeur;
  try {
    return JSON.stringify(valeur ?? null);
  } catch {
    return String(valeur);
  }
}
