"""Adaptateur Anthropic — API Messages native.

Jamais via une couche compatible OpenAI : elle masque `output_config.format`,
`output_config.effort`, le raisonnement adaptatif et `stop_reason=refusal`, qui
sont exactement les quatre raisons d'utiliser Anthropic.

C'est la traduction la plus éloignée du pivot :
  - le prompt système est un champ à part, pas un message ;
  - les appels d'outils sont des blocs `tool_use` dans le contenu assistant, et
    les résultats des blocs `tool_result` dans un message **user** ;
  - `max_tokens` est obligatoire ;
  - les rôles doivent alterner, donc plusieurs réponses d'outils consécutives
    se regroupent dans un seul message.

Le raisonnement produit des blocs signés qu'il faut renvoyer intacts au tour
suivant : d'où le rejeu verbatim de `Message.raw`.
"""

from __future__ import annotations

import json
from typing import Any

from ..errors import EmptyResponseError, RefusalError
from ..registry import clamp_effort
from ..types import FinishReason, Message, Response, ToolCall, Usage
from .base import (
    Request,
    content_parts,
    getval,
    merge_system,
    resolve_tool_choice,
    sdk_client,
)

PROVIDER_TAG = "anthropic"

# Effort → budget de raisonnement, pour les modèles d'avant la 4.6 qui ne
# connaissent que `budget_tokens` (Haiku 4.5). Sur la famille 5, `budget_tokens`
# répond 400 : c'est `output_config.effort` qui règle la profondeur.
THINKING_BUDGET = {
    "none": 0,
    "low": 2_048,
    "medium": 6_000,
    "high": 12_000,
    "xhigh": 24_000,
    "max": 32_000,
}

_STOP_REASONS: dict[str, FinishReason] = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
    "refusal": "refusal",
    "pause_turn": "pause",
}


