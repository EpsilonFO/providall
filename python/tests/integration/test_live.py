"""Appels RÉELS, hors CI. Le seul endroit qui dépense de l'argent.

    PROVIDALL_INTEGRATION=1 uv run pytest -m integration -v

Un `complete` et un `complete_json` par provider dont la clé est posée : les
autres sont sautés. C'est le test qui répond aux questions que la suite hors
ligne ne peut pas trancher — un identifiant `id_verified: false` existe-t-il
vraiment, `output_config` passe-t-il sur l'endpoint Anthropic de z.ai, un
modèle à raisonnement d'OpenAI accepte-t-il outils ET `reasoning_effort` en
Chat Completions (§14 du plan).
"""

from __future__ import annotations

import os

import pytest
from pydantic import BaseModel

import providall
from providall import tool
from providall.registry import MODELS

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _active(monkeypatch: pytest.MonkeyPatch):
    if os.environ.get("PROVIDALL_INTEGRATION") != "1":
        pytest.skip("PROVIDALL_INTEGRATION=1 pour activer les appels réels")
    # Contrairement au reste de la suite, on VEUT le `.env` de la machine.
    monkeypatch.delenv("PROVIDALL_NO_DOTENV", raising=False)
    providall.load_env()


class Ville(BaseModel):
    nom: str
    pays: str


# Un modèle par provider : celui qu'on utiliserait réellement.
A_TESTER = ["sonnet", "gpt-terra", "ds-flash", "glm-flash", "gemini-flash", "or-glm"]


def _spec(alias: str):
    spec = MODELS[alias]
    if not spec.key_present:
        pytest.skip(f"{spec.api_key_env} absente")
    return spec


@pytest.mark.parametrize("alias", A_TESTER)
def test_complete(alias: str):
    _spec(alias)
    reponse = providall.complete(
        "Réponds uniquement : OK", model=alias, max_tokens=64, label="integration"
    )
    assert "OK" in reponse.text.upper()
    assert reponse.usage.output_tokens > 0
    assert reponse.latency_s > 0


@pytest.mark.parametrize("alias", A_TESTER)
def test_complete_json(alias: str):
    _spec(alias)
    resultat = providall.complete_json(
        Ville, "Donne la capitale de la France.", model=alias, max_tokens=512
    )
    assert resultat.data.nom.lower().startswith("paris")


@pytest.mark.parametrize("alias", ["sonnet", "gpt-terra", "ds-flash"])
def test_tool_loop(alias: str):
    """Sur `gpt-terra`, ce test tranche la question `openai_responses` (§14)."""
    _spec(alias)

    @tool
    def population(ville: str) -> int:
        """Population d'une ville."""
        return 2_100_000 if ville.lower().startswith("paris") else 0

    resultat = providall.tool_loop(
        "Combien d'habitants à Paris ? Utilise l'outil.",
        tools=[population],
        model=alias,
        effort="low",
        max_tokens=1024,
    )
    assert resultat.calls, "aucun outil appelé"
    assert "2" in resultat.text


@pytest.mark.parametrize("alias", ["sonnet", "ds-flash"])
def test_stream(alias: str):
    from providall.stream import Done, TextDelta

    _spec(alias)
    morceaux: list[str] = []
    finale = None
    for evenement in providall.stream("Compte de 1 à 5.", model=alias, max_tokens=128):
        if isinstance(evenement, TextDelta):
            morceaux.append(evenement.text)
        elif isinstance(evenement, Done):
            finale = evenement.response
    assert morceaux
    assert finale is not None and finale.text == "".join(morceaux)


def test_zai_anthropic_output_config():
    """Les caps prudentes de `zai_anthropic` (§14) : à relever ici."""
    spec = providall.resolve_spec("zai_anthropic:glm-5.3")
    if not spec.key_present:
        pytest.skip("ZAI_API_KEY absente")
    reponse = providall.complete("Réponds : OK", model="zai_anthropic:glm-5.3", max_tokens=64)
    assert reponse.text
