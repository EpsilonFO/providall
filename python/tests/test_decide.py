"""Famille System One : decide(), résolution par famille, deux portes (TypeSafe, OpenRouter)."""

from __future__ import annotations

import json
from typing import Any

import httpx2
import pytest

import providall
from providall import ChoiceAnswer, Decision, NoulAnswer, ScoreAnswer, choice, noul, score
from providall.config import api_key_for, base_url_for, resolve, resolve_decision
from providall.decide import prepare_decision
from providall.errors import (
    AuthError,
    BadRequestError,
    CapabilityError,
    ConfigError,
    EmptyResponseError,
    MissingKeyError,
    ServerError,
    UnknownModelError,
)
from providall.hooks import on_decision
from providall.pricing import format_cost
from providall.providers.base import api_message
from providall.providers.systemone import system_one_url
from providall.registry import MODELS, PROVIDERS, resolve_spec
from providall.testing import chat_reply, decision_reply, fake_provider

TS = {"TYPESAFE_API_KEY": "ts-test"}
OR = {"OPENROUTER_API_KEY": "or-test"}

QUESTIONS = {
    "urgent": noul("Le message exprime-t-il de l'urgence ?"),
    "service": choice(
        "Quelle équipe doit traiter ?",
        {
            "facturation": "Paiements, factures, remboursements",
            "technique": "Bugs, pannes, intégrations",
        },
    ),
    "colere": score("Agacement du client ?", ["Calme", "Agacé", "Furieux"]),
}

REPONSES: dict[str, dict[str, Any]] = {
    "urgent": {"type": "noul", "noul": 0.95},
    "service": {
        "type": "choice",
        "choice": "facturation",
        "probabilities": {"facturation": 0.88, "technique": 0.12},
        "confidence": 0.81,
    },
    "colere": {
        "type": "score",
        "score": 1.05,
        "legend": {"0": "Calme", "1": "Agacé", "2": "Furieux"},
        "probabilities": {"0": 0.0, "1": 0.95, "2": 0.05},
        "confidence": 0.92,
    },
}


@pytest.fixture
def typesafe_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TYPESAFE_API_KEY", "ts-test")


@pytest.fixture
def openrouter_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-test")


def _transport(monkeypatch: pytest.MonkeyPatch, *reponses: httpx2.Response) -> list[httpx2.Request]:
    """Vrai client `httpx2`, faux réseau : couvre `send()`, que `fake_provider` court-circuite."""
    vues: list[httpx2.Request] = []

    def repondre(requete: httpx2.Request) -> httpx2.Response:
        vues.append(requete)
        return reponses[min(len(vues) - 1, len(reponses) - 1)]

    client = httpx2.Client(transport=httpx2.MockTransport(repondre))
    monkeypatch.setattr("providall.providers.systemone.sdk_client", lambda *_a, **_k: client)
    return vues


# --------------------------------------------------------------------------
# Questions
# --------------------------------------------------------------------------


def test_les_trois_fabriques_produisent_le_format_du_fil():
    assert noul("Urgent ?") == {"type": "noul", "instructions": "Urgent ?"}
    assert noul("Urgent ?", true="pressé", false="rien")["criteria"] == {
        "true": "pressé",
        "false": "rien",
    }
    assert choice("Équipe ?", ["a", "b"])["criteria"] == {"a": None, "b": None}
    assert score("Note ?", ("bas", "haut")) == {
        "type": "score",
        "instructions": "Note ?",
        "criteria": ["bas", "haut"],
    }


@pytest.mark.parametrize(
    ("questions", "motif"),
    [
        ({}, "aucune question"),
        ({"q": {"type": "choice", "instructions": "?", "criteria": {}}}, "au moins une option"),
        ({"q": {"type": "score", "instructions": "?", "criteria": ["seul"]}}, "deux niveaux"),
        ({"q": {"type": "oui", "instructions": "?"}}, "inconnu"),
    ],
)
def test_questions_refusees_avant_l_envoi(questions, motif):
    with pytest.raises(ConfigError, match=motif):
        prepare_decision("x", questions, env=TS)


# --------------------------------------------------------------------------
# Appel nominal
# --------------------------------------------------------------------------


