/**
 * `createClient` et le pipeline d'un appel.
 *
 * Les fonctions de module (`complete(...)`) délèguent à un client par défaut.
 * Un projet qui veut fixer un modèle, un timeout ou un logger une fois pour
 * toutes se construit le sien ; les deux surfaces sont identiques.
 *
 * `fetch` et `env` sont injectables partout. Ce n'est pas de la coquetterie :
 * c'est ce qui permet à toute la suite de tests de tourner sans réseau, et à
 * un projet consommateur d'en faire autant.
 */
import { ProvidallError } from "./errors.js";
import type { Request } from "./providers/adapter.js";
import type { TextStream } from "./stream.js";
import type { CompleteOptions, ModelSpec, Prompt, Response, TryResult } from "./types.js";
export type ClientConfig = Omit<CompleteOptions, "system" | "tools" | "toolChoice" | "json">;
export type Client = {
    complete: (input: Prompt, opts?: CompleteOptions) => Promise<Response>;
    tryComplete: (input: Prompt, opts?: CompleteOptions) => Promise<TryResult<Response>>;
    stream: (input: Prompt, opts?: CompleteOptions) => TextStream;
    /** Résout tout et vérifie tout, sans rien envoyer. Utile pour déboguer un corps. */
    prepare: (input: Prompt, opts?: CompleteOptions) => Request;
    readonly config: ClientConfig;
};
export declare function createClient(config?: ClientConfig): Client;
export declare function prepare(input: Prompt, opts?: CompleteOptions): Request;
/** Un aller-retour. Rejette avec une `ProvidallError` typée en cas d'échec. */
export declare function complete(input: Prompt, opts?: CompleteOptions): Promise<Response>;
/**
 * Ne rejette JAMAIS : `{ ok, value, error }`.
 *
 * Pour les traitements en lot — un fournisseur en panne ne doit pas
 * interrompre un passage sur 142 fiches ; l'appelant escalade l'élément
 * concerné et continue.
 */
export declare function tryComplete(input: Prompt, opts?: CompleteOptions): Promise<TryResult<Response>>;
/**
 * Flux de texte. `for await (const morceau of stream(...))` rend les deltas ;
 * `await stream(...).response` rend la réponse complète (usage, coût).
 */
export declare function stream(input: Prompt, opts?: CompleteOptions): TextStream;
/** `Response` d'échec, pour un appelant qui veut la même forme partout. */
export declare function errorResponse(error: ProvidallError, spec: ModelSpec): Response;
//# sourceMappingURL=complete.d.ts.map