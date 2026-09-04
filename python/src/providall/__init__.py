"""providall — un appel LLM, n'importe quel fournisseur.

    import providall

    providall.complete("Résume ce texte en une phrase.").text
    providall.complete_json(MonSchema, prompt).data

Le modèle vient de `LLM_MODEL` dans le `.env` (`sonnet`, `ds-flash`, ou
`provider:identifiant` pour un modèle qui vient de sortir). Avec une seule clé
`*_API_KEY` posée, même `LLM_MODEL` est facultatif.

Rien n'est lu à l'import : le premier appel charge `.env` puis `.env.local`
sans écraser l'environnement du process.
"""

from __future__ import annotations

from typing import Any

from .client import (
    Client,
    acomplete,
    astream,
    atry_complete,
    complete,
    default_client,
    try_complete,
)
from .client import (
    stream as _stream_fn,
)
from .config import Resolution, resolve_model
from .env import load_env
from .errors import (
    APIError,
    AuthError,
    BadRequestError,
    CapabilityError,
    ConfigError,
    EmptyResponseError,
    LLMTimeoutError,
    MissingKeyError,
    NetworkError,
    NotFoundError,
    OutputValidationError,
    ProvidallError,
    RateLimitError,
    RefusalError,
    ServerError,
    UnknownModelError,
)
from .hooks import on_response
from .pricing import compute_cost
from .providers.base import Request, ToolDef
from .registry import (
    list_models,
    list_providers,
    register_model,
    register_provider,
    resolve_spec,
    spec,
)
from .retry import RetryPolicy
from .schema import json_schema, parse_json_loose
from .stream import Done, ReasoningDelta, StreamEvent, TextDelta, ToolCallDelta
from .tools import Tool, ToolLoopResult, tool
from .types import (
    Caps,
    Effort,
    Message,
    ModelSpec,
    ProviderSpec,
    Response,
    StructuredResponse,
    ToolCall,
    TryStructured,
    Usage,
    Wire,
)

__version__ = "0.1.0"


def complete_json(schema: Any, prompt: Any, **kw: Any) -> StructuredResponse[Any]:
    """Réponse validée par un modèle Pydantic, avec boucle de réparation."""
    return default_client().complete_json(schema, prompt, **kw)


async def acomplete_json(schema: Any, prompt: Any, **kw: Any) -> StructuredResponse[Any]:
    return await default_client().acomplete_json(schema, prompt, **kw)


def try_complete_json(schema: Any, prompt: Any, **kw: Any) -> TryStructured[Any]:
    return default_client().try_complete_json(schema, prompt, **kw)


async def atry_complete_json(schema: Any, prompt: Any, **kw: Any) -> TryStructured[Any]:
    return await default_client().atry_complete_json(schema, prompt, **kw)


def tool_loop(prompt: Any, *, tools: Any, **kw: Any) -> ToolLoopResult:
    """Boucle d'agent : le modèle appelle des outils jusqu'à répondre."""
    return default_client().tool_loop(prompt, tools=tools, **kw)


async def atool_loop(prompt: Any, *, tools: Any, **kw: Any) -> ToolLoopResult:
    return await default_client().atool_loop(prompt, tools=tools, **kw)


__all__ = [
    "APIError",
    "AuthError",
    "BadRequestError",
    "CapabilityError",
    "Caps",
    "Client",
    "ConfigError",
    "Done",
    "Effort",
    "EmptyResponseError",
    "LLMTimeoutError",
    "Message",
    "MissingKeyError",
    "ModelSpec",
    "NetworkError",
    "NotFoundError",
    "OutputValidationError",
    "ProvidallError",
    "ProviderSpec",
    "RateLimitError",
    "ReasoningDelta",
    "RefusalError",
    "Request",
    "Resolution",
    "Response",
    "RetryPolicy",
    "ServerError",
    "StreamEvent",
    "StructuredResponse",
    "TextDelta",
    "Tool",
    "ToolCall",
    "ToolCallDelta",
    "ToolDef",
    "ToolLoopResult",
    "TryStructured",
    "UnknownModelError",
    "Usage",
    "Wire",
    "__version__",
    "acomplete",
    "acomplete_json",
    "astream",
    "atool_loop",
    "atry_complete",
    "atry_complete_json",
    "complete",
    "complete_json",
    "compute_cost",
    "default_client",
    "json_schema",
    "list_models",
    "list_providers",
    "load_env",
    "on_response",
    "parse_json_loose",
    "register_model",
    "register_provider",
    "resolve_model",
    "resolve_spec",
    "spec",
    "stream",
    "tool",
    "tool_loop",
    "try_complete",
    "try_complete_json",
]

# `from .stream import …` (plus haut) importe aussi le SOUS-MODULE
# `providall.stream`, que Python pose comme attribut du package : il masquerait
# la fonction du même nom selon l'ordre des imports. Cette affectation finale
# tranche, une fois pour toutes et visiblement.
stream = _stream_fn
