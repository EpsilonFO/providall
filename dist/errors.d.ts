/**
 * Une hiérarchie d'erreurs, la même dans les deux langages.
 *
 * Deux règles ont dicté la forme :
 *
 * 1. `retryable` est porté par l'erreur, pas décidé par l'appelant. C'est le
 *    fournisseur qui sait si un 429 se rejouera mieux qu'un 400 ; obliger
 *    chaque site d'appel à retenir la liste des statuts transitoires, c'est
 *    garantir qu'un d'eux se trompera.
 * 2. Un message d'erreur de configuration nomme la variable à poser ET l'URL
 *    où trouver la valeur.
 */
export type ErrorContext = {
    provider?: string;
    model?: string;
    retryable?: boolean;
    requestId?: string;
};
export declare class ProvidallError extends Error {
    provider?: string;
    model?: string;
    retryable: boolean;
    requestId?: string;
    /** Renseigné par la boucle de retry : combien de fois on a essayé. */
    attempts: number;
    constructor(message: string, ctx?: ErrorContext);
}
export declare class ConfigError extends ProvidallError {
}
export declare class MissingKeyError extends ConfigError {
    envKey: string;
    keyUrl?: string;
    constructor(envKey: string, ctx?: ErrorContext & {
        keyUrl?: string;
    });
}
export declare class UnknownModelError extends ConfigError {
    constructor(name: string, aliases: string[], providers: string[]);
}
export declare class CapabilityError extends ConfigError {
    capability: string;
    constructor(capability: string, ctx: ErrorContext & {
        hint?: string;
    });
}
export declare class APIError extends ProvidallError {
    status?: number;
    body?: unknown;
    constructor(message: string, ctx?: ErrorContext & {
        status?: number;
        body?: unknown;
    });
}
/** 401 / 403 : clé refusée. */
export declare class AuthError extends APIError {
}
/** 404 — presque toujours un identifiant de modèle erroné, pas une URL. */
export declare class NotFoundError extends APIError {
}
/** 400 / 422 : la requête est invalide pour ce modèle. */
export declare class BadRequestError extends APIError {
}
export declare class RateLimitError extends APIError {
    retryAfterMs: number | null;
    constructor(message: string, ctx?: ErrorContext & {
        status?: number;
        body?: unknown;
        retryAfterMs?: number | null;
    });
}
/** ≥ 500, dont le 529 `overloaded_error` d'Anthropic. */
export declare class ServerError extends APIError {
    constructor(message: string, ctx?: ErrorContext & {
        status?: number;
        body?: unknown;
    });
}
export declare class NetworkError extends ProvidallError {
    constructor(message: string, ctx?: ErrorContext);
}
export declare class TimeoutError extends ProvidallError {
    constructor(message: string, ctx?: ErrorContext);
}
/**
 * Le fournisseur a répondu, sans contenu.
 *
 * Retryable UNIQUEMENT si la cause est inexpliquée : un `finish_reason` de
 * `length` ou `content_filter` se reproduirait à l'identique.
 */
export declare class EmptyResponseError extends ProvidallError {
    finishReason: string | null;
    constructor(message: string, ctx?: ErrorContext & {
        finishReason?: string | null;
    });
}
/** `stop_reason: refusal` — un classificateur a décliné. Résultat, pas panne. */
export declare class RefusalError extends ProvidallError {
    category: string | null;
    explanation: string | null;
    constructor(message: string, ctx?: ErrorContext & {
        category?: string | null;
        explanation?: string | null;
    });
}
/** La sortie n'a pas validé le schéma après toutes les réparations. */
export declare class OutputValidationError extends ProvidallError {
    issues: string;
    lastText: string;
    constructor(message: string, ctx: ErrorContext & {
        attempts: number;
        issues: string;
        lastText: string;
    });
}
/**
 * Statut HTTP → erreur typée. Table identique côté Python (`from_status`).
 */
export declare function fromHttp(status: number, message: string, ctx?: ErrorContext & {
    body?: unknown;
    retryAfterMs?: number | null;
}): APIError;
/** Erreur quelconque → erreur providall, sans perdre l'information utile. */
export declare function toProvidallError(err: unknown, ctx?: ErrorContext): ProvidallError;
//# sourceMappingURL=errors.d.ts.map