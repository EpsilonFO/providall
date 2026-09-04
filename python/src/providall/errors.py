"""Une hiérarchie d'erreurs, la même dans les deux langages.

Deux règles ont dicté la forme :

1. `retryable` est porté par l'erreur, pas décidé par l'appelant. C'est le
   fournisseur qui sait si un 429 se rejouera mieux qu'un 400 ; obliger chaque
   site d'appel à retenir la liste des statuts transitoires, c'est garantir
   qu'un d'eux se trompera.
2. Un message d'erreur de configuration nomme la variable à poser ET l'URL où
   trouver la valeur. « clé manquante » sans le nom de la variable coûte un
   aller-retour dans le README à chaque fois.
"""

from __future__ import annotations

from typing import Any


class ProvidallError(Exception):
    """Racine : tout ce que la lib lève en hérite."""

    def __init__(
        self,
        message: str,
        *,
        provider: str | None = None,
        model: str | None = None,
        retryable: bool = False,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.provider = provider
        self.model = model
        self.retryable = retryable
        self.request_id = request_id
        self.attempts = 1
        """Renseigné par `retry.py` : combien de fois on a essayé avant d'abandonner."""

    def __str__(self) -> str:
        contexte = " · ".join(x for x in (self.provider, self.model) if x)
        return f"{self.message} [{contexte}]" if contexte else self.message


# --------------------------------------------------------------------------
# Configuration — rien n'a été envoyé, et rejouer n'y changerait rien
# --------------------------------------------------------------------------


class ConfigError(ProvidallError):
    """Environnement ou appel mal formé. Jamais retryable."""


class MissingKeyError(ConfigError):
    def __init__(self, env_key: str, *, provider: str, key_url: str | None = None) -> None:
        message = f"{env_key} absente de l'environnement"
        if key_url:
            message += f" — clé à récupérer sur {key_url}"
        super().__init__(message, provider=provider)
        self.env_key = env_key
        self.key_url = key_url


class UnknownModelError(ConfigError):
    def __init__(self, name: str, *, aliases: list[str], providers: list[str]) -> None:
        # Guillemets doubles et non le `repr` de Python : le package TypeScript
        # passe par `JSON.stringify`, et les deux CLI doivent rendre exactement
        # la même table (c'est le test le plus simple d'un registre unique).
        super().__init__(
            f'modèle inconnu : "{name}"\n'
            f"  alias du registre : {', '.join(sorted(aliases))}\n"
            f"  ou `provider:model_id` parmi : {', '.join(sorted(providers))}"
        )
        self.name = name


class CapabilityError(ConfigError):
    """Le modèle demandé ne sait pas faire ce qu'on lui demande (outils, vision…)."""

    def __init__(self, capability: str, *, provider: str, model: str, hint: str = "") -> None:
        message = f"{model} ({provider}) ne gère pas : {capability}"
        if hint:
            message += f" — {hint}"
        super().__init__(message, provider=provider, model=model)
        self.capability = capability


# --------------------------------------------------------------------------
# Transport
# --------------------------------------------------------------------------


class APIError(ProvidallError):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        body: Any = None,
        provider: str | None = None,
        model: str | None = None,
        retryable: bool = False,
        request_id: str | None = None,
    ) -> None:
        super().__init__(
            message, provider=provider, model=model, retryable=retryable, request_id=request_id
        )
        self.status = status
        self.body = body


class AuthError(APIError):
    """401 / 403 : clé refusée."""


class NotFoundError(APIError):
    """404 — presque toujours un identifiant de modèle erroné, pas une URL."""


class BadRequestError(APIError):
    """400 / 422 : la requête est invalide pour ce modèle."""


class RateLimitError(APIError):
    def __init__(self, message: str, *, retry_after: float | None = None, **kw: Any) -> None:
        kw.setdefault("retryable", True)
        super().__init__(message, **kw)
        self.retry_after = retry_after


class ServerError(APIError):
    """≥ 500, dont le 529 `overloaded_error` d'Anthropic."""

    def __init__(self, message: str, **kw: Any) -> None:
        kw.setdefault("retryable", True)
        super().__init__(message, **kw)


class NetworkError(ProvidallError):
    def __init__(self, message: str, **kw: Any) -> None:
        kw.setdefault("retryable", True)
        super().__init__(message, **kw)


class LLMTimeoutError(ProvidallError):
    """Nommé ainsi et pas `TimeoutError` : ne pas masquer le builtin.

    Il en hérite quand même, pour qu'un `except TimeoutError` existant du code
    appelant continue de l'attraper.
    """

    def __init__(self, message: str, **kw: Any) -> None:
        kw.setdefault("retryable", True)
        super().__init__(message, **kw)


TimeoutError_ = LLMTimeoutError  # alias interne, évite l'ombre du builtin


# --------------------------------------------------------------------------
# Réponses inutilisables
# --------------------------------------------------------------------------


class EmptyResponseError(ProvidallError):
    """Le fournisseur a répondu, sans contenu.

    Retryable UNIQUEMENT si la cause est inexpliquée : un `finish_reason` de
    `length` ou `content_filter` se reproduirait à l'identique. Leçon de
    monumia — un passage de benchmark entier a été perdu à rejouer un vide dû
    au budget de sortie épuisé.
    """

    def __init__(
        self,
        message: str,
        *,
        finish_reason: str | None = None,
        retryable: bool = True,
        **kw: Any,
    ) -> None:
        super().__init__(message, retryable=retryable, **kw)
        self.finish_reason = finish_reason


class RefusalError(ProvidallError):
    """`stop_reason: refusal` — un classificateur a décliné. Résultat, pas panne."""

    def __init__(
        self,
        message: str,
        *,
        category: str | None = None,
        explanation: str | None = None,
        **kw: Any,
    ) -> None:
        super().__init__(message, **kw)
        self.category = category
        self.explanation = explanation


class OutputValidationError(ProvidallError):
    """La sortie n'a pas validé le schéma après toutes les réparations."""

    def __init__(
        self,
        message: str,
        *,
        attempts: int,
        issues: str,
        last_text: str,
        **kw: Any,
    ) -> None:
        super().__init__(message, **kw)
        self.attempts = attempts
        self.issues = issues
        self.last_text = last_text


__all__ = [
    "APIError",
    "AuthError",
    "BadRequestError",
    "CapabilityError",
    "ConfigError",
    "EmptyResponseError",
    "LLMTimeoutError",
    "MissingKeyError",
    "NetworkError",
    "NotFoundError",
    "OutputValidationError",
    "ProvidallError",
    "RateLimitError",
    "RefusalError",
    "ServerError",
    "UnknownModelError",
]
