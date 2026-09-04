"""Les six étages de la résolution du modèle, et les réglages globaux."""

from __future__ import annotations

import pytest

from providall import resolve_model
from providall.config import (
    api_key_for,
    base_url_for,
    env_defaults,
    normalize_effort,
    resolve,
)
from providall.errors import ConfigError, UnknownModelError
from providall.registry import resolve_spec


def test_1_argument_explicite_prime(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_MODEL", "sonnet")
    monkeypatch.setenv("LLM_MODEL_PLANNER", "opus")
    assert resolve_model("haiku", role="planner").alias == "haiku"


def test_2_modele_par_role(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_MODEL", "sonnet")
    monkeypatch.setenv("LLM_MODEL_PLANNER", "opus")
    assert resolve_model(role="planner").alias == "opus"
    # Rôle sans variable dédiée : on retombe sur LLM_MODEL.
    assert resolve_model(role="coach").alias == "sonnet"


def test_role_normalise_le_nom_de_variable(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_MODEL_MON_ROLE", "haiku")
    assert resolve_model(role="mon-role").alias == "haiku"


def test_3_llm_model(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_MODEL", "ds-flash")
    resolution = resolve()
    assert resolution.spec.alias == "ds-flash"
    assert resolution.source == "LLM_MODEL"


def test_3_llm_model_hors_registre(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_MODEL", "zai:glm-5.4-flash")
    assert resolve_model().model_id == "glm-5.4-flash"


def test_4_llm_provider_seul(monkeypatch: pytest.MonkeyPatch):
    """Compat agenda : `LLM_PROVIDER=openai` suffisait à choisir un modèle."""
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    resolution = resolve()
    assert resolution.spec.model_id == "gpt-5.6-terra"
    assert "LLM_PROVIDER" in resolution.source


def test_4_llm_provider_par_alias(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_PROVIDER", "claude")
    assert resolve_model().model_id == "claude-sonnet-5"


def test_4_llm_provider_plus_modele_nu(monkeypatch: pytest.MonkeyPatch):
    """`LLM_PROVIDER=openai` + `LLM_MODEL=gpt-x` = `openai:gpt-x` (forme agenda)."""
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("LLM_MODEL", "gpt-5.7-nova")
    resolution = resolve()
    assert resolution.spec.provider == "openai"
    assert resolution.spec.model_id == "gpt-5.7-nova"
    assert resolution.source == "LLM_PROVIDER + LLM_MODEL"


def test_4_alias_du_registre_prime_sur_llm_provider(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("LLM_MODEL", "sonnet")
    assert resolve_model().provider == "anthropic"


def test_4_llm_provider_inconnu(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_PROVIDER", "nimportequoi")
    with pytest.raises(ConfigError, match="inconnu"):
        resolve_model()


def test_5_une_seule_cle_suffit(monkeypatch: pytest.MonkeyPatch):
    """Le cœur de « une clé dans .env, un appel »."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-x")
    resolution = resolve()
    assert resolution.spec.model_id == "claude-sonnet-5"
    assert "ANTHROPIC_API_KEY" in resolution.source


def test_5_deux_cles_demandent_de_trancher(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-x")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-y")
    with pytest.raises(ConfigError, match="LLM_MODEL"):
        resolve_model()


def test_5_cle_partagee_ne_compte_qu_une_fois(monkeypatch: pytest.MonkeyPatch):
    """`zai` et `zai_anthropic` partagent ZAI_API_KEY : ce n'est pas une ambiguïté."""
    monkeypatch.setenv("ZAI_API_KEY", "sk-z")
    assert resolve_model().provider == "zai"


def test_5_cle_vide_compte_comme_absente(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "   ")
    with pytest.raises(UnknownModelError):
        resolve_model()


def test_6_rien_du_tout():
    with pytest.raises(UnknownModelError) as exc:
        resolve_model()
    assert "alias du registre" in str(exc.value)


def test_base_url_surchargeable(monkeypatch: pytest.MonkeyPatch):
    s = resolve_spec("ds-flash")
    assert base_url_for(s) == ("https://api.deepseek.com", "registre")
    monkeypatch.setenv("LLM_BASE_URL", "http://localhost:8000/v1")
    assert base_url_for(s) == ("http://localhost:8000/v1", "LLM_BASE_URL")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "http://proxy/v1")
    assert base_url_for(s) == ("http://proxy/v1", "DEEPSEEK_BASE_URL")


def test_base_url_absente_pour_provider_generique():
    with pytest.raises(ConfigError, match="LLM_BASE_URL"):
        base_url_for(resolve_spec("openai_compat:mon-modele"))


def test_api_key_repli_sur_llm_api_key(monkeypatch: pytest.MonkeyPatch):
    s = resolve_spec("ds-flash")
    assert api_key_for(s) == ""
    monkeypatch.setenv("LLM_API_KEY", "generique")
    assert api_key_for(s) == "generique"
    monkeypatch.setenv("DEEPSEEK_API_KEY", "propre")
    assert api_key_for(s) == "propre"


def test_env_defaults(monkeypatch: pytest.MonkeyPatch):
    assert env_defaults() == env_defaults()
    monkeypatch.setenv("LLM_MAX_TOKENS", "4096")
    monkeypatch.setenv("LLM_EFFORT", "HIGH")
    monkeypatch.setenv("LLM_TEMPERATURE", "0")
    monkeypatch.setenv("LLM_RETRIES", "0")
    d = env_defaults()
    assert d.max_tokens == 4096
    assert d.effort == "high"
    assert d.temperature == 0.0
    assert d.retries == 0


def test_timeout_en_secondes_puis_ms(monkeypatch: pytest.MonkeyPatch):
    """`LLM_TIMEOUT_MS` est le repli hérité d'agenda."""
    assert env_defaults().timeout is None
    monkeypatch.setenv("LLM_TIMEOUT_MS", "90000")
    assert env_defaults().timeout == 90.0
    monkeypatch.setenv("LLM_TIMEOUT", "30")
    assert env_defaults().timeout == 30.0


@pytest.mark.parametrize(
    ("valeur", "attendu"),
    [
        ("high", "high"),
        ("HIGH", "high"),
        (" max ", "max"),
        ("turbo", None),
        (None, None),
        ("", None),
    ],
)
def test_normalize_effort(valeur, attendu):
    assert normalize_effort(valeur) == attendu
