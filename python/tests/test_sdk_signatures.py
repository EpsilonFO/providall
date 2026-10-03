"""Chaque clé du corps construit doit être un argument du SDK qui l'envoie.

Les adaptateurs Python passent le corps au SDK par `create(**body)` : une clé
qu'il ne connaît pas lève un `TypeError` AVANT tout envoi, et aucun test de
`build()` ne le voit, puisqu'il ne regarde que le dictionnaire. C'est ce qui
est arrivé à `thinking` (DeepSeek, v0.2.0) : juste en TypeScript, où le corps
part tel quel par `fetch`, cassé en Python. Tout ce qui n'est pas un argument
nommé doit passer par `extra_body`.

On balaie tout le registre, avec les options qui ajoutent des clés.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest

from providall.providers import adapter_for
from providall.providers.base import Request, ToolDef
from providall.registry import MODELS, resolve_spec
from providall.types import EFFORTS, Message

OUTIL = ToolDef(name="meteo", description="Prévisions", parameters={"type": "object"})
SCHEMA = {"type": "object", "properties": {"x": {"type": "string"}}}


def _arguments(fonction) -> set[str]:
    return set(inspect.signature(fonction).parameters) - {"self"}


def _arguments_du_sdk(protocole: str) -> set[str]:
    if protocole == "anthropic":
        from anthropic.resources.messages import Messages

        return _arguments(Messages.create) & _arguments(Messages.stream)
    from openai.resources.chat.completions import Completions

    return _arguments(Completions.create)


# Les options qui ajoutent des clés au corps.
OPTIONS: tuple[dict[str, Any], ...] = (
    {},
    {"temperature": 0.2, "tools": [OUTIL], "tool_choice": "auto"},
    {"json_schema": SCHEMA, "stream": True},
    {"extra": {"cle_maison": 1}},
)


def _variantes(alias: str):
    spec = resolve_spec(alias)
    for effort in (None, *EFFORTS):
        for options in OPTIONS:
            yield Request(
                spec=spec,
                messages=[Message(role="user", content="salut")],
                system="Système.",
                max_tokens=1000,
                effort=effort,
                **options,
            )


@pytest.mark.parametrize("alias", sorted(MODELS))
def test_le_corps_ne_porte_que_des_arguments_du_sdk(alias: str):
    spec = resolve_spec(alias)
    acceptes = _arguments_du_sdk(spec.protocol)
    adaptateur = adapter_for(spec.protocol)
    for req in _variantes(alias):
        inconnues = set(adaptateur.build(req)) - acceptes
        assert not inconnues, f"{alias} effort={req.effort} : {sorted(inconnues)}"
