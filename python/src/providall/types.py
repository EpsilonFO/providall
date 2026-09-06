"""Types du format pivot et des réponses.

Le pivot interne est celui de chat-completions (messages + `tool_calls`) :
c'est le dialecte que huit fournisseurs sur dix parlent nativement, donc c'est
là que la traduction coûte le moins cher. L'adaptateur Anthropic est le seul à
faire un vrai travail de conversion.

Convention de nommage (identique en TypeScript) : tout ce qui voyage sur le fil
— `tool_calls`, `tool_call_id`, `image_url` — garde son nom snake_case dans les
deux langages. Le reste suit la convention du langage.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from .errors import ProvidallError

Effort = Literal["none", "low", "medium", "high", "xhigh", "max"]
EFFORTS: tuple[Effort, ...] = ("none", "low", "medium", "high", "xhigh", "max")

Protocol = Literal["anthropic", "openai_compat"]
Structured = Literal["json_schema", "json_object", "prompt"]
Thinking = Literal["adaptive", "budget", "none"]
Role = Literal["system", "user", "assistant", "tool"]
FinishReason = Literal[
    "stop", "length", "tool_calls", "content_filter", "refusal", "pause", "other"
]
ToolChoice = Literal["auto", "none", "required"]


@dataclass(frozen=True)
class Caps:
    """Ce qu'un modèle sait faire. Vérifié AVANT l'envoi, pas découvert en 400."""

    tools: bool
    structured: Structured
    effort: bool
    thinking: Thinking
    vision: bool
    temperature: bool
    forced_tool_choice: bool
    stream: bool


@dataclass(frozen=True)
class Wire:
    """Détails de protocole qui varient d'un fournisseur à l'autre.

    `max_tokens_param` : les modèles à raisonnement d'OpenAI ont renommé
    `max_tokens` en `max_completion_tokens` et rejettent l'ancien par un 400.
    `effort_values` : l'échelle acceptée par le fournisseur ; une valeur hors
    échelle est ramenée à la plus proche plutôt que de faire échouer l'appel.
    """

    max_tokens_param: str
    effort_param: str | None
    effort_values: tuple[str, ...]
    # Fournisseur dont `effort: "none"` se dit par un interrupteur dédié
    # (`thinking.type = disabled` chez DeepSeek), hors échelle d'effort.
    thinking_toggle: str | None = None


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    protocol: Protocol
    base_url: str
    api_key_env: str
    aliases: tuple[str, ...]
    default_model: str
    key_url: str
    requires_key: bool
    caps: Caps
    wire: Wire
    max_tokens: int
    effort: Effort | None
    note: str


@dataclass(frozen=True)
class ModelSpec:
    """Un modèle résolu : tout ce qu'il faut pour construire une requête.

    Fusion de `ModelSpec` (monumia) et `ProviderSpec` (agenda) : le fournisseur
    n'est plus qu'un jeu de valeurs par défaut, aplati ici une fois pour toutes.
    """

    alias: str
    provider: str
    protocol: Protocol
    model_id: str
    api_key_env: str
    base_url: str
    requires_key: bool
    key_url: str
    caps: Caps
    wire: Wire
    max_tokens: int
    effort: Effort | None
    price_in: float | None = None
    price_out: float | None = None
    price_cache_read: float | None = None
    id_verified: bool = True
    note: str = ""

    @property
    def price_known(self) -> bool:
        return self.price_in is not None and self.price_out is not None

    @property
    def key_present(self) -> bool:
        from .env import get_env

        return not self.requires_key or bool(get_env().get(self.api_key_env, "").strip())


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # JSON brut : les modèles échappent différemment, on ne parse qu'au besoin

    def parsed(self) -> dict[str, Any]:
        import json

        try:
            value = json.loads(self.arguments or "{}")
        except ValueError:
            return {}
        return value if isinstance(value, dict) else {}


@dataclass
class Message:
    """Message au format pivot.

    `content` accepte une liste de parties multimodales :
      {"type": "text", "text": …}
      {"type": "image_url", "url": …}
      {"type": "image_base64", "media_type": "image/png", "data": …}
    """

    role: Role
    content: str | list[dict[str, Any]] | None = None
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None
    name: str | None = None
    raw: tuple[str, Any] | None = None
    """`(provider, blocs natifs)` à rejouer tel quel si on renvoie ce message.

    Indispensable chez Anthropic : un `tool_use` détaché du bloc `thinking`
    signé qui l'a produit est refusé. Étiqueté par provider — si la
    conversation change de fournisseur en cours de route, le bloc est ignoré et
    le message reconstruit en texte + `tool_calls`.
    """

    @property
    def text(self) -> str:
        if isinstance(self.content, str):
            return self.content
        if isinstance(self.content, list):
            return "".join(p.get("text", "") for p in self.content if p.get("type") == "text")
        return ""


Prompt = str | Sequence[Message | dict[str, Any]]


@dataclass
class Usage:
    input_tokens: int = 0
    """Jetons d'entrée HORS cache — normalisé ainsi dans les deux adaptateurs."""
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_read_tokens
            + self.cache_write_tokens
        )

    def __add__(self, other: Usage) -> Usage:
        return Usage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            cache_read_tokens=self.cache_read_tokens + other.cache_read_tokens,
            cache_write_tokens=self.cache_write_tokens + other.cache_write_tokens,
            reasoning_tokens=self.reasoning_tokens + other.reasoning_tokens,
        )


@dataclass
class Response:
    """Retour uniforme, quel que soit le fournisseur."""

    text: str = ""
    model: str = ""
    """Alias demandé (`sonnet`), ou `provider:model_id` hors registre."""
    model_id: str = ""
    """Identifiant réellement envoyé au fournisseur."""
    provider: str = ""
    finish_reason: FinishReason | None = None
    usage: Usage = field(default_factory=Usage)
    latency_s: float = 0.0
    cost_usd: float | None = None
    attempts: int = 1
    tool_calls: list[ToolCall] = field(default_factory=list)
    message: Message | None = None
    reasoning: str | None = None
    raw: Any = None
    error: ProvidallError | None = None
    """Renseigné uniquement par les variantes `try_*`, qui ne lèvent jamais."""

    @property
    def ok(self) -> bool:
        return self.error is None

    @property
    def empty(self) -> bool:
        """Réponse vide rejouable — le `reponse_vide` de monumia.

        Vrai seulement si le vide est INEXPLIQUÉ : un budget de sortie épuisé
        ou un filtrage de contenu se reproduiraient à l'identique.
        """
        from .errors import EmptyResponseError

        return isinstance(self.error, EmptyResponseError) and self.error.retryable


@dataclass
class StructuredResponse[T]:
    """Réponse validée. `data` est l'instance Pydantic, `response` l'appel brut."""

    data: T
    response: Response
    attempts: int = 1

    @property
    def ok(self) -> bool:
        return self.response.error is None


@dataclass
class TryStructured[T]:
    """Retour de `try_complete_json` : `data` vaut None quand ça a échoué."""

    data: T | None
    response: Response
    attempts: int = 1

    @property
    def ok(self) -> bool:
        return self.data is not None and self.response.error is None


__all__ = [
    "EFFORTS",
    "Caps",
    "Effort",
    "FinishReason",
    "Message",
    "ModelSpec",
    "Prompt",
    "Protocol",
    "ProviderSpec",
    "Response",
    "Role",
    "Structured",
    "StructuredResponse",
    "Thinking",
    "ToolCall",
    "ToolChoice",
    "TryStructured",
    "Usage",
    "Wire",
]
