"""Outils et boucle d'agent.

Le décorateur `@tool` dérive le schéma de la SIGNATURE de la fonction : le
schéma envoyé au modèle et le code qui reçoit les arguments ne peuvent pas
diverger, exactement comme `json_schema()` fait pour les sorties.

La boucle (`tool_loop`) est le port de `run_agent_loop` (monumia) et de
`agent.ts` (agenda), avec leurs deux règles apprises à l'usage :
  - TOUS les `tool_result` d'un tour partent dans un seul message — les séparer
    apprend au modèle à ne plus paralléliser ses appels ;
  - une erreur de handler est RENVOYÉE au modèle (`is_error`), pas levée : il
    sait souvent se corriger, et une exception ferait perdre tout le tour.
"""

from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .hooks import logger
from .providers.base import ToolDef
from .schema import harden
from .types import Message, Prompt, Response, ToolCall, Usage

if TYPE_CHECKING:
    from .client import Client

DEFAULT_MAX_TURNS = 20


@dataclass
class Tool:
    """Un outil : sa définition pour le modèle, et le code qui l'exécute."""

    definition: ToolDef
    handler: Callable[..., Any] | None = None

    @property
    def name(self) -> str:
        return self.definition.name

    def run(self, arguments: dict[str, Any]) -> Any:
        if self.handler is None:
            raise RuntimeError(f"outil {self.name} sans handler")
        return self.handler(**arguments)


def tool(
    fn: Callable[..., Any] | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
) -> Any:
    """Décorateur : `@tool` sur une fonction annotée suffit.

        @tool
        def meteo(ville: str, jours: int = 1) -> str:
            \"\"\"Prévisions pour une ville.\"\"\"
            ...

    Le schéma vient de `pydantic.TypeAdapter` sur la signature, la description
    de la docstring.
    """

    def decorer(f: Callable[..., Any]) -> Tool:
        return Tool(
            definition=ToolDef(
                name=name or f.__name__,
                description=description or (inspect.getdoc(f) or "").strip(),
                parameters=schema_from_signature(f),
            ),
            handler=f,
        )

    return decorer(fn) if fn is not None else decorer


def schema_from_signature(fn: Callable[..., Any]) -> dict[str, Any]:
    """JSON Schema des paramètres d'une fonction, durci."""
    from pydantic import TypeAdapter, create_model

    signature = inspect.signature(fn)
    champs: dict[str, Any] = {}
    for nom, parametre in signature.parameters.items():
        if nom in ("self", "cls") or parametre.kind in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        ):
            continue
        annotation = (
            parametre.annotation if parametre.annotation is not inspect.Parameter.empty else str
        )
        defaut = ... if parametre.default is inspect.Parameter.empty else parametre.default
        champs[nom] = (annotation, defaut)

    modele = create_model(f"{fn.__name__}_args", **champs)  # type: ignore[call-overload]
    schema = TypeAdapter(modele).json_schema()
    schema.pop("title", None)
    harden(schema)
    return schema


def as_tools(tools: Sequence[Any]) -> list[Tool]:
    sortie: list[Tool] = []
    for t in tools:
        if isinstance(t, Tool):
            sortie.append(t)
        elif isinstance(t, ToolDef):
            sortie.append(Tool(definition=t))
        elif callable(t):
            sortie.append(tool(t))
        else:  # pragma: no cover
            raise TypeError(f"outil non reconnu : {t!r}")
    return sortie


@dataclass
class ToolLoopResult:
    """Résultat d'une boucle : la réponse finale, plus ce qui s'est passé."""

    response: Response
    messages: list[Message] = field(default_factory=list)
    turns: int = 0
    stopped: str = "done"
    """`done` (le modèle a fini) ou `max_turns` (plafond atteint)."""
    usage: Usage = field(default_factory=Usage)
    cost_usd: float | None = None
    calls: list[ToolCall] = field(default_factory=list)

    @property
    def text(self) -> str:
        return self.response.text