@pytest.mark.usefixtures("typesafe_key")
def test_appel_nominal_typesafe():
    with fake_provider(decision_reply(REPONSES, request_id="req_1")) as faux:
        d = providall.decide("Mes virements échouent depuis 3 jours.", QUESTIONS, model="jev")

    assert faux.bodies[0] == {
        "model": "jev-latest",
        "state": "Mes virements échouent depuis 3 jours.",
        "questions": QUESTIONS,
    }
    assert isinstance(d.answers["urgent"], NoulAnswer) and d.answers["urgent"].noul == 0.95
    service = d.answers["service"]
    assert isinstance(service, ChoiceAnswer)
    assert service.choice == "facturation" and service.confidence == 0.81
    colere = d.answers["colere"]
    assert isinstance(colere, ScoreAnswer) and colere.legend["1"] == "Agacé"
    assert d.ok and d.attempts == 1
    assert (d.model, d.model_id, d.served_model) == ("jev", "jev-latest", "jev-1.13.0")
    assert d.request_id == "req_1"
    assert "_request_id" not in d.raw


@pytest.mark.usefixtures("typesafe_key")
def test_cout_au_tarif_du_registre_sortie_gratuite():
    with fake_provider(decision_reply(REPONSES, input_tokens=1_000_000, output_tokens=1_000_000)):
        d = providall.decide("x", QUESTIONS, model="jev")
    assert d.cost_usd == pytest.approx(0.042)


@pytest.mark.usefixtures("typesafe_key")
def test_state_structure_et_extra_body():
    with fake_provider(decision_reply({"urgent": REPONSES["urgent"]})) as faux:
        providall.decide(
            {"ticket": "page blanche", "tier": "enterprise"},
            {"urgent": QUESTIONS["urgent"]},
            model="jev",
            extra_body={"trace": True},
        )
    assert faux.bodies[0]["state"] == {"ticket": "page blanche", "tier": "enterprise"}
    assert faux.bodies[0]["trace"] is True


@pytest.mark.usefixtures("typesafe_key")
def test_hooks_global_et_a_l_appel():
    vues: list[Decision] = []
    on_decision(vues.append)
    with fake_provider(decision_reply(REPONSES)):
        providall.decide("x", QUESTIONS, model="jev", on_decision=vues.append)
    assert len(vues) == 2 and vues[0].cost_usd is not None


@pytest.mark.usefixtures("typesafe_key")
async def test_adecide():
    with fake_provider(decision_reply(REPONSES)):
        d = await providall.adecide("x", QUESTIONS, model="jev")
    assert isinstance(d.answers["service"], ChoiceAnswer)


# --------------------------------------------------------------------------
# Transport réel (httpx2) et porte OpenRouter
# --------------------------------------------------------------------------


@pytest.mark.usefixtures("typesafe_key")
def test_transport_url_en_tetes_et_request_id(monkeypatch: pytest.MonkeyPatch):
    vues = _transport(
        monkeypatch,
        httpx2.Response(
            200,
            json={"model": "jev-1.13.0", "answers": REPONSES, "usage": {"input_tokens": 3}},
            headers={"x-typesafe-request-id": "req_9"},
        ),
    )
    d = providall.decide("x", QUESTIONS, model="jev")
    assert str(vues[0].url) == "https://api.typesafe.ai/v1/systemone"
    assert vues[0].headers["authorization"] == "Bearer ts-test"
    assert json.loads(vues[0].content)["model"] == "jev-latest"
    assert d.request_id == "req_9"


@pytest.mark.usefixtures("openrouter_key")
def test_porte_openrouter_cout_facture(monkeypatch: pytest.MonkeyPatch):
    vues = _transport(
        monkeypatch,
        httpx2.Response(
            200,
            json={
                "id": "gen-dec-1",
                "model": "typesafe/jev-1.13-20260917",
                "provider": "TypeSafe",
                "answers": REPONSES,
                "usage": {"input_tokens": 1_000_000, "output_tokens": 20, "cost": 0.00003},
            },
        ),
    )
    d = providall.decide("x", QUESTIONS, model="or-jev")
    assert str(vues[0].url) == "https://openrouter.ai/api/v1/systemone"
    assert vues[0].headers["authorization"] == "Bearer or-test"
    assert json.loads(vues[0].content)["model"] == "typesafe/jev-1.13"
    assert d.cost_usd == 0.00003  # facturé, pas 0.042 au tarif
    assert d.request_id == "gen-dec-1"
    assert d.served_model == "typesafe/jev-1.13-20260917"


