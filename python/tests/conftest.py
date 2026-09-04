"""Fixtures communes. Aucun test ne touche le réseau."""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest

from providall import env as env_module
from providall.hooks import clear_hooks
from providall.providers.base import clear_client_cache
from providall.registry import MODELS, PROVIDERS

_PREFIXES = ("LLM_", "PROVIDALL_")
_SUFFIXES = ("_API_KEY", "_BASE_URL", "_MODEL")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Environnement neutre.

    Sans ça, la machine du dev (qui a ses clés dans son shell) et la CI (qui
    n'en a aucune) ne font pas tourner les mêmes tests — et c'est la CI qui
    découvre le problème.
    """
    for nom in list(os.environ):
        if nom.startswith(_PREFIXES) or nom.endswith(_SUFFIXES):
            monkeypatch.delenv(nom, raising=False)
    # Aucune lecture de `.env` : le dépôt en contient peut-être un.
    monkeypatch.setenv("PROVIDALL_NO_DOTENV", "1")
    env_module.reset_for_tests()
    clear_client_cache()
    clear_hooks()
    yield
    clear_hooks()
    clear_client_cache()


@pytest.fixture(autouse=True)
def registre_intact() -> Iterator[None]:
    """`register_provider`/`register_model` écrivent dans un global : on restaure.

    Sans ça, un test qui déclare un provider maison fait échouer le test de
    parité avec le JSON — et l'ordre des tests décide qui casse.
    """
    providers, models = dict(PROVIDERS), dict(MODELS)
    yield
    PROVIDERS.clear()
    PROVIDERS.update(providers)
    MODELS.clear()
    MODELS.update(models)


@pytest.fixture(autouse=True)
def sans_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pas d'attente réelle entre deux tentatives.

    `RetryPolicy.delay()` reste testée telle quelle — c'est une fonction pure ;
    seul le `sleep` est court-circuité.
    """
    monkeypatch.setattr("providall.retry.time.sleep", lambda _s: None)

    async def _pas_d_attente(_s: float) -> None:
        return None

    monkeypatch.setattr("providall.retry.asyncio.sleep", _pas_d_attente)
    monkeypatch.setattr("providall.client.time.sleep", lambda _s: None)


@pytest.fixture
def anthropic_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-anthropic")


@pytest.fixture
def deepseek_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test-deepseek")