class AnthropicAdapter:
    protocol = "anthropic"

    # ---------------------------------------------------------------- build

    def build(self, req: Request) -> dict[str, Any]:
        """Requête `messages.create` — fonction PURE, testable sans réseau."""
        spec = req.spec
        natifs = to_native_messages(req.messages)
        choix, instruction = resolve_tool_choice(req)

        system = merge_system(req.system, instruction)
        if req.json_schema is not None and spec.caps.structured != "json_schema":
            # Le fournisseur ne sait pas contraindre : le schéma part dans le
            # système. `json_object` n'existe pas ici — c'est schéma ou rien.
            from ..schema import schema_instruction

            system = merge_system(system, schema_instruction(req.json_schema))

        body: dict[str, Any] = {
            "model": spec.model_id,
            spec.wire.max_tokens_param: req.max_tokens,
            "messages": natifs,
        }
        if system:
            body["system"] = system

        output_config: dict[str, Any] = {}
        if req.json_schema is not None and spec.caps.structured == "json_schema":
            output_config["format"] = {"type": "json_schema", "schema": req.json_schema}
        if spec.caps.effort:
            effort = clamp_effort(req.effort or spec.effort, spec.wire)
            if effort:
                output_config["effort"] = effort
        if output_config:
            body["output_config"] = output_config

        if spec.caps.thinking == "adaptive":
            # Jamais `disabled` : refusé au-delà de `high` sur Opus 5, et
            # laisser le raisonnement actif à effort bas coûte moins cher que de
            # le couper (le modèle écrit alors son raisonnement en clair).
            body["thinking"] = {"type": "adaptive"}
        elif spec.caps.thinking == "budget":
            budget = THINKING_BUDGET.get(req.effort or spec.effort or "", 0)
            if budget:
                # Le budget doit rester sous `max_tokens`, réponse comprise.
                body["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": min(budget, max(req.max_tokens - 4096, 1024)),
                }

        if req.temperature is not None and spec.caps.temperature:
            body["temperature"] = req.temperature

        if req.tools:
            body["tools"] = [
                {
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters or {"type": "object", "properties": {}},
                }
                for t in req.tools
            ]
            body["tool_choice"] = {"type": {"required": "any", "none": "none"}.get(choix, "auto")}

        if req.extra:
            # Même passage qu'en Chat Completions : le SDK fusionne `extra_body`
            # au premier niveau du JSON envoyé.
            body["extra_body"] = dict(req.extra)

        return body

    # ---------------------------------------------------------------- parse

    def parse(self, raw: Any, req: Request) -> Response:
        """Réponse Messages → `Response`. PURE : accepte objet SDK ou dict."""
        blocs = list(getval(raw, "content", []) or [])
        stop_reason = getval(raw, "stop_reason", None)

        texte = "".join(
            str(getval(b, "text", "")) for b in blocs if getval(b, "type", "") == "text"
        )
        raisonnement = "".join(
            str(getval(b, "thinking", "")) for b in blocs if getval(b, "type", "") == "thinking"
        )
        appels = [
            ToolCall(
                id=str(getval(b, "id", "")),
                name=str(getval(b, "name", "")),
                arguments=json.dumps(getval(b, "input", {}) or {}, ensure_ascii=False),
            )
            for b in blocs
            if getval(b, "type", "") == "tool_use"
        ]

        message = Message(
            role="assistant",
            content=texte,
            tool_calls=appels or None,
            # Rejeu verbatim : conserve les blocs signés, exigés dès qu'un
            # `tool_use` suit un raisonnement.
            raw=(PROVIDER_TAG, blocs),
        )

        reponse = Response(
            text=texte,
            model=req.spec.alias,
            model_id=req.spec.model_id,
            provider=req.spec.provider,
            finish_reason=_STOP_REASONS.get(str(stop_reason), "other") if stop_reason else None,
            usage=_usage(getval(raw, "usage", None)),
            tool_calls=appels,
            message=message,
            reasoning=raisonnement or None,
            raw=raw,
        )

        if stop_reason == "refusal":
            details = getval(raw, "stop_details", None)
            raise RefusalError(
                "refus du modèle (stop_reason=refusal)",
                category=getval(details, "category", None) if details else None,
                explanation=getval(details, "explanation", None) if details else None,
                provider=req.spec.provider,
                model=req.spec.alias,
            )
        if not texte and not appels:
            tronque = stop_reason == "max_tokens"
            raise EmptyResponseError(
                _diagnostic_vide(str(stop_reason), req.max_tokens),
                finish_reason=str(stop_reason) if stop_reason else None,
                # Une troncature se reproduirait à l'identique : inutile de
                # rejouer, il faut augmenter `max_tokens`.
                retryable=not tronque,
                provider=req.spec.provider,
                model=req.spec.alias,
            )
        return reponse

    # ----------------------------------------------------------------- I/O

    def send(self, req: Request, body: dict[str, Any]) -> Any:
        client = sdk_client(
            "anthropic", api_key=req.api_key, base_url=req.base_url, timeout=req.timeout
        )
        return client.messages.create(**body)

    async def asend(self, req: Request, body: dict[str, Any]) -> Any:
        client = sdk_client(
            "anthropic_async", api_key=req.api_key, base_url=req.base_url, timeout=req.timeout
        )
        return await client.messages.create(**body)

    def stream_ctx(self, req: Request, body: dict[str, Any]) -> Any:
        client = sdk_client(
            "anthropic", api_key=req.api_key, base_url=req.base_url, timeout=req.timeout
        )
        return client.messages.stream(**body)

    def astream_ctx(self, req: Request, body: dict[str, Any]) -> Any:
        client = sdk_client(
            "anthropic_async", api_key=req.api_key, base_url=req.base_url, timeout=req.timeout
        )
        return client.messages.stream(**body)


# --------------------------------------------------------------------------
# Traduction pivot → natif
# --------------------------------------------------------------------------


