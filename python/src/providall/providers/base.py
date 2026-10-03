"""Socle des adaptateurs : requête résolue, normalisation, mapping d'erreurs.

Le pipeline d'un appel est identique dans les deux langages :

    résoudre le modèle
  → vérifier clé et capacités          (ConfigError avant tout octet envoyé)
  → normaliser le prompt               (system fusionné, parties multimodales)
  → build(request)      ← PUR          (testable sans réseau)
  → send / stream       ← le seul I/O
  → parse(raw)          ← PUR
  → coût, hook, Response

`build` et `parse` purs, c'est ce qui permet de tester la totalité de la
traduction sans une seule requête — la généralisation du `kwargs_openai_compat`
de monumia, qui n'était isolé que pour ça.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..errors import (
    APIError,
    AuthError,
    BadRequestError,
    CapabilityError,
    LLMTimeoutError,
    NetworkError,
    NotFoundError,
    ProvidallError,
    RateLimitError,
    ServerError,
)
from ..types import Effort, Message, ModelSpec, Prompt, Response, ToolCall, ToolChoice


@dataclass(frozen=True)
class ToolDef:
    """Outil au format pivot. Le schéma est du JSON Schema brut."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class Request:
    """Tout ce dont un adaptateur a besoin. Aucune lecture d'environnement au-delà."""

    spec: ModelSpec
    messages: list[Message]
    system: str | None = None
    max_tokens: int = 16000
    effort: Effort | None = None
    temperature: float | None = None
    tools: list[ToolDef] | None = None
    tool_choice: ToolChoice | None = None
    json_schema: dict[str, Any] | None = None
    stream: bool = False
    timeout: float = 600.0
    api_key: str = ""
    base_url: str = ""
    label: str = ""
    extra: dict[str, Any] = field(default_factory=dict)
    """Paramètres propres à un fournisseur, ajoutés tels quels au corps de la
    requête après tout le reste (`extra_body=` à l'appel). Échappatoire pour ce
    que providall ne modélise pas : `prompt_cache_key` chez Mistral, un réglage
    de sécurité, un paramètre sorti ce matin. Il l'emporte en cas de conflit."""


class Adapter(Protocol):
    protocol: str

    def build(self, req: Request) -> dict[str, Any]: ...
    def parse(self, raw: Any, req: Request) -> Response: ...
    def send(self, req: Request, body: dict[str, Any]) -> Any: ...
    async def asend(self, req: Request, body: dict[str, Any]) -> Any: ...


# --------------------------------------------------------------------------
# Normalisation du prompt
# --------------------------------------------------------------------------


def normalize_prompt(prompt: Prompt, system: str | None = None) -> tuple[list[Message], str | None]:
    """`str | Sequence[Message | dict]` → `(messages, system)`.

    Les messages `role: "system"` du prompt sont extraits et fusionnés avec
    l'argument `system=`, dans cet ordre : l'argument d'abord, puis ce que la
    conversation portait. Un seul endroit décide, donc les deux adaptateurs
    n'ont plus à se poser la question.
    """
    if isinstance(prompt, str):
        messages: list[Message] = [Message(role="user", content=prompt)]
    else:
        messages = [m if isinstance(m, Message) else _from_dict(m) for m in prompt]

    systemes = [system.strip()] if system and system.strip() else []
    restants: list[Message] = []
    for m in messages:
        if m.role == "system":
            texte = m.text.strip()
            if texte:
                systemes.append(texte)
        else:
            restants.append(m)
    return restants, "\n\n".join(systemes) or None


def _from_dict(data: dict[str, Any]) -> Message:
    """Accepte un message au format chat-completions brut (dict)."""
    appels = data.get("tool_calls") or []
    tool_calls = [
        tc
        if isinstance(tc, ToolCall)
        else ToolCall(
            id=str(tc.get("id", "")),
            name=str((tc.get("function") or {}).get("name", tc.get("name", ""))),
            arguments=str((tc.get("function") or {}).get("arguments", tc.get("arguments", "{}"))),
        )
        for tc in appels
    ]
    return Message(
        role=data.get("role", "user"),
        content=data.get("content"),
        tool_calls=tool_calls or None,
        tool_call_id=data.get("tool_call_id"),
        name=data.get("name"),
        raw=data.get("raw"),
    )


def content_parts(message: Message) -> list[dict[str, Any]]:
    """Contenu d'un message en liste de parties, quelle que soit sa forme d'entrée."""
    if isinstance(message.content, str):
        return [{"type": "text", "text": message.content}] if message.content else []
    if isinstance(message.content, list):
        return message.content
    return []


