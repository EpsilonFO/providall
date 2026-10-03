"""Pipeline complet avec `FakeAdapter` : retry, `try_*`, hooks, coût, stream."""

from __future__ import annotations

import pytest

import providall
from providall import Client, Message, Response
from providall.errors import (
    APIError,
    CapabilityError,
    MissingKeyError,
    ProvidallError,
    RateLimitError,
    ServerError,
    UnknownModelError,
)
from providall.retry import RetryPolicy
from providall.testing import anthropic_reply, chat_reply, fake_provider


@pytest.fixture(autouse=True)
def _cles(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-ds")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-an")
    monkeypatch.setenv("LLM_MODEL", "ds-flash")


def test_appel_nominal():
    with fake_provider(chat_reply("bonjour", prompt_tokens=100, completion_tokens=50)) as faux:
        reponse = providall.complete("salut")
    assert reponse.text == "bonjour"
    assert reponse.ok and reponse.attempts == 1
    assert reponse.model == "ds-flash" and reponse.model_id == "deepseek-v4-flash"
    assert faux.bodies[0]["messages"] == [{"role": "user", "content": "salut"}]


def test_cout_calcule():
    with fake_provider(chat_reply("x", prompt_tokens=1_000_000, completion_tokens=1_000_000)):
        reponse = providall.complete("salut")
    assert reponse.cost_usd == pytest.approx(0.28 + 0.42)


def test_cout_inconnu_reste_none():
    """Un tarif absent doit donner `None`, jamais un faux 0."""
    with fake_provider(chat_reply("x")):
        reponse = providall.complete("salut", model="deepseek:un-modele-tout-neuf")
    assert reponse.cost_usd is None


def test_system_et_messages_fusionnes():
    conversation = [
        Message(role="system", content="B"),
        Message(role="user", content="q"),
    ]
    with fake_provider(chat_reply("ok")) as faux:
        providall.complete(conversation, system="A")
    assert faux.bodies[0]["messages"][0]["content"] == "A\n\nB"


def test_choix_du_modele_a_l_appel():
    with fake_provider(anthropic_reply("ok")) as faux:
        reponse = providall.complete("salut", model="sonnet")
    assert reponse.provider == "anthropic"
    assert faux.bodies[0]["model"] == "claude-sonnet-5"