def to_native_messages(messages: list[Message]) -> list[dict[str, Any]]:
    """Pivot → messages Anthropic, rôles alternés et `tool_result` groupés."""
    natifs: list[dict[str, Any]] = []

    def pousser(role: str, blocs: list[dict[str, Any]]) -> None:
        if not blocs:
            return
        # Les rôles doivent alterner : on fusionne au lieu d'empiler. C'est
        # aussi ce qui met tous les `tool_result` d'un tour dans un seul message.
        if natifs and natifs[-1]["role"] == role:
            natifs[-1]["content"].extend(blocs)
        else:
            natifs.append({"role": role, "content": list(blocs)})

    for m in messages:
        if m.role == "tool":
            pousser(
                "user",
                [
                    {
                        "type": "tool_result",
                        "tool_use_id": m.tool_call_id or "",
                        "content": m.text,
                    }
                ],
            )
        elif m.role == "assistant":
            if m.raw and m.raw[0] == PROVIDER_TAG and isinstance(m.raw[1], list):
                pousser("assistant", list(m.raw[1]))
                continue
            blocs: list[dict[str, Any]] = []
            texte = m.text.strip()
            if texte:
                blocs.append({"type": "text", "text": texte})
            for appel in m.tool_calls or []:
                blocs.append(
                    {
                        "type": "tool_use",
                        "id": appel.id,
                        "name": appel.name,
                        "input": appel.parsed(),
                    }
                )
            pousser("assistant", blocs)
        else:
            parties = (_part(p) for p in content_parts(m))
            pousser("user", [b for b in parties if b])

    return natifs


def _part(part: dict[str, Any]) -> dict[str, Any] | None:
    """Partie pivot → bloc de contenu Anthropic."""
    kind = part.get("type")
    if kind == "text":
        texte = str(part.get("text", ""))
        return {"type": "text", "text": texte} if texte.strip() else None
    if kind == "image_url":
        return {"type": "image", "source": {"type": "url", "url": part["url"]}}
    if kind == "image_base64":
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": part.get("media_type", "image/png"),
                "data": part["data"],
            },
        }
    return dict(part)  # bloc natif déjà formé : laissé passer tel quel


def _usage(usage: Any) -> Usage:
    if usage is None:
        return Usage()
    lecture = int(getval(usage, "cache_read_input_tokens", 0) or 0)
    ecriture = int(getval(usage, "cache_creation_input_tokens", 0) or 0)
    return Usage(
        # `input_tokens` d'Anthropic exclut déjà le cache : les deux
        # adaptateurs exposent donc la même chose, « entrée hors cache ».
        input_tokens=int(getval(usage, "input_tokens", 0) or 0),
        output_tokens=int(getval(usage, "output_tokens", 0) or 0),
        cache_read_tokens=lecture,
        cache_write_tokens=ecriture,
    )


def _diagnostic_vide(stop_reason: str, max_tokens: int) -> str:
    """Toujours nommer la cause : « contenu vide » seul ne se débogue pas."""
    if stop_reason == "max_tokens":
        return (
            f"contenu vide — budget de sortie épuisé avant la réponse ({max_tokens} jetons) : "
            "modèle à raisonnement, augmenter max_tokens"
        )
    if stop_reason == "pause_turn":
        return "contenu vide — tour mis en pause par un outil serveur (relancer avec l'historique)"
    return f"contenu vide — stop_reason={stop_reason!r}"


ADAPTER = AnthropicAdapter()

__all__ = ["ADAPTER", "PROVIDER_TAG", "THINKING_BUDGET", "AnthropicAdapter", "to_native_messages"]


# --------------------------------------------------------------------------
# Streaming
# --------------------------------------------------------------------------


def map_stream_event(event: Any) -> list[Any]:
    """Événement SSE Anthropic → événements providall.

    Seuls les événements BRUTS du protocole sont traités (`content_block_*`) :
    le SDK émet en plus des événements synthétisés (`text`, `input_json`) qui
    répètent la même information, et les prendre tous les deux doublerait le
    texte.
    """
    from ..stream import ReasoningDelta, TextDelta, ToolCallDelta

    kind = getval(event, "type", "")
    index = int(getval(event, "index", 0) or 0)

    if kind == "content_block_start":
        bloc = getval(event, "content_block", {}) or {}
        if getval(bloc, "type", "") == "tool_use":
            return [
                ToolCallDelta(
                    index=index,
                    id=str(getval(bloc, "id", "")),
                    name=str(getval(bloc, "name", "")),
                )
            ]
        return []

    if kind == "content_block_delta":
        delta = getval(event, "delta", {}) or {}
        dtype = getval(delta, "type", "")
        if dtype == "text_delta":
            return [TextDelta(str(getval(delta, "text", "")))]
        if dtype == "thinking_delta":
            return [ReasoningDelta(str(getval(delta, "thinking", "")))]
        if dtype == "input_json_delta":
            return [ToolCallDelta(index=index, arguments=str(getval(delta, "partial_json", "")))]
    return []