def test_racine_nue_facon_sdk_typesafe(monkeypatch: pytest.MonkeyPatch):
    assert system_one_url("https://openrouter.ai/api") == "https://openrouter.ai/api/v1/systemone"
    assert (
        system_one_url("https://openrouter.ai/api/v1/") == "https://openrouter.ai/api/v1/systemone"
    )
    env = {"TYPESAFE_API_KEY": "sk-or", "TYPESAFE_BASE_URL": "https://openrouter.ai/api"}
    req = prepare_decision("x", QUESTIONS, model="jev", env=env)
    assert system_one_url(req.base_url) == "https://openrouter.ai/api/v1/systemone"


# --------------------------------------------------------------------------
# Erreurs et relances
# --------------------------------------------------------------------------


@pytest.mark.usefixtures("typesafe_key")
def test_529_se_rejoue(monkeypatch: pytest.MonkeyPatch):
    vues = _transport(
        monkeypatch,
        httpx2.Response(529, json={"error": {"message": "overloaded"}}),
        httpx2.Response(200, json={"model": "jev-1.13.0", "answers": REPONSES, "usage": {}}),
    )
    d = providall.decide("x", QUESTIONS, model="jev")
    assert d.attempts == 2 and len(vues) == 2


@pytest.mark.usefixtures("typesafe_key")
def test_422_nomme_le_champ_et_ne_se_rejoue_pas(monkeypatch: pytest.MonkeyPatch):
    corps = {
        "detail": [{"loc": ["body", "questions", "colere", "criteria"], "msg": "too many levels"}]
    }
    vues = _transport(monkeypatch, httpx2.Response(422, json=corps))
    with pytest.raises(BadRequestError, match="body.questions.colere.criteria : too many levels"):
        providall.decide("x", QUESTIONS, model="jev")
    assert len(vues) == 1


@pytest.mark.usefixtures("typesafe_key")
def test_reponse_manquante_vide_et_rejouable():
    partielle = decision_reply({"urgent": REPONSES["urgent"]})
    with fake_provider(partielle, decision_reply(REPONSES)) as faux:
        d = providall.decide("x", QUESTIONS, model="jev")
    assert d.attempts == 2 and faux.calls == 2

    with fake_provider(partielle), pytest.raises(EmptyResponseError, match="service.*colere"):
        providall.decide("x", QUESTIONS, model="jev", retry=providall.RetryPolicy(retries=0))


@pytest.mark.usefixtures("typesafe_key")
def test_try_decide_ne_leve_jamais():
    from providall.providers.base import from_status

    with fake_provider(from_status(401, "bad key", provider="typesafe", model="jev")):
        d = providall.try_decide("x", QUESTIONS, model="jev")
    assert not d.ok and isinstance(d.error, AuthError) and d.answers == {}

    d = providall.try_decide("x", {}, model="jev")  # erreur AVANT l'envoi
    assert isinstance(d.error, ConfigError)


@pytest.mark.usefixtures("typesafe_key")
async def test_atry_decide():
    with fake_provider(ServerError("panne", provider="typesafe", model="jev")):
        d = await providall.atry_decide("x", QUESTIONS, model="jev")
    assert isinstance(d.error, ServerError) and d.attempts == 3


def test_cle_absente_nommee_avec_son_url():
    with pytest.raises(MissingKeyError, match=r"TYPESAFE_API_KEY.*console\.typesafe\.ai"):
        prepare_decision("x", QUESTIONS, model="jev", env={})


# --------------------------------------------------------------------------
# Familles séparées
# --------------------------------------------------------------------------


def test_complete_refuse_un_modele_system_one_avant_meme_la_cle():
    with pytest.raises(CapabilityError, match=r"decide\(\)"):
        providall.complete("salut", model="jev")


def test_decide_refuse_un_modele_de_chat():
    env = {**TS, "ANTHROPIC_API_KEY": "sk-an"}
    with pytest.raises(CapabilityError, match="LLM_MODEL_DECIDE"):
        prepare_decision("x", QUESTIONS, model="sonnet", env=env)


