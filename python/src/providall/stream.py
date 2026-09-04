"""Événements de streaming, communs aux deux protocoles.

Un flux rend la même séquence quel que soit le fournisseur :
`TextDelta`* puis éventuellement `ToolCallDelta`*, et toujours un `Done` final
qui porte la `Response` complète (usage, coût, `finish_reason`). Boucler sur
les deltas OU attendre le `Done` sont donc deux façons valables de consommer.
"""

from __future__ import annotations

from dataclasses import dataclass

from .types import Response


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ReasoningDelta:
    """Résumé de raisonnement, quand le fournisseur en émet."""

    text: str


@dataclass(frozen=True)
class ToolCallDelta:
    """Fragment d'appel d'outil. `arguments` arrive en morceaux de JSON."""

    index: int
    id: str | None = None
    name: str | None = None
    arguments: str = ""


@dataclass(frozen=True)
class Done:
    response: Response


StreamEvent = TextDelta | ReasoningDelta | ToolCallDelta | Done


__all__ = ["Done", "ReasoningDelta", "StreamEvent", "TextDelta", "ToolCallDelta"]
