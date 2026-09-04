"""Adaptateur Chat Completions : une particularité de fournisseur par test."""

from __future__ import annotations

import pytest

from providall.errors import EmptyResponseError
from providall.providers.base import Request, ToolDef
from providall.providers.openai_compat import (
    ADAPTER,
    ChunkAccumulator,
    ensure_json_hint,
    parse_tool_calls,
    to_native_messages,
)
from providall.registry import resolve_spec
from providall.testing import chat_reply, tool_call
from providall.types import Message, ToolCall

SCHEMA = {"type": "object", "properties": {"x": {"type": "string"}}, "additionalProperties": False}
OUTIL = ToolDef(name="meteo", description="Prévisions", parameters={"type": "object"})


def req(alias: str = "ds-flash", **kw) -> Request:
    kw.setdefault("messages", [Message(role="user", content="salut")])
    kw.setdefault("max_tokens", 1000)
    return Request(spec=resolve_spec(alias), **kw)


# ------------------------------------------------------------------- build


def test_forme_de_base():
    corps = ADAPTER.build(req(system="Système."))
    assert corps["model"] == "deepseek-v4-flash"
    assert corps["max_tokens"] == 1000
    assert corps["messages"][0] == {"role": "system", "content": "Système."}


def test_max_completion_tokens_chez_openai():
    """Les modèles à raisonnement d'OpenAI répondent 400 sur `max_tokens`."""
    corps = ADAPTER.build(req("gpt-terra"))
    assert corps["max_completion_tokens"] == 1000
    assert "max_tokens" not in corps


def test_temperature_omise_chez_openai():
    assert "temperature" not in ADAPTER.build(req("gpt-terra", temperature=0))
    assert ADAPTER.build(req("ds-flash", temperature=0))["temperature"] == 0


def test_reasoning_effort_chez_openai():
    assert ADAPTER.build(req("gpt-terra", effort="high"))["reasoning_effort"] == "high"
    # `xhigh` n'existe pas chez OpenAI : ramené, pas rejeté.
    assert ADAPTER.build(req("gpt-terra", effort="max"))["reasoning_effort"] == "high"


def test_extra_body_reserve_a_openrouter():
    corps = ADAPTER.build(req("or-glm"))
    assert corps["extra_body"] == {"reasoning": {"effort": "medium"}}
    assert "extra_body" not in ADAPTER.build(req("gpt-terra", effort="high"))
    assert "extra_body" not in ADAPTER.build(req("ds-flash", effort="high"))


def test_effort_ignore_quand_le_provider_ne_le_gere_pas():
    corps = ADAPTER.build(req("ds-flash", effort="high"))
    assert "reasoning_effort" not in corps


# ---- response_format tri-état -------------------------------------------


def test_json_schema_strict():
    corps = ADAPTER.build(req("gpt-terra", json_schema=SCHEMA))
    assert corps["response_format"]["type"] == "json_schema"
    assert corps["response_format"]["json_schema"]["strict"] is True
    assert corps["response_format"]["json_schema"]["schema"] == SCHEMA


def test_json_object_et_indice_json():
    """DeepSeek exige le mot « json » dans le prompt, sinon il refuse."""
    corps = ADAPTER.build(req("ds-flash", json_schema=SCHEMA))
    assert corps["response_format"] == {"type": "json_object"}
    assert "json" in str(corps["messages"]).lower()


def test_prompt_seul_chez_openrouter():
    """`response_format` est transmis tel quel au modèle routé, qui répond 400."""
    corps = ADAPTER.build(req("openrouter:un/modele", json_schema=SCHEMA))
    assert "response_format" not in corps
    assert "schéma" in corps["messages"][0]["content"]


def test_schema_toujours_dans_le_system():
    """`json_object` garantit du JSON valide, pas conforme : le schéma part aussi."""
    for alias in ("gpt-terra", "ds-flash", "openrouter:x/y"):
        corps = ADAPTER.build(req(alias, json_schema=SCHEMA))
        assert '"x"' in corps["messages"][0]["content"], alias


def test_outils_et_tool_choice():
    corps = ADAPTER.build(req(tools=[OUTIL], tool_choice="required"))
    assert corps["tools"][0]["function"]["name"] == "meteo"
    assert corps["tool_choice"] == "required"


def test_stream_demande_l_usage():
    corps = ADAPTER.build(req(stream=True))
    assert corps["stream"] is True
    assert corps["stream_options"] == {"include_usage": True}


# ---- traduction des messages --------------------------------------------


def test_assistant_sans_texte_a_un_content_vide_pas_null():
    """Mistral rejette `content: null`."""
    messages = [
        Message(
            role="assistant",
            content=None,
            tool_calls=[ToolCall(id="c1", name="meteo", arguments="{}")],
        )
    ]
    natif = to_native_messages(messages, None)[0]
    assert natif["content"] == ""
    assert natif["tool_calls"][0]["function"]["name"] == "meteo"


