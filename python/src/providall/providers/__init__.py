"""Un adaptateur par protocole. En ajouter un = ajouter une entrée ici.

`systemone` n'est pas un dialecte de chat : seul `decide()` l'appelle, et
`Client.prepare()` refuse un modèle System One avant d'arriver ici. Il est
inscrit pour que `providall.testing.fake_provider` le remplace comme les autres.
"""

from __future__ import annotations

from ..types import Protocol
from .anthropic import ADAPTER as ANTHROPIC
from .base import Adapter, Request, ToolDef
from .openai_compat import ADAPTER as CHAT_COMPLETIONS
from .systemone import ADAPTER as SYSTEM_ONE

ADAPTERS: dict[str, Adapter] = {
    "anthropic": ANTHROPIC,
    "openai_compat": CHAT_COMPLETIONS,
    "systemone": SYSTEM_ONE,  # type: ignore[dict-item] — DecisionRequest, pas Request
}


def adapter_for(protocol: Protocol | str) -> Adapter:
    adaptateur = ADAPTERS.get(str(protocol))
    if adaptateur is None:  # pragma: no cover — le registre valide déjà le protocole
        raise ValueError(f"protocole inconnu : {protocol}")
    return adaptateur


__all__ = ["ADAPTERS", "Adapter", "Request", "ToolDef", "adapter_for"]
