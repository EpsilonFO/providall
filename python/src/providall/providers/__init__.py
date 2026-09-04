"""Deux adaptateurs, un par protocole. En ajouter un = ajouter une entrée ici."""

from __future__ import annotations

from ..types import Protocol
from .anthropic import ADAPTER as ANTHROPIC
from .base import Adapter, Request, ToolDef
from .openai_compat import ADAPTER as CHAT_COMPLETIONS

ADAPTERS: dict[str, Adapter] = {
    "anthropic": ANTHROPIC,
    "openai_compat": CHAT_COMPLETIONS,
}


def adapter_for(protocol: Protocol | str) -> Adapter:
    adaptateur = ADAPTERS.get(str(protocol))
    if adaptateur is None:  # pragma: no cover — le registre valide déjà le protocole
        raise ValueError(f"protocole inconnu : {protocol}")
    return adaptateur


__all__ = ["ADAPTERS", "Adapter", "Request", "ToolDef", "adapter_for"]