def test_cle_typesafe_seule():
    assert resolve_decision(env=TS).spec.model_id == "jev-latest"
    with pytest.raises(UnknownModelError):
        resolve(env=TS)


def test_cle_openrouter_seule_vaut_pour_les_deux_familles():
    assert resolve(env=OR).spec.provider == "openrouter"
    r = resolve_decision(env=OR)
    assert r.spec.provider == "openrouter_systemone"
    assert r.spec.model_id == "typesafe/jev-1.13"
    assert "OPENROUTER_API_KEY" in r.source


def test_une_cle_typesafe_ne_casse_pas_le_defaut_du_chat():
    env = {**TS, "DEEPSEEK_API_KEY": "sk-ds"}
    assert resolve(env=env).spec.provider == "deepseek"
    assert resolve_decision(env=env).spec.provider == "typesafe"


def test_deux_cles_system_one_il_faut_trancher():
    with pytest.raises(ConfigError, match="(?s)plusieurs clés System One.*LLM_MODEL_DECIDE"):
        resolve_decision(env={**TS, **OR})


def test_aucune_l_erreur_dit_quoi_poser():
    with pytest.raises(
        ConfigError,
        match="(?s)LLM_MODEL_DECIDE.*jev.*or-jev.*TYPESAFE_API_KEY ou OPENROUTER_API_KEY",
    ):
        resolve_decision(env={})


def test_ordre_de_resolution():
    env = {**TS, **OR, "LLM_MODEL_DECIDE": "or-jev", "LLM_MODEL_TRIAGE": "jev-1.13"}
    assert resolve_decision("jev", env=env).spec.alias == "jev"
    assert resolve_decision(role="triage", env=env).spec.alias == "jev-1.13"
    assert resolve_decision(env=env).spec.alias == "or-jev"
    assert resolve_decision(env={**TS, "LLM_MODEL": "jev-1.13"}).source == "LLM_MODEL"


def test_llm_model_de_chat_saute_pas_refuse():
    assert resolve_decision(env={**TS, "LLM_MODEL": "sonnet"}).spec.provider == "typesafe"
    assert resolve_decision(env={**TS, "LLM_MODEL": "faute"}).spec.alias == "typesafe:jev-latest"


def test_les_replis_generiques_ne_fuient_pas_vers_system_one():
    env = {"LLM_API_KEY": "cle-du-serveur-local", "LLM_BASE_URL": "http://localhost:8000/v1"}
    jev = resolve_spec("jev")
    assert api_key_for(jev, env) == ""
    assert base_url_for(jev, env)[0] == "https://api.typesafe.ai/v1"
    # Le chat, lui, garde ses replis.
    assert api_key_for(resolve_spec("compat:x"), env) == "cle-du-serveur-local"


def test_le_chat_n_a_pas_bouge(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk")
    monkeypatch.setenv("TYPESAFE_API_KEY", "ts")
    with fake_provider(chat_reply("bonjour")):
        r = providall.complete("salut")
    assert r.text == "bonjour" and r.provider == "deepseek"


# --------------------------------------------------------------------------
# Registre et affichage
# --------------------------------------------------------------------------


def test_registre_deux_fournisseurs_un_protocole_trois_modeles():
    assert PROVIDERS["typesafe"].protocol == "systemone"
    assert PROVIDERS["openrouter_systemone"].api_key_env == "OPENROUTER_API_KEY"
    for alias in ("jev", "jev-1.13", "or-jev"):
        m = MODELS[alias]
        assert m.price_out == 0 and m.price_known and not m.caps.stream


def test_echappatoire_provider_model_id():
    s = resolve_spec("typesafe:jev-preview")
    assert s.protocol == "systemone" and s.model_id == "jev-preview"


def test_un_cout_de_decision_ne_s_affiche_pas_zero():
    assert format_cost(0.0000124) == "$0.000012"
    assert format_cost(0.00412) == "$0.0041"
    assert format_cost(0) == "$0.0000"


def test_422_chaque_champ_fautif():
    corps = {
        "detail": [
            {"loc": ["body", "state"], "msg": "Field required"},
            {"loc": ["body", "model"], "msg": "unknown model"},
        ]
    }
    assert api_message(corps) == "body.state : Field required ; body.model : unknown model"
