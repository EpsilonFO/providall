"""Chargement du `.env` : priorités, remontée, opt-out."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from providall import env as env_module
from providall.env import env_bool, env_float, env_int, env_str, load_env


@pytest.fixture(autouse=True)
def _autorise_dotenv(monkeypatch: pytest.MonkeyPatch):
    """La fixture globale coupe dotenv ; ce fichier-ci le teste."""
    monkeypatch.delenv("PROVIDALL_NO_DOTENV", raising=False)
    env_module.reset_for_tests()


def _ecrire(dossier: Path, nom: str, contenu: str) -> None:
    (dossier / nom).write_text(contenu, encoding="utf-8")


def test_env_local_prime_sur_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _ecrire(tmp_path, ".env", "LLM_MODEL=depuis-env\nLLM_EFFORT=low\n")
    _ecrire(tmp_path, ".env.local", "LLM_MODEL=depuis-local\n")
    monkeypatch.chdir(tmp_path)

    load_env()
    assert os.environ["LLM_MODEL"] == "depuis-local"
    assert os.environ["LLM_EFFORT"] == "low"  # `.env` reste lu pour le reste


def test_le_process_prime_sur_les_fichiers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """`LLM_MODEL=x uv run …` doit gagner : sinon la CI se fait écraser."""
    _ecrire(tmp_path, ".env", "LLM_MODEL=depuis-env\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("LLM_MODEL", "depuis-le-shell")

    load_env()
    assert os.environ["LLM_MODEL"] == "depuis-le-shell"


def test_remontee_depuis_un_sous_dossier(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _ecrire(tmp_path, ".env", "LLM_MODEL=racine\n")
    profond = tmp_path / "backend" / "scripts"
    profond.mkdir(parents=True)
    monkeypatch.chdir(profond)

    fichiers = load_env()
    assert fichiers == [tmp_path / ".env"]
    assert os.environ["LLM_MODEL"] == "racine"


def test_le_premier_dossier_trouve_gagne(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Pas de fusion entre niveaux : un `.env` de $HOME ne doit rien contaminer."""
    _ecrire(tmp_path, ".env", "LLM_MODEL=parent\n")
    enfant = tmp_path / "projet"
    enfant.mkdir()
    _ecrire(enfant, ".env", "LLM_MODEL=enfant\n")
    monkeypatch.chdir(enfant)

    assert load_env() == [enfant / ".env"]
    assert os.environ["LLM_MODEL"] == "enfant"


def test_opt_out(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _ecrire(tmp_path, ".env", "LLM_MODEL=depuis-env\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PROVIDALL_NO_DOTENV", "1")

    env_module.ensure_loaded()
    assert "LLM_MODEL" not in os.environ


def test_chargement_paresseux_une_seule_fois(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _ecrire(tmp_path, ".env", "LLM_MODEL=un\n")
    monkeypatch.chdir(tmp_path)

    env_module.ensure_loaded()
    _ecrire(tmp_path, ".env", "LLM_MODEL=deux\n")
    env_module.ensure_loaded()
    assert os.environ["LLM_MODEL"] == "un"


def test_load_env_explicite_avec_dossier(tmp_path: Path):
    _ecrire(tmp_path, ".env", "LLM_MODEL=explicite\n")
    assert load_env(tmp_path) == [tmp_path / ".env"]
    assert os.environ["LLM_MODEL"] == "explicite"


@pytest.mark.parametrize(
    ("valeur", "attendu"), [("x", "x"), ("  x  ", "x"), ("", None), ("   ", None)]
)
def test_env_str(monkeypatch: pytest.MonkeyPatch, valeur, attendu):
    """Une variable posée à vide compte comme absente, pas comme chaîne vide."""
    monkeypatch.setenv("PROVIDALL_NO_DOTENV", "1")
    monkeypatch.setenv("TEST_VAR", valeur)
    assert env_str("TEST_VAR") == attendu


def test_conversions(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PROVIDALL_NO_DOTENV", "1")
    monkeypatch.setenv("N", "42")
    monkeypatch.setenv("F", "1.5")
    monkeypatch.setenv("B", "yes")
    monkeypatch.setenv("MAUVAIS", "abc")
    assert env_int("N") == 42
    assert env_float("F") == 1.5
    assert env_bool("B") is True
    assert env_int("MAUVAIS") is None
    assert env_float("MAUVAIS") is None
    assert env_bool("MAUVAIS") is False
