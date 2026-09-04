"""Sortie JSON validée, avec boucle de réparation.

Trois couches, de la plus dure à la plus molle, parce qu'aucune ne suffit
seule :

1. La contrainte du fournisseur (`output_config.format`, `response_format`
   json_schema strict). Quand elle existe, elle garantit un JSON conforme.
2. Le schéma dans le prompt système. `json_object` garantit du JSON VALIDE, pas
   CONFORME : sans le schéma sous les yeux, le modèle omet des champs et invente
   des clés — mesuré au premier appel réel de monumia.
3. La validation Pydantic côté lib, puis la RÉPARATION : on renvoie au modèle
   la liste de ses erreurs et on redemande. Port de `planner/llm.ts` (agenda),
   où deux réparations suffisent dans la quasi-totalité des cas.

Jamais de préremplissage assistant pour forcer le `{` : refusé par un 400 sur
toute la famille Claude 4.6+.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .errors import OutputValidationError, ProvidallError
from .schema import json_schema, parse_json_loose, validate
from .types import Message, Prompt, Response, StructuredResponse, TryStructured

if TYPE_CHECKING:
    from .client import Client

REPAIR_PROMPT = (
    "Ta réponse ne respecte pas le format attendu :\n{issues}\n"
    "Renvoie UNIQUEMENT l'objet JSON corrigé, sans texte autour."
)
DEFAULT_MAX_REPAIRS = 2


def _messages(prompt: Prompt) -> list[Message]:
    from .providers.base import normalize_prompt

    messages, systeme = normalize_prompt(prompt)
    return ([Message(role="system", content=systeme)] if systeme else []) + messages


def complete_json(
    client: Client,
    schema: Any,
    prompt: Prompt,
    *,
    max_repairs: int = DEFAULT_MAX_REPAIRS,
    **kw: Any,
) -> StructuredResponse[Any]:
    """Appelle, valide, répare. Lève `OutputValidationError` si rien ne passe."""
    plan = json_schema(schema)
    conversation = _messages(prompt)
    derniers_soucis = ""
    dernier_texte = ""
    reponse: Response | None = None

    for tentative in range(max_repairs + 1):
        reponse = client.complete(conversation, json_schema=plan, **kw)
        dernier_texte = reponse.text
        donnees = parse_json_loose(dernier_texte)
        if donnees is not None:
            valide, soucis = validate(schema, donnees)
            if valide is not None:
                return StructuredResponse(data=valide, response=reponse, attempts=tentative + 1)
            derniers_soucis = soucis
        else:
            derniers_soucis = "- la réponse n'est pas du JSON parsable"
        conversation = _relancer(conversation, dernier_texte, derniers_soucis)

    raise OutputValidationError(
        f"sortie invalide après {max_repairs + 1} tentative(s) :\n{derniers_soucis}",
        attempts=max_repairs + 1,
        issues=derniers_soucis,
        last_text=dernier_texte,
        provider=reponse.provider if reponse else None,
        model=reponse.model if reponse else None,
    )


async def acomplete_json(
    client: Client,
    schema: Any,
    prompt: Prompt,
    *,
    max_repairs: int = DEFAULT_MAX_REPAIRS,
    **kw: Any,
) -> StructuredResponse[Any]:
    plan = json_schema(schema)
    conversation = _messages(prompt)
    derniers_soucis = ""
    dernier_texte = ""
    reponse: Response | None = None

    for tentative in range(max_repairs + 1):
        reponse = await client.acomplete(conversation, json_schema=plan, **kw)
        dernier_texte = reponse.text
        donnees = parse_json_loose(dernier_texte)
        if donnees is not None:
            valide, soucis = validate(schema, donnees)
            if valide is not None:
                return StructuredResponse(data=valide, response=reponse, attempts=tentative + 1)
            derniers_soucis = soucis
        else:
            derniers_soucis = "- la réponse n'est pas du JSON parsable"
        conversation = _relancer(conversation, dernier_texte, derniers_soucis)

    raise OutputValidationError(
        f"sortie invalide après {max_repairs + 1} tentative(s) :\n{derniers_soucis}",
        attempts=max_repairs + 1,
        issues=derniers_soucis,
        last_text=dernier_texte,
        provider=reponse.provider if reponse else None,
        model=reponse.model if reponse else None,
    )


def try_complete_json(client: Client, schema: Any, prompt: Prompt, **kw: Any) -> TryStructured[Any]:
    """Ne lève jamais. `data` vaut None en cas d'échec, `response.error` dit pourquoi."""
    try:
        valide = complete_json(client, schema, prompt, **kw)
        return TryStructured(data=valide.data, response=valide.response, attempts=valide.attempts)
    except ProvidallError as exc:
        return TryStructured(data=None, response=_reponse_echec(exc), attempts=_essais(exc))


async def atry_complete_json(
    client: Client, schema: Any, prompt: Prompt, **kw: Any
) -> TryStructured[Any]:
    try:
        valide = await acomplete_json(client, schema, prompt, **kw)
        return TryStructured(data=valide.data, response=valide.response, attempts=valide.attempts)
    except ProvidallError as exc:
        return TryStructured(data=None, response=_reponse_echec(exc), attempts=_essais(exc))


def _relancer(conversation: list[Message], brut: str, soucis: str) -> list[Message]:
    """Ajoute la réponse fautive et la demande de correction.

    On garde la réponse fautive dans l'historique : sans elle le modèle ne sait
    pas ce qu'on lui reproche, et il refait souvent la même erreur.
    """
    return [
        *conversation,
        Message(role="assistant", content=brut),
        Message(role="user", content=REPAIR_PROMPT.format(issues=soucis)),
    ]


def _reponse_echec(exc: ProvidallError) -> Response:
    return Response(
        model=exc.model or "",
        provider=exc.provider or "",
        error=exc,
        attempts=_essais(exc),
    )


def _essais(exc: ProvidallError) -> int:
    return getattr(exc, "attempts", 1)


__all__ = [
    "DEFAULT_MAX_REPAIRS",
    "REPAIR_PROMPT",
    "acomplete_json",
    "atry_complete_json",
    "complete_json",
    "try_complete_json",
]