def check_capabilities(req: Request) -> None:
    """Refuse AVANT d'envoyer ce que le modèle ne sait pas faire.

    Un `ConfigError` immédiat vaut mieux qu'un 400 obscur trois secondes plus
    tard, et mieux encore qu'un `tools=[…]` silencieusement ignoré.
    """
    spec = req.spec
    if req.tools and not spec.caps.tools:
        raise CapabilityError(
            "appels d'outils",
            provider=spec.provider,
            model=spec.alias,
            hint="choisir un autre modèle, ou retirer `tools=`",
        )
    if req.stream and not spec.caps.stream:
        raise CapabilityError("streaming", provider=spec.provider, model=spec.alias)
    for m in req.messages:
        for part in content_parts(m):
            if part.get("type") in ("image_url", "image_base64") and not spec.caps.vision:
                raise CapabilityError(
                    "images en entrée",
                    provider=spec.provider,
                    model=spec.alias,
                    hint="`caps.vision` est faux pour ce provider dans registry/providers.json",
                )


def resolve_tool_choice(req: Request) -> tuple[str, str | None]:
    """`tool_choice` effectif, et l'instruction de repli s'il a fallu dégrader.

    Claude Fable 5.1 répond 400 à `tool_choice` `any`/`tool` : on retombe sur
    `auto` en demandant l'outil dans le prompt, plutôt que de faire échouer
    l'appel. Le deuxième membre est cette instruction, à coller au système.
    """
    choix = req.tool_choice or ("auto" if req.tools else "none")
    if choix != "required":
        return choix, None
    if req.spec.caps.forced_tool_choice:
        return "required", None
    noms = ", ".join(t.name for t in (req.tools or []))
    return "auto", (
        f"Tu dois appeler l'un de ces outils pour répondre : {noms}. "
        "N'écris pas de réponse en texte à la place."
    )


# --------------------------------------------------------------------------
# Mapping des exceptions des SDK
# --------------------------------------------------------------------------


def from_status(
    status: int,
    message: str,
    *,
    provider: str,
    model: str,
    body: Any = None,
    request_id: str | None = None,
    retry_after: float | None = None,
) -> APIError:
    """Statut HTTP → erreur typée. Table identique côté TypeScript (`fromHttp`)."""
    commun: dict[str, Any] = {
        "provider": provider,
        "model": model,
        "status": status,
        "body": body,
        "request_id": request_id,
    }
    if status in (401, 403):
        return AuthError(message, **commun)
    if status == 404:
        return NotFoundError(
            f"{message} — identifiant de modèle inconnu chez ce fournisseur ?", **commun
        )
    if status == 429:
        return RateLimitError(message, retry_after=retry_after, **commun)
    if status in (400, 422):
        return BadRequestError(message, **commun)
    if status >= 500:
        # 529 = `overloaded_error` d'Anthropic, transitoire comme un 503.
        return ServerError(message, **commun)
    if status in (408, 409):
        return APIError(message, retryable=True, **commun)
    return APIError(message, **commun)


def _retry_after(exc: Any) -> float | None:
    headers = getattr(getattr(exc, "response", None), "headers", None)
    if not headers:
        return None
    valeur = headers.get("retry-after") or headers.get("Retry-After")
    try:
        return float(valeur) if valeur else None
    except (TypeError, ValueError):
        return None


def map_exception(exc: BaseException, *, provider: str, model: str) -> ProvidallError:
    """Exception d'un SDK (`anthropic.*`, `openai.*`) → erreur providall.

    Le timeout est testé AVANT la connexion : `APITimeoutError` hérite
    d'`APIConnectionError` dans les deux SDK, et l'ordre inverse ferait
    disparaître tous les timeouts derrière « erreur réseau ».
    """
    if isinstance(exc, ProvidallError):
        return exc

    nom = type(exc).__name__
    message = _message_utile(exc)
    request_id = getattr(exc, "request_id", None)

    if "Timeout" in nom:
        return LLMTimeoutError(
            f"délai dépassé : {message}", provider=provider, model=model, request_id=request_id
        )

    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return from_status(
            status,
            message,
            provider=provider,
            model=model,
            body=getattr(exc, "body", None),
            request_id=request_id,
            retry_after=_retry_after(exc),
        )

    if "Connection" in nom or "Network" in nom or type(exc).__module__.startswith("httpx"):
        return NetworkError(
            f"erreur réseau : {message}", provider=provider, model=model, request_id=request_id
        )

    return ProvidallError(f"{nom}: {message}", provider=provider, model=model)


