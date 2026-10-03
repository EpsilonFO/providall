"""Adaptateur Chat Completions — tout le monde sauf Anthropic.

OpenAI, Gemini, xAI, Moonshot, z.ai, Mistral, DeepSeek, OpenRouter, Groq,
Ollama, vLLM… parlent ce dialecte. Comme c'est le format pivot de la lib, la
traduction se réduit à du nettoyage — mais chaque implémentation a sa
particularité, et c'est la somme de ces particularités qui justifie ce fichier :

  - `max_completion_tokens` chez OpenAI (400 sur `max_tokens`) ;
  - `response_format` tri-état, parce que `json_object` garantit du JSON valide
    et pas conforme, et qu'OpenRouter le transmet tel quel au modèle routé ;
  - le mot « json » exigé dans le prompt par DeepSeek ;
  - `content: ""` et non `null` sur un assistant sans texte (Mistral) ;
  - des ids d'appel d'outil parfois absents ;
  - `reasoning_content` (DeepSeek) qui n'existe nulle part ailleurs ;
  - pas d'en-tête `Authorization` du tout sur un serveur local.

L'API Responses d'OpenAI n'est pas retenue : aucun tiers ne la parle, et tout
ce qu'elle apporte ici (`reasoning_effort`) passe déjà par Chat Completions.
"""

from __future__ import annotations

import json
from typing import Any

from ..errors import EmptyResponseError
from ..registry import clamp_effort
from ..schema import schema_instruction
from ..types import FinishReason, Message, Response, ToolCall, Usage
from .base import (
    Request,
    content_parts,
    getval,
    merge_system,
    resolve_tool_choice,
    sdk_client,
)

_FINISH: dict[str, FinishReason] = {
    "stop": "stop",
    "length": "length",
    "tool_calls": "tool_calls",
    "function_call": "tool_calls",
    "content_filter": "content_filter",
}


