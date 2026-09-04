"""Table de mapping des exceptions, et l'ordre timeout/connexion."""

from __future__ import annotations

import pytest

from providall.errors import (
    APIError,
    AuthError,
    BadRequestError,
    LLMTimeoutError,
    NetworkError,
    NotFoundError,
    ProvidallError,
    RateLimitError,
    ServerError,
)
from providall.providers.base import from_status, map_exception


@pytest.mark.parametrize(
    ("status", "classe", "retryable"),
    [
        (400, BadRequestError, False),
        (401, AuthError, False),
        (403, AuthError, False),
        (404, NotFoundError, False),
        (408, APIError, True),
        (409, APIError, True),
        (422, BadRequestError, False),
        (429, RateLimitError, True),
        (500, ServerError, True),
        (503, ServerError, True),
        (529, ServerError, True),  # `overloaded_error` d'Anthropic
    ],
)
def test_table_de_mapping(status, classe, retryable):
    erreur = from_status(status, "msg", provider="p", model="m")
    assert type(erreur) is classe
    assert erreur.retryable is retryable
    assert erreur.status == status


def test_404_oriente_vers_l_identifiant_de_modele():
    """Un 404 ici, c'est presque toujours un model_id faux — pas une URL."""
    assert "identifiant de modèle" in from_status(404, "x", provider="p", model="m").message


def test_retry_after_conserve():
    erreur = from_status(429, "x", provider="p", model="m", retry_after=12.0)
    assert isinstance(erreur, RateLimitError) and erreur.retry_after == 12.0


# --- exceptions de SDK ----------------------------------------------------


class _APIConnectionError(Exception):
    pass


class _APITimeoutError(_APIConnectionError):
    """Hérite de la connexion, comme dans les SDK anthropic et openai."""


class _APIStatusError(Exception):
    def __init__(self, status_code: int, body=None, request_id=None):
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code
        self.body = body
        self.request_id = request_id


def test_timeout_teste_avant_connexion():
    """L'ordre inverse ferait disparaître tous les timeouts derrière « réseau »."""
    erreur = map_exception(_APITimeoutError("délai"), provider="p", model="m")
    assert isinstance(erreur, LLMTimeoutError)
    assert erreur.retryable is True


def test_connexion():
    erreur = map_exception(_APIConnectionError("socket"), provider="p", model="m")
    assert isinstance(erreur, NetworkError)
    assert erreur.retryable is True


def test_status_error():
    erreur = map_exception(_APIStatusError(429, request_id="req_1"), provider="p", model="m")
    assert isinstance(erreur, RateLimitError)
    assert erreur.request_id == "req_1"


def test_message_utile_extrait_du_corps():
    exc = _APIStatusError(400, body={"error": {"message": "unsupported_parameter: max_tokens"}})
    assert "unsupported_parameter" in map_exception(exc, provider="p", model="m").message


def test_erreur_providall_traverse_intacte():
    origine = BadRequestError("déjà typée", status=400)
    assert map_exception(origine, provider="p", model="m") is origine


def test_exception_inconnue():
    erreur = map_exception(ValueError("bizarre"), provider="p", model="m")
    assert type(erreur) is ProvidallError
    assert erreur.retryable is False
    assert "ValueError" in erreur.message


def test_str_porte_le_contexte():
    assert "[p · m]" in str(ProvidallError("boum", provider="p", model="m"))
    assert str(ProvidallError("boum")) == "boum"