def tool_loop(
    client: Client,
    prompt: Prompt,
    *,
    tools: Sequence[Any],
    max_turns: int = DEFAULT_MAX_TURNS,
    on_call: Callable[[ToolCall, Any], None] | None = None,
    **kw: Any,
) -> ToolLoopResult:
    outils = as_tools(tools)
    table = {t.name: t for t in outils}
    conversation = _conversation(prompt)
    cumul = Usage()
    cout: float | None = None
    appels: list[ToolCall] = []

    for tour in range(max_turns):
        reponse = client.complete(conversation, tools=[t.definition for t in outils], **kw)
        cumul = cumul + reponse.usage
        cout = _additionner(cout, reponse.cost_usd)
        if reponse.message:
            conversation.append(reponse.message)

        if not reponse.tool_calls:
            return ToolLoopResult(
                response=reponse,
                messages=conversation,
                turns=tour + 1,
                stopped="done",
                usage=cumul,
                cost_usd=cout,
                calls=appels,
            )

        for appel in reponse.tool_calls:
            appels.append(appel)
            resultat = _executer(table, appel)
            if on_call:
                on_call(appel, resultat)
            conversation.append(
                Message(role="tool", tool_call_id=appel.id, name=appel.name, content=resultat)
            )

    return ToolLoopResult(
        response=reponse,
        messages=conversation,
        turns=max_turns,
        stopped="max_turns",
        usage=cumul,
        cost_usd=cout,
        calls=appels,
    )


async def atool_loop(
    client: Client,
    prompt: Prompt,
    *,
    tools: Sequence[Any],
    max_turns: int = DEFAULT_MAX_TURNS,
    on_call: Callable[[ToolCall, Any], None] | None = None,
    **kw: Any,
) -> ToolLoopResult:
    outils = as_tools(tools)
    table = {t.name: t for t in outils}
    conversation = _conversation(prompt)
    cumul = Usage()
    cout: float | None = None
    appels: list[ToolCall] = []

    for tour in range(max_turns):
        reponse = await client.acomplete(conversation, tools=[t.definition for t in outils], **kw)
        cumul = cumul + reponse.usage
        cout = _additionner(cout, reponse.cost_usd)
        if reponse.message:
            conversation.append(reponse.message)

        if not reponse.tool_calls:
            return ToolLoopResult(
                response=reponse,
                messages=conversation,
                turns=tour + 1,
                stopped="done",
                usage=cumul,
                cost_usd=cout,
                calls=appels,
            )

        # Les appels d'un même tour sont indépendants : les exécuter en
        # parallèle, c'est tout l'intérêt d'avoir une version async.
        resultats = await asyncio.gather(
            *(_aexecuter(table, appel) for appel in reponse.tool_calls)
        )
        for appel, resultat in zip(reponse.tool_calls, resultats, strict=True):
            appels.append(appel)
            if on_call:
                on_call(appel, resultat)
            conversation.append(
                Message(role="tool", tool_call_id=appel.id, name=appel.name, content=resultat)
            )

    return ToolLoopResult(
        response=reponse,
        messages=conversation,
        turns=max_turns,
        stopped="max_turns",
        usage=cumul,
        cost_usd=cout,
        calls=appels,
    )


def _conversation(prompt: Prompt) -> list[Message]:
    from .providers.base import normalize_prompt

    messages, systeme = normalize_prompt(prompt)
    return ([Message(role="system", content=systeme)] if systeme else []) + list(messages)


def _executer(table: dict[str, Tool], appel: ToolCall) -> str:
    outil = table.get(appel.name)
    if outil is None:
        return f"ERREUR : outil inconnu {appel.name!r}. Outils disponibles : {', '.join(table)}"
    try:
        return _rendre(outil.run(appel.parsed()))
    except Exception as exc:  # noqa: BLE001 — l'erreur est une donnée pour le modèle
        logger.warning("outil %s en échec : %s", appel.name, exc)
        return f"ERREUR : {type(exc).__name__}: {exc}"


async def _aexecuter(table: dict[str, Tool], appel: ToolCall) -> str:
    outil = table.get(appel.name)
    if outil is None:
        return f"ERREUR : outil inconnu {appel.name!r}. Outils disponibles : {', '.join(table)}"
    try:
        resultat = outil.run(appel.parsed())
        if inspect.isawaitable(resultat):
            resultat = await resultat
        return _rendre(resultat)
    except Exception as exc:  # noqa: BLE001
        logger.warning("outil %s en échec : %s", appel.name, exc)
        return f"ERREUR : {type(exc).__name__}: {exc}"


def _rendre(valeur: Any) -> str:
    if isinstance(valeur, str):
        return valeur
    try:
        return json.dumps(valeur, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(valeur)


def _additionner(a: float | None, b: float | None) -> float | None:
    """Somme de coûts : `None` (tarif inconnu) contamine, il ne vaut pas zéro."""
    if a is None:
        return b
    if b is None:
        return a
    return a + b


__all__ = [
    "DEFAULT_MAX_TURNS",
    "Tool",
    "ToolDef",
    "ToolLoopResult",
    "as_tools",
    "atool_loop",
    "schema_from_signature",
    "tool",
    "tool_loop",
]