class ChatCompletionsAdapter:
    protocol = "openai_compat"

    # ---------------------------------------------------------------- build

    def build(self, req: Request) -> dict[str, Any]:
        """Arguments de `chat.completions.create` — fonction PURE."""
        spec = req.spec
        choix, instruction = resolve_tool_choice(req)
        system = merge_system(req.system, instruction)

        response_format: dict[str, Any] | None = None
        if req.json_schema is not None:
            mode = spec.caps.structured
            if mode == "json_schema":
                response_format = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "response",
                        "strict": True,
                        "schema": req.json_schema,
                    },
                }
            elif mode == "json_object":
                response_format = {"type": "json_object"}
            # `prompt` : rien sur le fil. Dans les trois cas le schéma part
            # aussi dans le système — une contrainte dure n'empêche pas le
            # modèle d'avoir besoin de savoir ce qu'on attend, et sans elle
            # `json_object` produit des clés inventées (mesuré chez monumia).
            system = merge_system(system, schema_instruction(req.json_schema))

        messages = to_native_messages(req.messages, system)
        if response_format is not None and response_format["type"] == "json_object":
            messages = ensure_json_hint(messages)

        body: dict[str, Any] = {
            "model": spec.model_id,
            "messages": messages,
            spec.wire.max_tokens_param: req.max_tokens,
        }
        if response_format is not None:
            body["response_format"] = response_format
        if req.temperature is not None and spec.caps.temperature:
            body["temperature"] = req.temperature

        if spec.caps.effort:
            voulu = req.effort or spec.effort
            if voulu == "none" and spec.wire.thinking_toggle == "deepseek":
                # DeepSeek V4 : « none » n'est pas sur l'échelle de
                # reasoning_effort — c'est l'interrupteur qui coupe la chaîne
                # de pensée.
                body["thinking"] = {"type": "disabled"}
            else:
                effort = clamp_effort(voulu, spec.wire)
                if effort:
                    if spec.wire.effort_param == "reasoning_effort":
                        body["reasoning_effort"] = effort
                    elif spec.wire.effort_param == "openrouter_reasoning":
                        # Paramètre unifié d'OpenRouter, hors schéma OpenAI.
                        # Sans lui, un modèle à raisonnement dépense tout son
                        # budget de sortie en chaîne de pensée : 405 s par
                        # appel, mesuré.
                        body["extra_body"] = {"reasoning": {"effort": effort}}

        if req.tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters or {"type": "object", "properties": {}},
                    },
                }
                for t in req.tools
            ]
            body["tool_choice"] = choix

        if req.stream:
            body["stream"] = True
            # Sans ça, un flux ne rapporte aucun usage : ni coût ni jetons.
            body["stream_options"] = {"include_usage": True}

        if req.extra:
            # Le SDK refuse un argument nommé qu'il ne connaît pas, mais fusionne
            # `extra_body` dans le JSON envoyé : sur le fil, ces clés arrivent
            # au premier niveau, exactement comme en TypeScript.
            body["extra_body"] = {**body.get("extra_body", {}), **req.extra}

        return body

    # ---------------------------------------------------------------- parse

    def parse(self, raw: Any, req: Request) -> Response:
        choix = (getval(raw, "choices", []) or [None])[0]
        if choix is None:
            raise EmptyResponseError(
                "réponse sans `choices`",
                provider=req.spec.provider,
                model=req.spec.alias,
            )
        msg = getval(choix, "message", {}) or {}
        finish = getval(choix, "finish_reason", None)
        contenu = getval(msg, "content", "") or ""
        texte = contenu if isinstance(contenu, str) else _join_parts(contenu)
        appels = parse_tool_calls(getval(msg, "tool_calls", None))

        reponse = Response(
            text=texte,
            model=req.spec.alias,
            model_id=req.spec.model_id,
            provider=req.spec.provider,
            finish_reason=_FINISH.get(str(finish), "other") if finish else None,
            usage=_usage(getval(raw, "usage", None)),
            tool_calls=appels,
            message=Message(role="assistant", content=texte, tool_calls=appels or None),
            # DeepSeek expose sa chaîne de pensée ici ; personne d'autre ne le fait.
            reasoning=getval(msg, "reasoning_content", None) or None,
            raw=raw,
        )

        if not texte and not appels:
            raison = str(finish or "")
            raise EmptyResponseError(
                _diagnostic_vide(raison, req.max_tokens, reponse.usage.output_tokens),
                finish_reason=raison or None,
                # `length` et `content_filter` sont des CAUSES, pas des ratés :
                # elles se reproduiraient. Seul le vide inexpliqué se rejoue.
                retryable=raison not in ("length", "content_filter"),
                provider=req.spec.provider,
                model=req.spec.alias,
            )
        return reponse

    # ----------------------------------------------------------------- I/O

    def send(self, req: Request, body: dict[str, Any]) -> Any:
        client = sdk_client(
            "openai", api_key=req.api_key, base_url=req.base_url, timeout=req.timeout
        )
        return client.chat.completions.create(**body)

    async def asend(self, req: Request, body: dict[str, Any]) -> Any:
        client = sdk_client(
            "openai_async", api_key=req.api_key, base_url=req.base_url, timeout=req.timeout
        )
        return await client.chat.completions.create(**body)

    def stream_ctx(self, req: Request, body: dict[str, Any]) -> Any:
        return self.send(req, body)

    def astream_ctx(self, req: Request, body: dict[str, Any]) -> Any:
        return self.asend(req, body)


# --------------------------------------------------------------------------
# Traduction
# --------------------------------------------------------------------------


