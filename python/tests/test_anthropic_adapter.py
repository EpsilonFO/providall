"""Adaptateur Anthropic : `build()` et `parse()`, sans réseau."""

from __future__ import annotations

import pytest

from providall.errors import EmptyResponseError, RefusalError
from providall.providers.anthropic import ADAPTER, to_native_messages
from providall.providers.base import Request, ToolDef
from providall.registry import resolve_spec
from providall.testing import anthropic_reply
from providall.types import Message, ToolCall

OUTIL = ToolDef(
    name="meteo",
    description="Prévisions",
    parameters={"type": "object", "properties": {"ville": {"type": "string"}}},
)


def req(alias: str = "sonnet", **kw) -> Request:
    kw.setdefault("messages", [Message(role="user", content="salut")])
    kw.setdefault("max_tokens", 1000)
    return Request(spec=resolve_spec(alias), **kw)


# ------------------------------------------------------------------- build


def test_forme_de_base():
    corps = ADAPTER.build(req(system="Tu es utile."))
    assert corps["model"] == "claude-sonnet-5"
    assert corps["max_tokens"] == 1000
    assert corps["system"] == "Tu es utile."
    assert corps["messages"] == [{"role": "user", "content": [{"type": "text", "text": "salut"}]}]


def test_thinking_adaptatif_jamais_budget():
    """`budget_tokens` répond 400 sur la famille 5 : seul `adaptive` est valide."""
    corps = ADAPTER.build(req("sonnet"))
    assert corps["thinking"] == {"type": "adaptive"}
    assert "budget_tokens" not in str(corps)


def test_thinking_budget_sur_haiku():
    corps = ADAPTER.build(req("haiku", effort="medium", max_tokens=16000))
    assert corps["thinking"] == {"type": "enabled", "budget_tokens": 6000}


def test_budget_de_raisonnement_plafonne_par_max_tokens():
    """L'API refuse un budget qui ne laisse pas de place à la réponse."""
    corps = ADAPTER.build(req("haiku", effort="max", max_tokens=8000))
    assert corps["thinking"]["budget_tokens"] == 8000 - 4096


def test_effort_omis_sur_haiku():
    """`effort` ERRORE sur Haiku 4.5 : il ne doit pas partir."""
    corps = ADAPTER.build(req("haiku", effort="high"))
    assert "output_config" not in corps


def test_effort_pose_sur_sonnet():
    corps = ADAPTER.build(req("sonnet", effort="xhigh"))
    assert corps["output_config"] == {"effort": "xhigh"}


def test_effort_ramene_a_l_echelle_du_modele():
    """Sonnet 4.6 n'a pas `xhigh` : on descend à `high` plutôt que de lever."""
    corps = ADAPTER.build(req("sonnet-4.6", effort="xhigh"))
    assert corps["output_config"]["effort"] == "high"


def test_temperature_omise_par_defaut():
    """La famille Claude 5 rejette toute température non par défaut (400)."""
    assert "temperature" not in ADAPTER.build(req("sonnet", temperature=0))
    assert ADAPTER.build(req("haiku", temperature=0))["temperature"] == 0


def test_sortie_structuree_par_output_config():
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    corps = ADAPTER.build(req("sonnet", json_schema=schema))
    assert corps["output_config"]["format"] == {"type": "json_schema", "schema": schema}
    # Le fournisseur contraint : inutile d'encombrer le système du schéma.
    assert "system" not in corps


def test_schema_dans_le_system_si_caps_prudentes():
    """z.ai en Anthropic-compat : `structured: prompt` → schéma dans le prompt."""
    schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    corps = ADAPTER.build(req("zai_anthropic:glm-5.3", json_schema=schema))
    assert "output_config" not in corps
    assert "schéma" in corps["system"] and '"x"' in corps["system"]


def test_outils_et_tool_choice():
    corps = ADAPTER.build(req(tools=[OUTIL], tool_choice="required"))
    assert corps["tools"][0]["input_schema"] == OUTIL.parameters
    assert corps["tool_choice"] == {"type": "any"}


def test_tool_choice_degrade_sur_fable():
    """Fable 5.1 répond 400 à `any` : auto + instruction, plutôt qu'un échec."""
    corps = ADAPTER.build(req("fable", tools=[OUTIL], tool_choice="required"))
    assert corps["tool_choice"] == {"type": "auto"}
    assert "meteo" in corps["system"]


