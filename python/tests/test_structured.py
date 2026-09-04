"""Boucle de réparation JSON."""

from __future__ import annotations

import json
from typing import Literal

import pytest
from pydantic import BaseModel

import providall
from providall import Client
from providall.errors import OutputValidationError
from providall.testing import anthropic_reply, chat_reply, fake_provider, json_reply


class Fiche(BaseModel):
    nom: str
    genre: Literal["a", "b"]


@pytest.fixture(autouse=True)
def _cles(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-ds")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-an")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-oa")
    monkeypatch.setenv("LLM_MODEL", "ds-flash")


def test_premier_essai_valide():
    with fake_provider(json_reply({"nom": "x", "genre": "a"})) as faux:
        resultat = providall.complete_json(Fiche, "extrais")
    assert resultat.data == Fiche(nom="x", genre="a")
    assert resultat.attempts == 1
    assert faux.calls == 1


def test_schema_transmis_au_fournisseur():
    with fake_provider(json_reply({"nom": "x", "genre": "a"})) as faux:
        providall.complete_json(Fiche, "extrais", model="gpt-terra")
    format_ = faux.bodies[0]["response_format"]
    assert format_["json_schema"]["strict"] is True
    assert format_["json_schema"]["schema"]["additionalProperties"] is False


def test_json_dans_un_bloc_balise():
    """Un modèle sans mode natif encadre souvent l'objet de ```json."""
    with fake_provider(chat_reply('```json\n{"nom": "x", "genre": "b"}\n```')):
        assert providall.complete_json(Fiche, "extrais").data.genre == "b"


def test_reparation_apres_json_non_conforme():
    with fake_provider(
        json_reply({"nom": "x", "genre": "ZZZ"}),
        json_reply({"nom": "x", "genre": "a"}),
    ) as faux:
        resultat = providall.complete_json(Fiche, "extrais")

    assert resultat.attempts == 2
    # Le deuxième appel porte la réponse fautive ET la liste des erreurs.
    messages = faux.bodies[1]["messages"]
    assert messages[-2]["role"] == "assistant" and "ZZZ" in messages[-2]["content"]
    assert "ne respecte pas le format attendu" in messages[-1]["content"]
    assert "genre" in messages[-1]["content"]


def test_reparation_apres_json_illisible():
    with fake_provider(
        chat_reply("désolé, je ne peux pas"), json_reply({"nom": "x", "genre": "a"})
    ) as faux:
        providall.complete_json(Fiche, "extrais")
    assert "pas du JSON parsable" in faux.bodies[1]["messages"][-1]["content"]


def test_abandon_apres_max_repairs():
    with (
        fake_provider(json_reply({"nom": "x"})) as faux,
        pytest.raises(OutputValidationError) as exc,
    ):
        providall.complete_json(Fiche, "extrais", max_repairs=1)
    assert faux.calls == 2
    assert exc.value.attempts == 2
    assert "genre" in exc.value.issues
    assert json.loads(exc.value.last_text) == {"nom": "x"}


def test_max_repairs_zero():
    with fake_provider(json_reply({"nom": "x"})) as faux, pytest.raises(OutputValidationError):
        providall.complete_json(Fiche, "extrais", max_repairs=0)
    assert faux.calls == 1


def test_try_complete_json_ne_leve_jamais():
    with fake_provider(json_reply({"nom": "x"})):
        resultat = providall.try_complete_json(Fiche, "extrais", max_repairs=0)
    assert resultat.data is None
    assert resultat.ok is False
    assert isinstance(resultat.response.error, OutputValidationError)


def test_pas_de_preremplissage_assistant():
    """Un prefill assistant final répond 400 sur toute la famille Claude 4.6+."""
    with fake_provider(anthropic_reply('{"nom": "x", "genre": "a"}')) as faux:
        providall.complete_json(Fiche, "extrais", model="sonnet")
    assert faux.bodies[0]["messages"][-1]["role"] == "user"


async def test_acomplete_json():
    with fake_provider(json_reply({"nom": "x", "genre": "a"})):
        resultat = await providall.acomplete_json(Fiche, "extrais")
    assert resultat.data.nom == "x"


async def test_atry_complete_json_ne_leve_jamais():
    with fake_provider(json_reply({"nom": "x"})):
        resultat = await providall.atry_complete_json(Fiche, "extrais", max_repairs=0)
    assert resultat.data is None


def test_via_un_client():
    with fake_provider(anthropic_reply('{"nom": "x", "genre": "a"}')):
        assert Client("sonnet").complete_json(Fiche, "extrais").data.nom == "x"