def to_native_messages(messages: list[Message], system: str | None) -> list[dict[str, Any]]:
    natifs: list[dict[str, Any]] = []
    if system:
        natifs.append({"role": "system", "content": system})

    for m in messages:
        if m.role == "tool":
            natif: dict[str, Any] = {
                "role": "tool",
                "tool_call_id": m.tool_call_id or "",
                "content": m.text,
            }
            if m.name:
                natif["name"] = m.name
            natifs.append(natif)
        elif m.role == "assistant":
            sortie: dict[str, Any] = {
                "role": "assistant",
                # Un assistant qui n'appelle que des outils a un content vide,
                # pas null : Mistral rejette null.
                "content": m.text,
            }
            if m.tool_calls:
                sortie["tool_calls"] = [
                    {
                        "id": c.id,
                        "type": "function",
                        "function": {"name": c.name, "arguments": c.arguments or "{}"},
                    }
                    for c in m.tool_calls
                ]
            natifs.append(sortie)
        else:
            parties = content_parts(m)
            multimodal = any(p.get("type") != "text" for p in parties)
            natifs.append(
                {
                    "role": m.role,
                    "content": [_part(p) for p in parties] if multimodal else m.text,
                }
            )
    return natifs


def _part(part: dict[str, Any]) -> dict[str, Any]:
    kind = part.get("type")
    if kind == "image_url":
        return {"type": "image_url", "image_url": {"url": part["url"]}}
    if kind == "image_base64":
        media = part.get("media_type", "image/png")
        return {"type": "image_url", "image_url": {"url": f"data:{media};base64,{part['data']}"}}
    return {"type": "text", "text": str(part.get("text", ""))}


