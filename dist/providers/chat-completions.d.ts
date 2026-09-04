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
import type { Message, Response, ToolCall } from "../types.js";
import type { Adapter, BuiltRequest, Request } from "./adapter.js";
type NativeMessage = Record<string, unknown>;
export declare function build(req: Request): BuiltRequest;
export declare function toNativeMessages(messages: Message[], system: string | null): NativeMessage[];
/**
 * DeepSeek (et d'autres) exigent le mot « json » dans le prompt en mode JSON.
 * Sans lui, l'API refuse la requête ou boucle à vide. On l'ajoute seulement si
 * l'appelant ne l'a pas déjà écrit.
 */
export declare function ensureJsonHint(messages: NativeMessage[]): NativeMessage[];
export declare function parse(raw: unknown, req: Request): Response;
export declare function parseToolCalls(raw: unknown): ToolCall[];
export declare const ADAPTER: Adapter;
export {};
//# sourceMappingURL=chat-completions.d.ts.map