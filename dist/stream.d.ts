/**
 * Événements de streaming, communs aux deux protocoles.
 *
 * Un flux rend la même séquence quel que soit le fournisseur : `text`* puis
 * éventuellement `tool_call`*, et toujours un `done` final qui porte la
 * `Response` complète (usage, coût, `finishReason`). Boucler sur les deltas OU
 * attendre le `done` sont donc deux façons valables de consommer.
 *
 * `TextStream` ajoute la commodité qui compte à l'usage :
 *
 *     for await (const morceau of stream("Raconte")) process.stdout.write(morceau);
 *     const total = await stream("Raconte").response;
 */
import type { Response } from "./types.js";
export type TextDelta = {
    type: "text";
    text: string;
};
/** Résumé de raisonnement, quand le fournisseur en émet. */
export type ReasoningDelta = {
    type: "reasoning";
    text: string;
};
/** Fragment d'appel d'outil. `arguments` arrive en morceaux de JSON. */
export type ToolCallDelta = {
    type: "tool_call";
    index: number;
    id?: string;
    name?: string;
    arguments: string;
};
export type DoneEvent = {
    type: "done";
    response: Response;
};
export type StreamEvent = TextDelta | ReasoningDelta | ToolCallDelta | DoneEvent;
/**
 * Flux de texte : itérable de chaînes, plus les événements bruts et la
 * réponse finale.
 */
export type TextStream = AsyncIterable<string> & {
    /** Réponse complète une fois le flux terminé (usage, coût, finishReason). */
    readonly response: Promise<Response>;
    /** Le flux d'événements, quand les deltas d'outils comptent. */
    readonly events: AsyncIterable<StreamEvent>;
};
/**
 * Enveloppe un flux d'événements en `TextStream`.
 *
 * La source est consommée AVIDEMENT, dans une tâche de fond, et les événements
 * sont tamponnés. C'est ce qui fait marcher les deux usages naturels :
 *
 *   - `await stream(…).response` seul — sans avidité, la promesse n'aurait
 *     jamais été résolue puisque personne ne tire le générateur ;
 *   - `for await (… of stream(…))` puis `await .response`.
 *
 * Le tampon permet aussi à plusieurs consommateurs (texte ET `events`) de tout
 * voir. Perdre la contre-pression est sans conséquence ici : un flux de réponse
 * LLM tient dans quelques kilo-octets.
 */
export declare function toTextStream(source: AsyncIterable<StreamEvent>): TextStream;
//# sourceMappingURL=stream.d.ts.map