def ensure_json_hint(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """DeepSeek (et d'autres) exigent le mot « json » dans le prompt en mode JSON.

    Sans lui, l'API refuse la requête ou boucle à vide. On l'ajoute seulement
    si l'appelant ne l'a pas déjà écrit.
    """
    if any("json" in str(m.get("content", "")).lower() for m in messages):
        return messages
    indice = " Réponds uniquement avec un objet JSON valide."
    copie = list(messages)
    for i, m in enumerate(copie):
        if m.get("role") == "system":
            copie[i] = {**m, "content": f"{m.get('content', '')}{indice}"}
            return copie
    return [{"role": "system", "content": indice.strip()}, *copie]


def parse_tool_calls(raw: Any) -> list[ToolCall]:
    if not raw:
        return []
    appels: list[ToolCall] = []
    for i, c in enumerate(raw):
        fonction = getval(c, "function", {}) or {}
        nom = getval(fonction, "name", "")
        if not nom:
            continue
        arguments = getval(fonction, "arguments", "{}")
        appels.append(
            ToolCall(
                # Certains serveurs compatibles omettent l'id : sans lui, le
                # message `tool` de réponse ne peut pas être rattaché.
                id=str(getval(c, "id", "") or f"call_{i}"),
                name=str(nom),
                arguments=(
                    arguments
                    if isinstance(arguments, str)
                    else json.dumps(arguments, ensure_ascii=False)
                ),
            )
        )
    return appels


def _join_parts(contenu: Any) -> str:
    if isinstance(contenu, list):
        return "".join(
            str(getval(p, "text", "")) for p in contenu if getval(p, "type", "") == "text"
        )
    return str(contenu or "")


def _usage(usage: Any) -> Usage:
    if usage is None:
        return Usage()
    prompt = int(getval(usage, "prompt_tokens", 0) or 0)
    details_in = getval(usage, "prompt_tokens_details", None)
    cache = int(getval(details_in, "cached_tokens", 0) or 0) if details_in else 0
    details_out = getval(usage, "completion_tokens_details", None)
    raisonnement = int(getval(details_out, "reasoning_tokens", 0) or 0) if details_out else 0
    return Usage(
        # `prompt_tokens` inclut le cache ici, contrairement à Anthropic : on
        # le retire pour que `input_tokens` veuille dire la même chose partout.
        input_tokens=max(prompt - cache, 0),
        output_tokens=int(getval(usage, "completion_tokens", 0) or 0),
        cache_read_tokens=cache,
        reasoning_tokens=raisonnement,
    )


def _diagnostic_vide(finish: str, max_tokens: int, sortie: int) -> str:
    """Message de monumia, conservé mot pour mot : il a coûté un benchmark."""
    if finish == "length":
        return (
            f"contenu vide — budget de sortie épuisé avant la réponse ({max_tokens} jetons), "
            f"modèle à raisonnement : augmenter max_tokens ({sortie} jetons de sortie facturés)"
        )
    if finish == "content_filter":
        return "contenu vide — réponse filtrée par le fournisseur"
    return f"contenu vide — finish_reason={finish!r} ({sortie} jetons de sortie facturés)"


ADAPTER = ChatCompletionsAdapter()

__all__ = [
    "ADAPTER",
    "ChatCompletionsAdapter",
    "ensure_json_hint",
    "parse_tool_calls",
    "to_native_messages",
]


# --------------------------------------------------------------------------
# Streaming
# --------------------------------------------------------------------------


class ChunkAccumulator:
    """Réassemble un flux `chat.completions` en une réponse complète.

    Le tout est ensuite passé à `parse()` : le flux et le non-flux passent donc
    par exactement le même code de lecture, et un `finish_reason` de `length`
    est diagnostiqué de la même façon dans les deux cas.
    """

    def __init__(self) -> None:
        self.text: list[str] = []
        self.reasoning: list[str] = []
        self.finish_reason: str | None = None
        self.usage: Any = None
        self._tools: dict[int, dict[str, Any]] = {}

    def feed(self, chunk: Any) -> list[Any]:
        from ..stream import ReasoningDelta, TextDelta, ToolCallDelta

        evenements: list[Any] = []
        usage = getval(chunk, "usage", None)
        if usage:
            self.usage = usage
        choix = (getval(chunk, "choices", []) or [None])[0]
        if choix is None:
            return evenements

        finish = getval(choix, "finish_reason", None)
        if finish:
            self.finish_reason = str(finish)

        delta = getval(choix, "delta", {}) or {}
        morceau = getval(delta, "content", None)
        if morceau:
            self.text.append(str(morceau))
            evenements.append(TextDelta(str(morceau)))
        pensee = getval(delta, "reasoning_content", None)
        if pensee:
            self.reasoning.append(str(pensee))
            evenements.append(ReasoningDelta(str(pensee)))

        for appel in getval(delta, "tool_calls", []) or []:
            # Les fragments sont repérés par `index`, pas par `id` : l'id
            # n'arrive que dans le premier fragment de chaque appel.
            index = int(getval(appel, "index", 0) or 0)
            courant = self._tools.setdefault(index, {"id": "", "name": "", "arguments": ""})
            fonction = getval(appel, "function", {}) or {}
            identifiant = getval(appel, "id", "")
            nom = getval(fonction, "name", "")
            arguments = getval(fonction, "arguments", "") or ""
            if identifiant:
                courant["id"] = str(identifiant)
            if nom:
                courant["name"] = str(nom)
            if arguments:
                courant["arguments"] += str(arguments)
            evenements.append(
                ToolCallDelta(
                    index=index,
                    id=str(identifiant) or None,
                    name=str(nom) or None,
                    arguments=str(arguments),
                )
            )
        return evenements

    def result(self) -> dict[str, Any]:
        """Objet de la même forme qu'une réponse non streamée."""
        message: dict[str, Any] = {"role": "assistant", "content": "".join(self.text)}
        if self.reasoning:
            message["reasoning_content"] = "".join(self.reasoning)
        if self._tools:
            message["tool_calls"] = [
                {
                    "id": t["id"] or f"call_{i}",
                    "type": "function",
                    "function": {"name": t["name"], "arguments": t["arguments"] or "{}"},
                }
                for i, t in sorted(self._tools.items())
            ]
        return {
            "choices": [{"message": message, "finish_reason": self.finish_reason}],
            "usage": self.usage,
        }
