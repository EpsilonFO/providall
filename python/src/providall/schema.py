"""Schémas JSON : durcissement, extraction tolérante, erreurs actionnables."""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, TypeAdapter, ValidationError


def json_schema(model: type[BaseModel] | Any) -> dict[str, Any]:
    """Schéma JSON d'un modèle Pydantic (ou de tout type géré par `TypeAdapter`).

    Durci et déréférencé : c'est le même schéma qui est envoyé au fournisseur
    et qui valide la réponse, donc les deux ne peuvent pas diverger.
    """
    if isinstance(model, type) and issubclass(model, BaseModel):
        schema = model.model_json_schema()
    else:
        schema = TypeAdapter(model).json_schema()
    harden(schema)
    return schema


def harden(node: Any) -> None:
    """`additionalProperties: false` partout — exigé par les sorties structurées.

    Anthropic (`output_config.format`) et OpenAI (`response_format` strict)
    refusent tous deux un objet qui ne le déclare pas. Pydantic ne le pose pas
    de lui-même.
    """
    if isinstance(node, dict):
        if node.get("type") == "object" or "properties" in node:
            node.setdefault("additionalProperties", False)
        for valeur in node.values():
            harden(valeur)
    elif isinstance(node, list):
        for valeur in node:
            harden(valeur)


def parse_json_loose(text: str) -> Any | None:
    """Premier objet JSON d'un texte de modèle. `None` si rien d'exploitable.

    Les fournisseurs sans mode JSON natif encadrent l'objet de phrases ou de
    balises ```json. Trois tentatives, de la plus stricte à la plus tolérante.
    """
    if not text or not text.strip():
        return None
    brut = text.strip()
    try:
        return json.loads(brut)
    except ValueError:
        pass

    # Bloc de code balisé : ```json … ``` ou ``` … ```
    if "```" in brut:
        debut = brut.find("```")
        fin = brut.find("```", debut + 3)
        if fin > debut:
            interieur = brut[debut + 3 : fin]
            interieur = interieur.split("\n", 1)[1] if "\n" in interieur else interieur
            try:
                return json.loads(interieur.strip())
            except ValueError:
                pass

    # Plus grand bloc accoladé (ou crocheté, pour une racine de type liste).
    for ouvrant, fermant in (("{", "}"), ("[", "]")):
        i, j = brut.find(ouvrant), brut.rfind(fermant)
        if 0 <= i < j:
            try:
                return json.loads(brut[i : j + 1])
            except ValueError:
                continue
    return None


def format_issues(error: ValidationError) -> str:
    """Erreurs Pydantic → liste que le MODÈLE peut exploiter pour se corriger.

    « Invalid input » seul ne permet à personne de se corriger : on ajoute le
    chemin, les valeurs permises et le type attendu (port de `planner/llm.ts`).
    """
    lignes: list[str] = []
    for issue in error.errors():
        chemin = ".".join(str(p) for p in issue["loc"]) or "(racine)"
        message = issue["msg"]
        ctx = issue.get("ctx") or {}
        permises = ctx.get("expected") or ctx.get("permitted")
        if permises:
            message += f" — attendu : {permises}"
        elif issue.get("type") == "missing":
            message = "champ obligatoire manquant"
        lignes.append(f"- {chemin} : {message}")
    return "\n".join(lignes)


def validate(model: type[BaseModel] | Any, data: Any) -> tuple[Any | None, str]:
    """Valide `data`. Renvoie `(instance, "")` ou `(None, issues)`."""
    try:
        if isinstance(model, type) and issubclass(model, BaseModel):
            return model.model_validate(data), ""
        return TypeAdapter(model).validate_python(data), ""
    except ValidationError as exc:
        return None, format_issues(exc)


def schema_instruction(schema: dict[str, Any]) -> str:
    """Bloc à coller au prompt système quand le fournisseur ne contraint pas.

    `response_format: json_object` garantit du JSON valide, PAS conforme. Sans
    le schéma sous les yeux, le modèle omet des champs et invente des clés —
    mesuré au premier appel réel de monumia.
    """
    return (
        "Ta réponse doit être un objet JSON validant ce schéma, sans clé "
        "supplémentaire et sans texte autour :\n" + json.dumps(schema, ensure_ascii=False, indent=1)
    )


__all__ = [
    "format_issues",
    "harden",
    "json_schema",
    "parse_json_loose",
    "schema_instruction",
    "validate",
]