def test_rejeu_verbatim_des_blocs_natifs():
    blocs = [
        {"type": "thinking", "thinking": "…", "signature": "sig"},
        {"type": "tool_use", "id": "t1", "name": "meteo", "input": {}},
    ]
    messages = [
        Message(role="user", content="q"),
        Message(role="assistant", content="", raw=("anthropic", blocs)),
        Message(role="tool", tool_call_id="t1", content="15°C"),
    ]
    natifs = to_native_messages(messages)
    assert natifs[1]["content"] == blocs  # signature préservée


def test_raw_d_un_autre_provider_est_ignore():
    messages = [
        Message(
            role="assistant",
            content="texte",
            tool_calls=[ToolCall(id="c1", name="meteo", arguments='{"ville": "Lyon"}')],
            raw=("openai", [{"quelque": "chose"}]),
        )
    ]
    blocs = to_native_messages(messages)[0]["content"]
    assert blocs[0] == {"type": "text", "text": "texte"}
    assert blocs[1] == {"type": "tool_use", "id": "c1", "name": "meteo", "input": {"ville": "Lyon"}}


def test_roles_alternes_et_tool_results_groupes():
    messages = [
        Message(role="user", content="a"),
        Message(role="user", content="b"),
        Message(role="tool", tool_call_id="t1", content="r1"),
        Message(role="tool", tool_call_id="t2", content="r2"),
    ]
    natifs = to_native_messages(messages)
    assert len(natifs) == 1
    assert [b["type"] for b in natifs[0]["content"]] == [
        "text",
        "text",
        "tool_result",
        "tool_result",
    ]


def test_images():
    messages = [
        Message(
            role="user",
            content=[
                {"type": "text", "text": "décris"},
                {"type": "image_url", "url": "https://x/y.png"},
                {"type": "image_base64", "media_type": "image/jpeg", "data": "AAAA"},
            ],
        )
    ]
    blocs = to_native_messages(messages)[0]["content"]
    assert blocs[1] == {"type": "image", "source": {"type": "url", "url": "https://x/y.png"}}
    assert blocs[2]["source"] == {"type": "base64", "media_type": "image/jpeg", "data": "AAAA"}


# ------------------------------------------------------------------- parse


def test_parse_texte_et_usage():
    reponse = ADAPTER.parse(
        anthropic_reply("bonjour", input_tokens=100, output_tokens=20, cache_read=50),
        req(),
    )
    assert reponse.text == "bonjour"
    assert reponse.finish_reason == "stop"
    assert reponse.usage.input_tokens == 100  # Anthropic exclut déjà le cache
    assert reponse.usage.cache_read_tokens == 50
    assert reponse.message and reponse.message.raw and reponse.message.raw[0] == "anthropic"


def test_parse_appels_d_outils():
    brut = anthropic_reply(
        "",
        stop_reason="tool_use",
        tool_uses=[{"id": "t1", "name": "meteo", "input": {"ville": "Lyon"}}],
    )
    reponse = ADAPTER.parse(brut, req())
    assert reponse.finish_reason == "tool_calls"
    assert reponse.tool_calls[0].name == "meteo"
    assert reponse.tool_calls[0].parsed() == {"ville": "Lyon"}


def test_parse_raisonnement():
    reponse = ADAPTER.parse(anthropic_reply("r", thinking="je réfléchis"), req())
    assert reponse.reasoning == "je réfléchis"


def test_refus():
    brut = anthropic_reply(
        "", stop_reason="refusal", stop_details={"category": "cyber", "explanation": "non"}
    )
    with pytest.raises(RefusalError) as exc:
        ADAPTER.parse(brut, req())
    assert exc.value.category == "cyber"
    assert exc.value.retryable is False


def test_vide_inexplique_est_rejouable():
    with pytest.raises(EmptyResponseError) as exc:
        ADAPTER.parse(anthropic_reply("", stop_reason="end_turn"), req())
    assert exc.value.retryable is True


def test_vide_par_troncature_ne_l_est_pas():
    with pytest.raises(EmptyResponseError) as exc:
        ADAPTER.parse(anthropic_reply("", stop_reason="max_tokens"), req())
    assert exc.value.retryable is False
    assert "augmenter max_tokens" in str(exc.value)
