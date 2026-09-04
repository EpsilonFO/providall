"""Durcissement du schéma, extraction JSON tolérante, erreurs actionnables."""

from __future__ import annotations

from typing import Literal

import pytest
from pydantic import BaseModel, Field, ValidationError

from providall import json_schema, parse_json_loose
from providall.schema import format_issues, harden, schema_instruction, validate


class Sous(BaseModel):
    valeur: int


class Sortie(BaseModel):
    nom: str
    genre: Literal["a", "b"]
    sous: Sous
    liste: list[Sous] = Field(default_factory=list)


def test_durcissement_recursif():
    """`additionalProperties: false` partout : les deux fournisseurs l'exigent."""
    schema = json_schema(Sortie)
    assert schema["additionalProperties"] is False
    defs = schema["$defs"]["Sous"]
    assert defs["additionalProperties"] is False


def test_harden_idempotent_et_respecte_l_existant():
    noeud = {"type": "object", "additionalProperties": True, "properties": {}}
    harden(noeud)
    assert noeud["additionalProperties"] is True


@pytest.mark.parametrize(
    ("texte", "attendu"),
    [
        ('{"a": 1}', {"a": 1}),
        ('  {"a": 1}  ', {"a": 1}),
        ('```json\n{"a": 1}\n```', {"a": 1}),
        ('```\n{"a": 1}\n```', {"a": 1}),
        ('Voici la réponse : {"a": 1} — voilà.', {"a": 1}),
        ("[1, 2]", [1, 2]),
        ("Liste : [1, 2] fin", [1, 2]),
    ],
)
def test_parse_json_loose(texte, attendu):
    assert parse_json_loose(texte) == attendu


@pytest.mark.parametrize("texte", ["", "   ", "pas du json", "{cassé"])
def test_parse_json_loose_echoue_proprement(texte):
    assert parse_json_loose(texte) is None


def test_validate_succes():
    valide, soucis = validate(Sous, {"valeur": 3})
    assert valide == Sous(valeur=3) and soucis == ""


def test_issues_actionnables():
    """« Invalid input » seul ne permet à personne — ni au modèle — de se corriger."""
    _, soucis = validate(Sortie, {"nom": "x", "genre": "z", "sous": {}})
    assert "genre" in soucis
    assert "'a'" in soucis or "a" in soucis  # les valeurs permises sont citées
    assert "sous.valeur" in soucis
    assert "champ obligatoire manquant" in soucis


def test_format_issues_sur_erreur_pydantic():
    try:
        Sous.model_validate({"valeur": "abc"})
    except ValidationError as exc:
        assert "valeur" in format_issues(exc)
    else:  # pragma: no cover
        pytest.fail("la validation aurait dû échouer")


def test_schema_instruction_contient_le_schema():
    texte = schema_instruction(json_schema(Sous))
    assert "valeur" in texte and "sans clé" in texte


def test_json_schema_accepte_autre_chose_qu_un_basemodel():
    schema = json_schema(list[int])
    assert schema["type"] == "array"
