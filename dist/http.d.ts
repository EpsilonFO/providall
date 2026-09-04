/**
 * Plomberie HTTP : timeout, retries, lecture SSE. Écrite une fois.
 *
 * `fetch` brut, zéro dépendance. C'est le choix d'agenda, et il se justifie
 * autrement qu'esthétiquement : deux protocoles, quatre endpoints, aucun SDK
 * n'apporte assez pour valoir sa surface de mise à jour — et un package sans
 * dépendance runtime s'installe depuis git dans n'importe quel projet.
 *
 * Une seule couche de retry ici, celle de `retry()`. Le corollaire côté
 * Python est `max_retries=0` sur les SDK : ce qu'on ne veut nulle part, c'est
 * trois timeouts de dix minutes empilés en silence.
 */
import { ProvidallError } from "./errors.js";
import type { ErrorContext } from "./errors.js";
import type { FetchLike, Logger } from "./types.js";
/** Backoff linéaire : au-delà de deux tentatives on abandonne de toute façon. */
export declare const BACKOFF_STEP_MS = 2000;
export declare const MAX_BACKOFF_MS = 30000;
export type RetryPolicy = {
    retries: number;
    backoffStepMs?: number;
    maxBackoffMs?: number;
};
export declare function joinUrl(base: string, path: string): string;
export declare function backoffMs(policy: RetryPolicy, attempt: number, error?: ProvidallError): number;
/**
 * Exécute `attempt(n)` en le retentant sur erreur transitoire.
 * Renvoie la valeur ET le nombre de tentatives, pour `Response.attempts`.
 */
export declare function retry<T>(policy: RetryPolicy, attempt: (attemptNo: number) => Promise<T>, opts?: {
    logger?: Logger;
    signal?: AbortSignal;
    label?: string;
}): Promise<{
    value: T;
    attempts: number;
}>;
/**
 * Extrait le message utile d'un corps d'erreur. Les fournisseurs enveloppent
 * différemment (`error.message`, `message`, `detail`) — on tente, sinon on
 * renvoie le brut tronqué.
 */
export declare function extractApiMessage(text: string): string;
export type PostOptions = {
    fetch?: FetchLike;
    timeoutMs: number;
    signal?: AbortSignal;
    context: ErrorContext;
};
/**
 * POST JSON. Une réponse non-2xx devient une erreur typée ; réseau et timeout
 * deviennent `NetworkError` / `TimeoutError`, tous deux retryables.
 */
export declare function postJson(url: string, headers: Record<string, string>, body: unknown, opts: PostOptions): Promise<globalThis.Response>;
/**
 * Lit un flux SSE et rend chaque événement JSON.
 *
 * Trois pièges que ce parseur traite, et que les tests couvrent : un chunk
 * réseau peut couper un événement en deux, les séparateurs peuvent être CRLF,
 * et `[DONE]` n'est pas du JSON.
 */
export declare function readSse(res: globalThis.Response, context: ErrorContext): AsyncGenerator<Record<string, unknown>>;
//# sourceMappingURL=http.d.ts.map