def test_cle_manquante_avant_tout_envoi(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    with fake_provider(chat_reply("ok")) as faux, pytest.raises(MissingKeyError) as exc:
        providall.complete("salut", model="sonnet")
    assert faux.calls == 0
    assert "ANTHROPIC_API_KEY" in str(exc.value)
    assert "console.anthropic.com" in str(exc.value)


def test_capacite_manquante_avant_tout_envoi(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_BASE_URL", "http://localhost:8000/v1")
    with fake_provider(chat_reply("ok")) as faux, pytest.raises(CapabilityError):
        providall.complete(
            [Message(role="user", content=[{"type": "image_url", "url": "http://x"}])],
            model="openai_compat:local",
        )
    assert faux.calls == 0


# ------------------------------------------------------------------ retry


def test_retry_sur_erreur_transitoire():
    with fake_provider(
        ServerError("503", status=503), ServerError("503", status=503), chat_reply("enfin")
    ) as faux:
        reponse = providall.complete("salut")
    assert reponse.text == "enfin"
    assert reponse.attempts == 3
    assert faux.calls == 3


def test_pas_de_retry_sur_erreur_definitive():
    with fake_provider(APIError("400", status=400)) as faux, pytest.raises(APIError):
        providall.complete("salut")
    assert faux.calls == 1


def test_retries_epuises():
    with fake_provider(ServerError("503", status=503)) as faux, pytest.raises(ServerError):
        Client(retry=RetryPolicy(retries=1)).complete("salut")
    assert faux.calls == 2


def test_retry_desactivable_par_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_RETRIES", "0")
    with fake_provider(ServerError("503", status=503)) as faux, pytest.raises(ServerError):
        providall.complete("salut")
    assert faux.calls == 1


def test_retry_after_respecte():
    politique = RetryPolicy(retries=2)
    assert politique.delay(1, RateLimitError("429", retry_after=7.0)) == 7.0
    assert politique.delay(1, ServerError("503")) == 2.0
    assert politique.delay(2, ServerError("503")) == 4.0


def test_reponse_vide_inexpliquee_est_rejouee():
    with fake_provider(chat_reply("", finish_reason="stop"), chat_reply("ok")) as faux:
        reponse = providall.complete("salut")
    assert reponse.text == "ok" and faux.calls == 2


def test_reponse_vide_par_troncature_ne_l_est_pas():
    with fake_provider(chat_reply("", finish_reason="length")) as faux:
        reponse = providall.try_complete("salut")
    assert faux.calls == 1
    assert reponse.empty is False  # expliqué : pas un raté à rejouer


# ------------------------------------------------------------------ try_*


def test_try_complete_ne_leve_jamais():
    with fake_provider(APIError("400", status=400)):
        reponse = providall.try_complete("salut")
    assert reponse.ok is False
    assert isinstance(reponse.error, APIError)
    assert reponse.model == "ds-flash"


def test_try_complete_sur_erreur_de_config(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LLM_MODEL")
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    monkeypatch.delenv("DEEPSEEK_API_KEY")
    reponse = providall.try_complete("salut")
    assert isinstance(reponse.error, UnknownModelError)


def test_empty_expose_le_raté_rejouable(monkeypatch: pytest.MonkeyPatch):
    """`.empty` remplace le `reponse_vide` de monumia."""
    monkeypatch.setenv("LLM_RETRIES", "0")
    with fake_provider(chat_reply("", finish_reason="stop")):
        reponse = providall.try_complete("salut")
    assert reponse.empty is True


def test_attempts_visible_apres_echec():
    with fake_provider(ServerError("503", status=503)):
        reponse = providall.try_complete("salut")
    assert reponse.attempts == 3


# ------------------------------------------------------------------ hooks


def test_hook_appele_sur_succes_et_echec():
    vus: list[Response] = []
    client = Client(on_response=vus.append)
    with fake_provider(chat_reply("ok"), APIError("400", status=400)):
        client.complete("a")
        client.try_complete("b")
    assert len(vus) == 2
    assert vus[0].ok and not vus[1].ok


def test_hook_global():
    vus: list[Response] = []
    providall.on_response(vus.append)
    with fake_provider(chat_reply("ok")):
        providall.complete("a")
    assert len(vus) == 1


def test_hook_casse_ne_casse_pas_l_appel():
    def hook(_r: Response) -> None:
        raise RuntimeError("boum")

    with fake_provider(chat_reply("ok")):
        assert Client(on_response=hook).complete("a").text == "ok"


# ----------------------------------------------------------------- Client


def test_client_with_options():
    base = Client(model="sonnet", max_tokens=100, label="a")
    derive = base.with_options(max_tokens=200)
    assert base.max_tokens == 100 and derive.max_tokens == 200
    assert derive.model == "sonnet" and derive.label == "a"


def test_options_a_l_appel_priment_sur_le_client():
    with fake_provider(chat_reply("ok")) as faux:
        Client(max_tokens=100).complete("a", max_tokens=555)
    assert faux.bodies[0]["max_tokens"] == 555


def test_env_prime_sur_le_defaut_du_modele(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_MAX_TOKENS", "4096")
    with fake_provider(chat_reply("ok")) as faux:
        providall.complete("a")
    assert faux.bodies[0]["max_tokens"] == 4096


def test_env_injectable_pour_les_tests():
    client = Client(env={"LLM_MODEL": "sonnet", "ANTHROPIC_API_KEY": "sk-x"})
    with fake_provider(anthropic_reply("ok")):
        assert client.complete("a").model == "sonnet"


def test_prepare_n_envoie_rien():
    with fake_provider(chat_reply("ok")) as faux:
        req = Client().prepare("salut", model="sonnet", max_tokens=42)
    assert faux.calls == 0
    assert req.spec.model_id == "claude-sonnet-5" and req.max_tokens == 42


# ------------------------------------------------------------------ async


async def test_acomplete():
    with fake_provider(chat_reply("async")):
        reponse = await providall.acomplete("salut")
    assert reponse.text == "async"


async def test_atry_complete_ne_leve_jamais():
    with fake_provider(APIError("400", status=400)):
        reponse = await providall.atry_complete("salut")
    assert isinstance(reponse.error, ProvidallError)


# --------------------------------------------------------------- streaming


def test_stream_chat_completions():
    from providall.stream import Done, TextDelta

    def flux(_req, _body):
        return [
            {"choices": [{"delta": {"content": "bon"}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": "jour"}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 2}},
        ]

    with fake_provider(flux):
        evenements = list(providall.stream("salut"))

    assert [e.text for e in evenements if isinstance(e, TextDelta)] == ["bon", "jour"]
    final = evenements[-1]
    assert isinstance(final, Done)
    assert final.response.text == "bonjour"
    assert final.response.usage.input_tokens == 5
    assert final.response.cost_usd is not None


def test_stream_avec_appel_d_outil():
    from providall.stream import ToolCallDelta

    def flux(_req, _body):
        return [
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "t1",
                                    "function": {"name": "m", "arguments": "{}"},
                                }
                            ]
                        },
                        "finish_reason": "tool_calls",
                    }
                ]
            }
        ]

    with fake_provider(flux):
        evenements = list(providall.stream("salut"))
    assert any(isinstance(e, ToolCallDelta) for e in evenements)


def test_stream_relance_avant_le_premier_octet():

    def flux(_req, _body):
        return [{"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]}]

    with fake_provider(ServerError("503", status=503), flux) as faux:
        textes = [e for e in providall.stream("salut")]
    assert faux.calls == 2
    assert textes[-1].response.text == "ok"  # type: ignore[union-attr]


def test_outil_sur_provider_sans_outils():
    from providall.registry import register_provider
    from providall.types import Caps, ProviderSpec, Wire

    register_provider(
        ProviderSpec(
            name="sansoutils",
            protocol="openai_compat",
            base_url="http://x/v1",
            api_key_env="LLM_API_KEY",
            aliases=(),
            default_model="m",
            key_url="",
            requires_key=False,
            caps=Caps(False, "prompt", False, "none", False, True, True, True),
            wire=Wire("max_tokens", None, ()),
            max_tokens=1000,
            effort=None,
            note="",
        ),
        replace=True,
    )
    with pytest.raises(CapabilityError, match="outils"):
        providall.complete("a", model="sansoutils:m", tools=[{"name": "x", "parameters": {}}])


def test_extra_body_du_client_remplace_par_celui_de_l_appel():
    env = {"ANTHROPIC_API_KEY": "sk-x"}
    client = Client("sonnet", extra_body={"a": 1}, env=env)
    assert client.prepare("salut").extra == {"a": 1}
    assert client.prepare("salut", extra_body={"b": 2}).extra == {"b": 2}
    assert client.with_options(max_tokens=10).prepare("salut").extra == {"a": 1}
    assert Client("sonnet", env=env).prepare("salut").extra == {}
