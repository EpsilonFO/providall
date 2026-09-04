"""Registre : parité avec le JSON, héritage, surcharges, échappatoire."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from providall import ModelSpec, list_models, list_providers, register_model, spec
from providall.errors import UnknownModelError
from providall.registry import (
    MODELS,
    PROVIDERS,
    clamp_effort,
    find_provider,
    resolve_spec,
)
from providall.types import Wire

RACINE = Path(__file__).resolve().parents[2]


def _json(nom: str) -> dict:
    brut = json.loads((RACINE / "registry" / nom).read_text(encoding="utf-8"))
    return {k: v for k, v in brut.items() if not k.startswith("$")}


def test_parite_avec_le_json():
    """Le module généré doit correspondre au JSON, sinon `npm run gen` a été oublié."""
    assert set(_json("providers.json")) == set(PROVIDERS)
    assert set(_json("models.json")) == set(MODELS)


def test_parite_des_champs_de_modele():
    for alias, data in _json("models.json").items():
        spec_ = MODELS[alias]
        assert spec_.model_id == data["model_id"]
        assert spec_.provider == data["provider"]
        assert spec_.price_in == data.get("price_in")
        assert spec_.id_verified == data.get("id_verified", True)


def test_aucun_alias_en_double():
    """Un alias de provider en double rendrait la résolution dépendante de l'ordre."""
    vus: dict[str, str] = {}
    for nom, p in PROVIDERS.items():
        for alias in (nom, *p.aliases):
            assert alias not in vus, f"{alias} : {vus.get(alias)} et {nom}"
            vus[alias] = nom


def test_heritage_du_protocole():
    """Ce qu'un provider ne déclare pas vient du protocole."""
    assert PROVIDERS["gemini"].caps.tools is True  # défaut openai_compat
    assert PROVIDERS["gemini"].wire.max_tokens_param == "max_tokens"
    assert PROVIDERS["anthropic"].caps.thinking == "adaptive"
    assert PROVIDERS["anthropic"].caps.temperature is False


def test_surcharges_du_provider():
    assert PROVIDERS["openai"].wire.max_tokens_param == "max_completion_tokens"
    assert PROVIDERS["openai"].caps.temperature is False
    assert PROVIDERS["openai"].caps.effort is True
    assert PROVIDERS["deepseek"].max_tokens == 32_000
    assert PROVIDERS["openrouter"].effort == "medium"
    assert PROVIDERS["openrouter"].caps.structured == "prompt"
    assert PROVIDERS["ollama"].requires_key is False


def test_surcharges_du_modele():
    assert MODELS["haiku"].caps.effort is False
    assert MODELS["haiku"].caps.thinking == "budget"
    assert MODELS["haiku"].caps.temperature is True
    assert MODELS["fable"].caps.forced_tool_choice is False
    assert MODELS["or-glm"].caps.structured == "json_schema"  # surcharge le `prompt` du provider
    assert MODELS["sonnet-4.6"].wire.effort_values == ("low", "medium", "high", "max")


def test_tarif_inconnu_reste_inconnu():
    assert MODELS["glm-flash"].price_known is False
    assert MODELS["glm-flash"].price_in is None
    assert MODELS["sonnet"].price_known is True


def test_prix_de_lecture_de_cache_par_defaut():
    assert MODELS["opus"].price_cache_read == pytest.approx(0.5)  # 5,00 / 10
    assert MODELS["fable"].price_cache_read == 0.25  # explicite dans le JSON


def test_echappatoire_provider_model_id():
    s = resolve_spec("zai:glm-5.4-flash")
    assert s.provider == "zai"
    assert s.model_id == "glm-5.4-flash"
    assert s.id_verified is False
    assert s.price_known is False
    assert s.base_url == PROVIDERS["zai"].base_url


def test_echappatoire_herite_de_l_effort_du_provider():
    s = resolve_spec("openrouter:z-ai/glm-4.6")
    assert s.effort == "medium"
    assert s.max_tokens == 32_000
    assert s.model_id == "z-ai/glm-4.6"  # le « / » n'est pas un séparateur


def test_echappatoire_par_alias_de_provider():
    assert resolve_spec("claude:claude-opus-5").provider == "anthropic"
    assert resolve_spec("grok:grok-9").provider == "xai"


@pytest.mark.parametrize("nom", ["inconnu", "pasunprovider:x", "zai:", ":x", ""])
def test_modele_inconnu(nom: str):
    with pytest.raises(UnknownModelError):
        resolve_spec(nom)


def test_message_d_erreur_liste_les_options():
    with pytest.raises(UnknownModelError) as exc:
        resolve_spec("sonnnet")
    message = str(exc.value)
    assert "sonnet" in message and "anthropic" in message


def test_find_provider():
    assert find_provider("claude") is PROVIDERS["anthropic"]
    assert find_provider("ANTHROPIC") is PROVIDERS["anthropic"]
    assert find_provider("kimi") is PROVIDERS["moonshot"]
    assert find_provider("inexistant") is None


def test_enregistrement_a_l_execution():
    maison = spec("maison", "openai_compat", "mon-modele", price_in=1.0, price_out=2.0)
    register_model(maison)
    try:
        assert resolve_spec("maison").model_id == "mon-modele"
        with pytest.raises(ValueError):
            register_model(maison)
        register_model(
            spec("maison", "openai_compat", "v2", price_in=1.0, price_out=2.0), replace=True
        )
        assert resolve_spec("maison").model_id == "v2"
    finally:
        MODELS.pop("maison", None)


def test_list_models_only_available(monkeypatch: pytest.MonkeyPatch):
    assert list_models(only_available=True) == []
    monkeypatch.setenv("DEEPSEEK_API_KEY", "x")
    disponibles = {m.alias for m in list_models(only_available=True)}
    assert disponibles == {"ds-flash", "ds-pro"}


def test_list_providers_non_vide():
    assert len(list_providers()) == len(PROVIDERS)
    assert all(isinstance(m, ModelSpec) for m in list_models())


@pytest.mark.parametrize(
    ("demande", "echelle", "attendu"),
    [
        ("xhigh", ("none", "low", "medium", "high"), "high"),
        ("none", ("low", "medium", "high", "xhigh", "max"), "low"),
        ("medium", ("low", "medium", "high"), "medium"),
        ("max", ("low", "medium", "high", "max"), "max"),
        (None, ("low",), None),
        ("high", (), None),
    ],
)
def test_clamp_effort(demande, echelle, attendu):
    """Un effort hors échelle est ramené, jamais rejeté : changer de provider
    ne doit pas casser un appel générique."""
    assert clamp_effort(demande, Wire("max_tokens", "x", echelle)) == attendu