def _message_utile(exc: BaseException) -> str:
    """Message le plus parlant qu'on puisse tirer d'une exception de SDK.

    Les quatre APIs enveloppent différemment (`error.message`, `message`,
    `detail`) : on tente, sinon on garde le `str()` tronqué.
    """
    corps = getattr(exc, "body", None)
    if isinstance(corps, dict):
        erreur = corps.get("error")
        if isinstance(erreur, dict) and isinstance(erreur.get("message"), str):
            return erreur["message"][:400]
        for cle in ("message", "detail"):
            if isinstance(corps.get(cle), str):
                return corps[cle][:400]
    return str(exc)[:400] or type(exc).__name__


# --------------------------------------------------------------------------
# Clients SDK, mis en cache
# --------------------------------------------------------------------------

_clients: dict[tuple[str, str, str, float], Any] = {}


def sdk_client(kind: str, *, api_key: str, base_url: str, timeout: float) -> Any:
    """Client SDK partagé par (type, clé, URL, timeout).

    Mis en cache pour réutiliser le pool de connexions : recréer un client à
    chaque appel rouvre une connexion TLS, ce qui se voit sur un lot de 142
    appels. `max_retries=0` partout — la seule couche de retry est `retry.py`.
    """
    cle = (kind, api_key, base_url, timeout)
    client = _clients.get(cle)
    if client is not None:
        return client

    if kind == "anthropic":
        from anthropic import Anthropic

        client = Anthropic(
            api_key=api_key or None, base_url=base_url or None, timeout=timeout, max_retries=0
        )
    elif kind == "anthropic_async":
        from anthropic import AsyncAnthropic

        client = AsyncAnthropic(
            api_key=api_key or None, base_url=base_url or None, timeout=timeout, max_retries=0
        )
    elif kind == "openai":
        from openai import OpenAI

        # Clé factice si le serveur n'en demande pas : le SDK OpenAI refuse de
        # se construire sans, et un serveur local ignore l'en-tête.
        client = OpenAI(
            api_key=api_key or "no-key", base_url=base_url or None, timeout=timeout, max_retries=0
        )
    elif kind == "openai_async":
        from openai import AsyncOpenAI

        client = AsyncOpenAI(
            api_key=api_key or "no-key", base_url=base_url or None, timeout=timeout, max_retries=0
        )
    else:  # pragma: no cover — garde-fou de programmation
        raise ValueError(f"client SDK inconnu : {kind}")

    _clients[cle] = client
    return client


def clear_client_cache() -> None:
    """Vide le cache de clients. Utile aux tests, jamais en production."""
    _clients.clear()


def getval(obj: Any, name: str, default: Any = None) -> Any:
    """Lit un champ d'un objet de SDK OU d'un dict équivalent.

    Les tests construisent des réponses hors ligne : les écrire en dicts plutôt
    qu'en objets Pydantic du SDK évite de dépendre de la forme interne d'un SDK
    qui change de version en version. `parse()` accepte donc les deux.
    """
    if isinstance(obj, dict):
        return obj.get(name, default)
    valeur = getattr(obj, name, default)
    return default if valeur is None else valeur


def merge_system(base: str | None, *ajouts: str | None) -> str | None:
    morceaux = [x.strip() for x in (base, *ajouts) if x and x.strip()]
    return "\n\n".join(morceaux) or None


def as_tool_defs(tools: Sequence[Any] | None) -> list[ToolDef] | None:
    """Accepte des `ToolDef`, des `Tool` (décorés) ou des dicts bruts."""
    if not tools:
        return None
    sortie: list[ToolDef] = []
    for t in tools:
        if isinstance(t, ToolDef):
            sortie.append(t)
        elif hasattr(t, "definition"):
            sortie.append(t.definition)
        elif isinstance(t, dict):
            fn = t.get("function", t)
            sortie.append(
                ToolDef(
                    name=fn["name"],
                    description=fn.get("description", ""),
                    parameters=fn.get("parameters") or fn.get("input_schema") or {},
                )
            )
        else:  # pragma: no cover
            raise TypeError(f"outil non reconnu : {t!r}")
    return sortie


__all__ = [
    "Adapter",
    "Request",
    "ToolDef",
    "as_tool_defs",
    "check_capabilities",
    "clear_client_cache",
    "content_parts",
    "from_status",
    "getval",
    "map_exception",
    "merge_system",
    "normalize_prompt",
    "resolve_tool_choice",
    "sdk_client",
]
