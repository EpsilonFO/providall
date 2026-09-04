/**
 * Faux `fetch` et fabriques de réponses, livrés dans le package.
 *
 * Livrés et pas cantonnés aux tests de la lib : un projet qui appelle
 * `complete()` doit pouvoir tester sa propre logique sans réseau ni clé, et
 * sans réécrire ce harnais. C'est la contrepartie de « une seule couche
 * d'appel » — si elle est partagée, son double de test doit l'être aussi.
 *
 *     import { fakeFetch, chatReply } from "providall/testing";
 *
 *     const faux = fakeFetch([chatReply("bonjour")]);
 *     const r = await complete("salut", { fetch: faux.fetch, env: FAUX_ENV });
 *     expect(faux.calls[0].body.model).toBe("deepseek-v4-flash");
 *
 * Seul le transport est remplacé : `build()` et `parse()` restent ceux des
 * vrais adaptateurs, donc un test peut affirmer sur le corps exact envoyé.
 */
import type { Env } from "./types.js";
export type RecordedCall = {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
};
export type FakeFetch = {
    fetch: (input: string, init: RequestInit) => Promise<Response>;
    calls: RecordedCall[];
    /** Corps des requêtes envoyées, dans l'ordre. */
    readonly bodies: Record<string, unknown>[];
};
/**
 * Rend les réponses en file. La DERNIÈRE se répète : un test de retry n'a pas
 * à fournir autant de réponses que de tentatives possibles.
 */
export declare function fakeFetch(responses: (Response | Error | (() => Response))[]): FakeFetch;
/** Réponse JSON classique. */
export declare function jsonRes(payload: unknown, status?: number, headers?: Record<string, string>): Response;
/** Réponse d'erreur, corps au format des APIs (`error.message`). */
export declare function errorRes(status: number, message: string, headers?: Record<string, string>): Response;
/**
 * Réponse en flux SSE. `chunks` permet de découper le corps arbitrairement,
 * pour vérifier qu'un événement coupé en deux par le réseau est bien réassemblé.
 */
export declare function sseRes(events: unknown[], opts?: {
    chunkSize?: number;
    crlf?: boolean;
}): Response;
export declare function chatReply(text?: string, opts?: {
    finishReason?: string | null;
    toolCalls?: unknown[];
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
    reasoningContent?: string;
}): Response;
export declare function anthropicReply(text?: string, opts?: {
    stopReason?: string;
    toolUses?: Record<string, unknown>[];
    thinking?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    stopDetails?: Record<string, unknown> | null;
}): Response;
export declare function toolCall(name: string, args: Record<string, unknown>, id?: string): Record<string, unknown>;
export declare function jsonReply(payload: unknown, opts?: Parameters<typeof chatReply>[1]): Response;
/** Environnement de test minimal : une clé, un modèle, rien d'autre. */
export declare function testEnv(extra?: Env): Env;
//# sourceMappingURL=testing.d.ts.map