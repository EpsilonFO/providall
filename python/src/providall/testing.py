"""Faux adaptateur, livré dans le package.

Livré et pas cantonné aux tests de la lib : un projet qui appelle `complete()`
doit pouvoir tester sa propre logique sans réseau ni clé, et sans réécrire ce
harnais. C'est la contrepartie de « une seule couche d'appel » — si elle est
partagée, son double de test doit l'être aussi.

    from providall.testing import fake_provider, chat_reply

    with fake_provider(chat_reply("bonjour")) as faux:
        assert providall.complete("salut", model="ds-flash").text == "bonjour"
        assert faux.bodies[0]["model"] == "deepseek-v4-flash"

`build()` et `parse()` restent ceux du VRAI adaptateur : seul l'envoi est
remplacé. Un test peut donc affirmer sur le corps exact qui serait parti.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from .providers import ADAPTERS
from .providers.base import Request, clear_client_cache

Reply = dict[str, Any] | BaseException | Callable[[Request, dict[str, Any]], Any]


class FakeAdapter:
    """Enveloppe un vrai adaptateur et remplace la seule ligne d'I/O."""

    def __init__(self, protocol: str, replies: list[Reply]) -> None:
        self.protocol = protocol
        self._real = ADAPTERS[protocol]
        self.replies = list(replies)
        self.requests: list[Request] = []
        self.bodies: list[dict[str, Any]] = []

    @property
    def calls(self) -> int:
        return len(self.bodies)

    def build(self, req: Request) -> dict[str, Any]:
        corps = self._real.build(req)
        self.requests.append(req)
        return corps

    def parse(self, raw: Any, req: Request) -> Any:
        return self._real.parse(raw, req)

    def send(self, req: Request, body: dict[str, Any]) -> Any:
        return self._next(req, body)

    async def asend(self, req: Request, body: dict[str, Any]) -> Any:
        return self._next(req, body)

    def stream_ctx(self, req: Request, body: dict[str, Any]) -> Any:
        return self._next(req, body)

    def astream_ctx(self, req: Request, body: dict[str, Any]) -> Any:
        return self._next(req, body)

    def _next(self, req: Request, body: dict[str, Any]) -> Any:
        self.bodies.append(body)
        # La dernière réponse se répète : un test de retry n'a pas à fournir
        # autant de réponses que de tentatives possibles.
        reponse = self.replies[min(len(self.bodies) - 1, len(self.replies) - 1)]
        if isinstance(reponse, BaseException):
            raise reponse
        if callable(reponse):
            return reponse(req, body)
        return reponse


@contextmanager
def fake_provider(*replies: Reply, protocol: str | None = None) -> Iterator[FakeAdapter]:
    """Remplace les adaptateurs le temps du bloc `with`.

    Sans `protocol`, les DEUX protocoles sont remplacés : un test n'a pas à
    savoir lequel le modèle qu'il vise utilise.
    """
    originaux = dict(ADAPTERS)
    protocoles = [protocol] if protocol else list(ADAPTERS)
    faux = {p: FakeAdapter(p, list(replies)) for p in protocoles}
    ADAPTERS.update(faux)
    clear_client_cache()
    try:
        yield faux[protocoles[0]] if len(protocoles) == 1 else _Multi(faux)  # type: ignore[misc]
    finally:
        ADAPTERS.clear()
        ADAPTERS.update(originaux)
        clear_client_cache()


class _Multi:
    """Vue sur les deux faux adaptateurs : agrège ce qui est parti, quel que soit le protocole."""

    def __init__(self, adapters: dict[str, FakeAdapter]) -> None:
        self.adapters = adapters

    @property
    def bodies(self) -> list[dict[str, Any]]:
        return [b for a in self.adapters.values() for b in a.bodies]

    @property
    def requests(self) -> list[Request]:
        return [r for a in self.adapters.values() for r in a.requests]

    @property
    def calls(self) -> int:
        return len(self.bodies)


# --------------------------------------------------------------------------
# Fabriques de réponses brutes
# --------------------------------------------------------------------------


def chat_reply(
    text: str = "",
    *,
    finish_reason: str | None = "stop",
    tool_calls: list[dict[str, Any]] | None = None,
    prompt_tokens: int = 10,
    completion_tokens: int = 5,
    cached_tokens: int = 0,
    reasoning_tokens: int = 0,
    reasoning_content: str | None = None,
) -> dict[str, Any]:
    """Réponse `chat.completions` minimale, au format que `parse()` accepte."""
    message: dict[str, Any] = {"role": "assistant", "content": text}
    if tool_calls:
        message["tool_calls"] = tool_calls
    if reasoning_content:
        message["reasoning_content"] = reasoning_content
    return {
        "choices": [{"message": message, "finish_reason": finish_reason}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "prompt_tokens_details": {"cached_tokens": cached_tokens},
            "completion_tokens_details": {"reasoning_tokens": reasoning_tokens},
        },
    }


def anthropic_reply(
    text: str = "",
    *,
    stop_reason: str = "end_turn",
    tool_uses: list[dict[str, Any]] | None = None,
    thinking: str | None = None,
    input_tokens: int = 10,
    output_tokens: int = 5,
    cache_read: int = 0,
    cache_write: int = 0,
    stop_details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Réponse Messages minimale."""
    blocs: list[dict[str, Any]] = []
    if thinking:
        blocs.append({"type": "thinking", "thinking": thinking})
    if text:
        blocs.append({"type": "text", "text": text})
    for u in tool_uses or []:
        blocs.append({"type": "tool_use", **u})
    return {
        "content": blocs,
        "stop_reason": stop_reason,
        "stop_details": stop_details,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_write,
        },
    }


def tool_call(name: str, arguments: dict[str, Any], *, id: str = "call_0") -> dict[str, Any]:
    """Appel d'outil au format chat-completions, pour `chat_reply(tool_calls=…)`."""
    return {
        "id": id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
    }


def json_reply(payload: Any, **kw: Any) -> dict[str, Any]:
    return chat_reply(json.dumps(payload, ensure_ascii=False), **kw)


__all__ = [
    "FakeAdapter",
    "Reply",
    "anthropic_reply",
    "chat_reply",
    "fake_provider",
    "json_reply",
    "tool_call",
]
