"""Décorateur `@tool`, schéma dérivé de la signature, boucle d'agent."""

from __future__ import annotations

import pytest

import providall
from providall import tool
from providall.testing import anthropic_reply, chat_reply, fake_provider, tool_call
from providall.tools import as_tools, schema_from_signature


@pytest.fixture(autouse=True)
def _cles(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-ds")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-an")
    monkeypatch.setenv("LLM_MODEL", "ds-flash")


@tool
def meteo(ville: str, jours: int = 1) -> str:
    """Prévisions pour une ville."""
    return f"{jours}j à {ville} : soleil"


def test_schema_derive_de_la_signature():
    schema = meteo.definition.parameters
    assert schema["properties"]["ville"] == {"type": "string", "title": "Ville"}
    assert schema["required"] == ["ville"]  # `jours` a un défaut
    assert schema["additionalProperties"] is False
    assert meteo.definition.description == "Prévisions pour une ville."


def test_schema_ignore_args_et_kwargs():
    def f(a: int, *args, **kwargs) -> None: ...

    assert list(schema_from_signature(f)["properties"]) == ["a"]


def test_decorateur_avec_nom_explicite():
    @tool(name="autre", description="desc")
    def f(x: str) -> str:
        return x

    assert f.definition.name == "autre" and f.definition.description == "desc"


def test_as_tools_accepte_une_fonction_nue():
    def brut(x: str) -> str:
        """Docstring."""
        return x

    assert as_tools([brut])[0].name == "brut"


# ----------------------------------------------------------- boucle d'outils


def test_boucle_un_tour_puis_reponse():
    with fake_provider(
        chat_reply(
            "", finish_reason="tool_calls", tool_calls=[tool_call("meteo", {"ville": "Lyon"})]
        ),
        chat_reply("Il fera beau."),
    ) as faux:
        resultat = providall.tool_loop("météo à Lyon ?", tools=[meteo])

    assert resultat.text == "Il fera beau."
    assert resultat.turns == 2 and resultat.stopped == "done"
    assert resultat.calls[0].name == "meteo"
    # Le résultat de l'outil est bien reparti au modèle.
    dernier = faux.bodies[1]["messages"][-1]
    assert dernier["role"] == "tool" and "soleil" in dernier["content"]


def test_usage_et_cout_cumules():
    reponse_outil = chat_reply(
        "",
        finish_reason="tool_calls",
        tool_calls=[tool_call("meteo", {"ville": "L"})],
        prompt_tokens=100,
        completion_tokens=10,
    )
    with fake_provider(reponse_outil, chat_reply("fini", prompt_tokens=200, completion_tokens=20)):
        resultat = providall.tool_loop("q", tools=[meteo])
    assert resultat.usage.input_tokens == 300
    assert resultat.usage.output_tokens == 30
    assert resultat.cost_usd == pytest.approx((300 * 0.28 + 30 * 0.42) / 1e6)


def test_plafond_de_tours():
    boucle = chat_reply(
        "", finish_reason="tool_calls", tool_calls=[tool_call("meteo", {"ville": "L"})]
    )
    with fake_provider(boucle) as faux:
        resultat = providall.tool_loop("q", tools=[meteo], max_turns=3)
    assert resultat.stopped == "max_turns" and resultat.turns == 3
    assert faux.calls == 3


def test_erreur_de_handler_renvoyee_au_modele():
    """Le modèle sait souvent se corriger ; lever ferait perdre tout le tour."""

    @tool
    def casse(x: str) -> str:
        """Casse toujours."""
        raise ValueError("boum")

    with fake_provider(
        chat_reply("", finish_reason="tool_calls", tool_calls=[tool_call("casse", {"x": "a"})]),
        chat_reply("désolé"),
    ) as faux:
        resultat = providall.tool_loop("q", tools=[casse])

    assert resultat.stopped == "done"
    assert "ValueError: boum" in faux.bodies[1]["messages"][-1]["content"]


def test_outil_inconnu_est_signale_au_modele():
    with fake_provider(
        chat_reply("", finish_reason="tool_calls", tool_calls=[tool_call("fantome", {})]),
        chat_reply("ah"),
    ) as faux:
        providall.tool_loop("q", tools=[meteo])
    assert "outil inconnu" in faux.bodies[1]["messages"][-1]["content"]


def test_resultats_groupes_dans_un_seul_message_chez_anthropic():
    """Séparer les `tool_result` apprend au modèle à ne plus paralléliser."""
    with fake_provider(
        anthropic_reply(
            "",
            stop_reason="tool_use",
            tool_uses=[
                {"id": "t1", "name": "meteo", "input": {"ville": "Lyon"}},
                {"id": "t2", "name": "meteo", "input": {"ville": "Paris"}},
            ],
        ),
        anthropic_reply("voilà"),
    ) as faux:
        resultat = providall.tool_loop("q", tools=[meteo], model="sonnet")

    assert len(resultat.calls) == 2
    dernier = faux.bodies[1]["messages"][-1]
    assert dernier["role"] == "user"
    assert [b["type"] for b in dernier["content"]] == ["tool_result", "tool_result"]


def test_rejeu_raw_preserve_dans_la_boucle():
    with fake_provider(
        anthropic_reply(
            "",
            stop_reason="tool_use",
            thinking="je réfléchis",
            tool_uses=[{"id": "t1", "name": "meteo", "input": {"ville": "L"}}],
        ),
        anthropic_reply("voilà"),
    ) as faux:
        providall.tool_loop("q", tools=[meteo], model="sonnet")
    blocs = faux.bodies[1]["messages"][1]["content"]
    assert blocs[0]["type"] == "thinking"  # le bloc signé est renvoyé intact


async def test_boucle_async_execute_les_appels_en_parallele():
    with fake_provider(
        chat_reply(
            "",
            finish_reason="tool_calls",
            tool_calls=[
                tool_call("meteo", {"ville": "Lyon"}, id="a"),
                tool_call("meteo", {"ville": "Paris"}, id="b"),
            ],
        ),
        chat_reply("fini"),
    ):
        resultat = await providall.atool_loop("q", tools=[meteo])
    assert len(resultat.calls) == 2 and resultat.text == "fini"


async def test_handler_asynchrone():
    @tool
    async def lent(x: str) -> str:
        """Attend."""
        return f"vu {x}"

    with fake_provider(
        chat_reply("", finish_reason="tool_calls", tool_calls=[tool_call("lent", {"x": "a"})]),
        chat_reply("fini"),
    ) as faux:
        await providall.atool_loop("q", tools=[lent])
    assert faux.bodies[1]["messages"][-1]["content"] == "vu a"


def test_on_call():
    vus: list[tuple[str, str]] = []
    with fake_provider(
        chat_reply("", finish_reason="tool_calls", tool_calls=[tool_call("meteo", {"ville": "L"})]),
        chat_reply("fini"),
    ):
        providall.tool_loop(
            "q", tools=[meteo], on_call=lambda appel, res: vus.append((appel.name, res))
        )
    assert vus == [("meteo", "1j à L : soleil")]
