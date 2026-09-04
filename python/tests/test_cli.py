"""CLI : table du registre, contrôle de configuration, `ask`."""

from __future__ import annotations

import pytest

from providall.cli import build_parser, check_report, main, models_table
from providall.testing import chat_reply, fake_provider


def test_table_liste_tous_les_modeles():
    table = models_table()
    assert "sonnet" in table and "claude-sonnet-5" in table
    assert "ds-flash" in table
    assert "À VÉRIFIER" in table  # les ids tiers non confirmés sont signalés
    assert "LLM_MODEL=<provider>:<identifiant>" in table


def test_table_sans_modele_par_defaut():
    assert "aucun" in models_table()


def test_table_affiche_le_defaut_et_sa_source(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LLM_MODEL", "haiku")
    table = models_table()
    assert "modèle par défaut : haiku" in table
    assert "LLM_MODEL" in table.splitlines()[0]


def test_table_tarif_inconnu_affiche_un_point_d_interrogation():
    ligne = next(x for x in models_table().splitlines() if x.startswith("glm-flash"))
    assert "?" in ligne


def test_available_filtre_sur_la_cle(monkeypatch: pytest.MonkeyPatch):
    assert "sonnet" not in models_table(only_available=True)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-x")
    table = models_table(only_available=True)
    assert "sonnet" in table and "ds-flash" not in table


def test_check_sans_cle():
    rapport, ok = check_report()
    assert ok is False
    assert "anthropic" in rapport and "NON" in rapport


def test_check_avec_cle(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-x")
    rapport, ok = check_report()
    assert ok is True
    assert "claude-sonnet-5" in rapport
    assert "seule clé présente" in rapport
    assert "structured=json_schema" in rapport


def test_check_signale_la_cle_absente_du_modele_demande(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-x")
    rapport, ok = check_report("ds-flash")
    assert ok is False
    assert "DEEPSEEK_API_KEY absente" in rapport


def test_check_montre_la_source_de_l_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-x")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://proxy/v1")
    rapport, _ = check_report()
    assert "http://proxy/v1 (ANTHROPIC_BASE_URL)" in rapport


def test_code_de_sortie_de_check(capsys: pytest.CaptureFixture[str]):
    assert main(["check"]) == 1
    assert "NON" in capsys.readouterr().out


def test_ask(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-x")
    with fake_provider(chat_reply("bonjour")):
        assert main(["ask", "salut"]) == 0
    capture = capsys.readouterr()
    assert capture.out.strip() == "bonjour"
    # Les métriques vont sur stderr : `providall ask … > f` ne contient que la réponse.
    assert "deepseek:deepseek-v4-flash" in capture.err


def test_ask_en_echec(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-x")
    from providall.errors import AuthError

    with fake_provider(AuthError("clé refusée", status=401)):
        assert main(["ask", "salut"]) == 1
    assert "clé refusée" in capsys.readouterr().err


def test_ask_stream(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-x")

    def flux(_req, _body):
        return [
            {"choices": [{"delta": {"content": "bon"}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": "jour"}, "finish_reason": "stop"}]},
        ]

    with fake_provider(flux):
        assert main(["ask", "salut", "--stream"]) == 0
    assert capsys.readouterr().out.strip() == "bonjour"


def test_ask_json(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-x")
    with fake_provider(chat_reply('{"a": 1}')) as faux:
        assert main(["ask", "salut", "--json"]) == 0
    assert faux.bodies[0]["response_format"] == {"type": "json_object"}
    assert capsys.readouterr().out.strip() == '{"a": 1}'


def test_ask_transmet_les_options(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-x")
    from providall.testing import anthropic_reply

    with fake_provider(anthropic_reply("ok")) as faux:
        main(
            [
                "ask",
                "salut",
                "--model",
                "sonnet",
                "-s",
                "Système",
                "-e",
                "low",
                "--max-tokens",
                "99",
            ]
        )
    corps = faux.bodies[0]
    assert corps["system"] == "Système"
    assert corps["output_config"]["effort"] == "low"
    assert corps["max_tokens"] == 99


def test_parser_expose_les_trois_commandes():
    for commande in ("models", "check", "ask"):
        assert build_parser().parse_args([commande, *(["x"] if commande == "ask" else [])])