def test_message_tool():
    natif = to_native_messages(
        [Message(role="tool", tool_call_id="c1", name="meteo", content="15°C")], None
    )[0]
    assert natif == {"role": "tool", "tool_call_id": "c1", "content": "15°C", "name": "meteo"}


def test_images_en_data_uri():
    messages = [
        Message(
            role="user",
            content=[
                {"type": "text", "text": "décris"},
                {"type": "image_base64", "media_type": "image/png", "data": "AAAA"},
            ],
        )
    ]
    parties = to_native_messages(messages, None)[0]["content"]
    assert parties[1]["image_url"]["url"] == "data:image/png;base64,AAAA"


def test_ensure_json_hint_n_ajoute_rien_si_deja_present():
    messages = [{"role": "system", "content": "rends du JSON"}]
    assert ensure_json_hint(messages) is messages


def test_ensure_json_hint_cree_un_system_si_besoin():
    sortie = ensure_json_hint([{"role": "user", "content": "salut"}])
    assert sortie[0]["role"] == "system"


# ------------------------------------------------------------------- parse


def test_parse_texte_usage_et_cache():
    reponse = ADAPTER.parse(
        chat_reply("bonjour", prompt_tokens=100, completion_tokens=20, cached_tokens=40),
        req(),
    )
    assert reponse.text == "bonjour"
    # `prompt_tokens` inclut le cache ici : on le retire pour que
    # `input_tokens` veuille dire la même chose que chez Anthropic.
    assert reponse.usage.input_tokens == 60
    assert reponse.usage.cache_read_tokens == 40


def test_parse_reasoning_content():
    reponse = ADAPTER.parse(chat_reply("r", reasoning_content="je pense"), req())
    assert reponse.reasoning == "je pense"


def test_parse_reasoning_tokens():
    reponse = ADAPTER.parse(chat_reply("r", reasoning_tokens=800), req())
    assert reponse.usage.reasoning_tokens == 800


def test_ids_d_outils_fabriques():
    """Certains serveurs compatibles omettent l'id : sans lui, la réponse
    `tool` ne peut pas être rattachée."""
    appels = parse_tool_calls([{"function": {"name": "a", "arguments": "{}"}}])
    assert appels[0].id == "call_0"


def test_arguments_d_outil_non_stringifies():
    appels = parse_tool_calls([{"id": "x", "function": {"name": "a", "arguments": {"v": 1}}}])
    assert appels[0].parsed() == {"v": 1}


def test_vide_par_length_n_est_pas_rejouable():
    with pytest.raises(EmptyResponseError) as exc:
        ADAPTER.parse(chat_reply("", finish_reason="length", completion_tokens=8000), req())
    assert exc.value.retryable is False
    assert "budget de sortie épuisé" in str(exc.value)
    assert "8000 jetons de sortie facturés" in str(exc.value)


def test_vide_par_filtre_n_est_pas_rejouable():
    with pytest.raises(EmptyResponseError) as exc:
        ADAPTER.parse(chat_reply("", finish_reason="content_filter"), req())
    assert exc.value.retryable is False


def test_vide_inexplique_est_rejouable():
    with pytest.raises(EmptyResponseError) as exc:
        ADAPTER.parse(chat_reply("", finish_reason="stop"), req())
    assert exc.value.retryable is True


def test_appel_d_outil_sans_texte_n_est_pas_vide():
    brut = chat_reply("", finish_reason="tool_calls", tool_calls=[tool_call("meteo", {})])
    reponse = ADAPTER.parse(brut, req())
    assert reponse.finish_reason == "tool_calls"
    assert reponse.tool_calls[0].name == "meteo"


# --------------------------------------------------------------- streaming


def _chunk(**delta):
    return {"choices": [{"delta": delta, "finish_reason": None}]}


def test_accumulateur_de_flux():
    acc = ChunkAccumulator()
    acc.feed(_chunk(content="bon"))
    acc.feed(_chunk(content="jour"))
    acc.feed(
        _chunk(
            tool_calls=[{"index": 0, "id": "t1", "function": {"name": "meteo", "arguments": '{"v'}}]
        )
    )
    acc.feed(_chunk(tool_calls=[{"index": 0, "function": {"arguments": 'ille": "Lyon"}'}}]))
    acc.feed(
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 7}}
    )

    resultat = acc.result()
    assert resultat["choices"][0]["message"]["content"] == "bonjour"
    appel = resultat["choices"][0]["message"]["tool_calls"][0]
    assert appel["function"]["arguments"] == '{"ville": "Lyon"}'
    assert resultat["choices"][0]["finish_reason"] == "tool_calls"

    # Le flux repasse par le MÊME `parse()` que le non-flux.
    reponse = ADAPTER.parse(resultat, req())
    assert reponse.tool_calls[0].parsed() == {"ville": "Lyon"}
    assert reponse.usage.input_tokens == 7


def test_accumulateur_rend_des_deltas():
    from providall.stream import TextDelta

    acc = ChunkAccumulator()
    evenements = acc.feed(_chunk(content="a"))
    assert evenements == [TextDelta("a")]
