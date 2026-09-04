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

export class ProvidallError extends Error {
  provider?: string;
  model?: string;
  retryable: boolean;
  requestId?: string;
  /** Renseigné par la boucle de retry : combien de fois on a essayé. */
  attempts = 1;

  constructor(message: string, ctx: ErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.provider = ctx.provider;
    this.model = ctx.model;
    this.retryable = ctx.retryable ?? false;
    this.requestId = ctx.requestId;
  }
}

/* ------------------------------------------------------------------------ */
/* Configuration — rien n'a été envoyé, et rejouer n'y changerait rien        */
/* ------------------------------------------------------------------------ */

export class ConfigError extends ProvidallError {}

export class MissingKeyError extends ConfigError {
  envKey: string;
  keyUrl?: string;

  constructor(envKey: string, ctx: ErrorContext & { keyUrl?: string } = {}) {
    super(
      `${envKey} absente de l'environnement` +
        (ctx.keyUrl ? ` — clé à récupérer sur ${ctx.keyUrl}` : ""),
      ctx,
    );
    this.envKey = envKey;
    this.keyUrl = ctx.keyUrl;
  }
}

export class UnknownModelError extends ConfigError {
  constructor(name: string, aliases: string[], providers: string[]) {
    super(
      `modèle inconnu : ${JSON.stringify(name)}\n` +
        `  alias du registre : ${[...aliases].sort().join(", ")}\n` +
        `  ou \`provider:model_id\` parmi : ${[...providers].sort().join(", ")}`,
    );
  }
}

export class CapabilityError extends ConfigError {
  capability: string;

  constructor(capability: string, ctx: ErrorContext & { hint?: string }) {
    super(
      `${ctx.model} (${ctx.provider}) ne gère pas : ${capability}` +
        (ctx.hint ? ` — ${ctx.hint}` : ""),
      ctx,
    );
    this.capability = capability;
  }
}

/* ------------------------------------------------------------------------ */
/* Transport                                                                  */
/* ------------------------------------------------------------------------ */

export class APIError extends ProvidallError {
  status?: number;
  body?: unknown;

  constructor(message: string, ctx: ErrorContext & { status?: number; body?: unknown } = {}) {
    super(message, ctx);
    this.status = ctx.status;
    this.body = ctx.body;
  }
}

/** 401 / 403 : clé refusée. */
export class AuthError extends APIError {}
/** 404 — presque toujours un identifiant de modèle erroné, pas une URL. */
export class NotFoundError extends APIError {}
/** 400 / 422 : la requête est invalide pour ce modèle. */
export class BadRequestError extends APIError {}

export class RateLimitError extends APIError {
  retryAfterMs: number | null;

  constructor(
    message: string,
    ctx: ErrorContext & { status?: number; body?: unknown; retryAfterMs?: number | null } = {},
  ) {
    super(message, { retryable: true, ...ctx });
    this.retryAfterMs = ctx.retryAfterMs ?? null;
  }
}

/** ≥ 500, dont le 529 `overloaded_error` d'Anthropic. */
export class ServerError extends APIError {
  constructor(message: string, ctx: ErrorContext & { status?: number; body?: unknown } = {}) {
    super(message, { retryable: true, ...ctx });
  }
}

export class NetworkError extends ProvidallError {
  constructor(message: string, ctx: ErrorContext = {}) {
    super(message, { retryable: true, ...ctx });
  }
}

export class TimeoutError extends ProvidallError {
  constructor(message: string, ctx: ErrorContext = {}) {
    super(message, { retryable: true, ...ctx });
  }
}

/* ------------------------------------------------------------------------ */
/* Réponses inutilisables                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Le fournisseur a répondu, sans contenu.
 *
 * Retryable UNIQUEMENT si la cause est inexpliquée : un `finish_reason` de
 * `length` ou `content_filter` se reproduirait à l'identique.
 */
export class EmptyResponseError extends ProvidallError {
  finishReason: string | null;

  constructor(message: string, ctx: ErrorContext & { finishReason?: string | null } = {}) {
    super(message, { retryable: true, ...ctx });
    this.finishReason = ctx.finishReason ?? null;
  }
}

/** `stop_reason: refusal` — un classificateur a décliné. Résultat, pas panne. */
export class RefusalError extends ProvidallError {
  category: string | null;
  explanation: string | null;

  constructor(
    message: string,
    ctx: ErrorContext & { category?: string | null; explanation?: string | null } = {},
  ) {
    super(message, ctx);
    this.category = ctx.category ?? null;
    this.explanation = ctx.explanation ?? null;
  }
}

/** La sortie n'a pas validé le schéma après toutes les réparations. */
export class OutputValidationError extends ProvidallError {
  issues: string;
  lastText: string;

  constructor(
    message: string,
    ctx: ErrorContext & { attempts: number; issues: string; lastText: string },
  ) {
    super(message, ctx);
    this.attempts = ctx.attempts;
    this.issues = ctx.issues;
    this.lastText = ctx.lastText;
  }
}

/**
 * Statut HTTP → erreur typée. Table identique côté Python (`from_status`).
 */
export function fromHttp(
  status: number,
  message: string,
  ctx: ErrorContext & { body?: unknown; retryAfterMs?: number | null } = {},
): APIError {
  const base = { ...ctx, status };
  if (status === 401 || status === 403) return new AuthError(message, base);
  if (status === 404) {
    return new NotFoundError(
      `${message} — identifiant de modèle inconnu chez ce fournisseur ?`,
      base,
    );
  }
  if (status === 429) return new RateLimitError(message, base);
  if (status === 400 || status === 422) return new BadRequestError(message, base);
  // 529 = `overloaded_error` d'Anthropic, transitoire comme un 503.
  if (status >= 500) return new ServerError(message, base);
  if (status === 408 || status === 409) return new APIError(message, { ...base, retryable: true });
  return new APIError(message, base);
}

/** Erreur quelconque → erreur providall, sans perdre l'information utile. */
export function toProvidallError(err: unknown, ctx: ErrorContext = {}): ProvidallError {
  if (err instanceof ProvidallError) return err;
  if (err instanceof Error) {
    // `AbortSignal.timeout()` rejette avec un DOMException nommé TimeoutError ;
    // un abandon volontaire donne AbortError, qui ne doit PAS être retenté.
    if (err.name === "TimeoutError") {
      return new TimeoutError(`délai dépassé : ${err.message}`, ctx);
    }
    if (err.name === "AbortError") {
      return new ProvidallError("appel annulé", { ...ctx, retryable: false });
    }
    return new NetworkError(`erreur réseau : ${err.message}`, ctx);
  }
  return new ProvidallError(String(err), ctx);
}
