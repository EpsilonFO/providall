"""CLI `providall` : `models`, `check`, `ask`.

Même sortie que la commande TypeScript, à la ligne près : c'est le test le plus
simple qu'un seul registre sert bien les deux packages.
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from . import __version__
from .client import Client
from .config import base_url_for, env_defaults, resolve
from .env import env_bool, loaded_files
from .errors import ProvidallError
from .pricing import format_cost
from .registry import PROVIDERS, list_models
from .types import ModelSpec


def models_table(*, only_available: bool = False) -> str:
    """Port de `table_registre()` (monumia), colonnes comprises."""
    lignes: list[str] = []
    try:
        resolution = resolve()
        lignes.append(
            f"modèle par défaut : {resolution.spec.alias} "
            f"({resolution.spec.model_id})  ← {resolution.source}"
        )
    except ProvidallError as exc:
        lignes.append(f"modèle par défaut : aucun — {str(exc).splitlines()[0]}")
    lignes.append("")

    entete = (
        f"{'alias':<15} {'provider':<14} {'identifiant':<24} {'$/Mtok in/out':>15} "
        f"{'clé':<5} {'id vérifié':<11} note"
    )
    lignes += [entete, "-" * 130]
    for spec in list_models(only_available=only_available):
        tarif = (
            f"{spec.price_in:>7.2f}/{spec.price_out:<7.2f}"
            if spec.price_known
            else f"{'?':>7}/{'?':<7}"
        )
        lignes.append(
            f"{spec.alias:<15} {spec.provider:<14} {spec.model_id:<24} {tarif} "
            f"{'oui' if spec.key_present else 'NON':<5} "
            f"{'oui' if spec.id_verified else 'À VÉRIFIER':<11} {spec.note}"
        )

    lignes += [
        "",
        "Une clé par provider :",
        "  " + "   ".join(f"{n}={p.api_key_env}" for n, p in PROVIDERS.items() if p.requires_key),
        "",
        "Changer de modèle : LLM_MODEL=<alias> dans .env, ou",
        "LLM_MODEL=<provider>:<identifiant> pour un modèle hors registre",
        "(ex. LLM_MODEL=zai:glm-5.4-flash, ou LLM_MODEL=openrouter:z-ai/glm-4.6).",
    ]
    return "\n".join(lignes)


def check_report(model: str | None = None) -> tuple[str, bool]:
    """État de la configuration. Deuxième membre : tout va bien ?"""
    lignes: list[str] = []
    fichiers = loaded_files()
    lignes.append(
        ".env chargés : " + (", ".join(str(f) for f in fichiers) if fichiers else "aucun")
    )

    defauts = env_defaults()
    lignes.append(
        f"réglages : LLM_MAX_TOKENS={defauts.max_tokens or '(défaut du modèle)'} "
        f"LLM_EFFORT={defauts.effort or '(défaut du modèle)'} "
        f"LLM_TIMEOUT={defauts.timeout or 600}s "
        f"LLM_RETRIES={defauts.retries if defauts.retries is not None else 2}"
    )
    lignes.append("")

    lignes.append(f"{'provider':<16} {'clé':<5} {'variable':<22} base url")
    lignes.append("-" * 90)
    for nom, p in PROVIDERS.items():
        presente = "oui" if not p.requires_key else ("oui" if _cle_posee(p.api_key_env) else "NON")
        lignes.append(f"{nom:<16} {presente:<5} {p.api_key_env:<22} {p.base_url or '(à poser)'}")
    lignes.append("")

    try:
        resolution = resolve(model)
        spec = resolution.spec
        url, source_url = base_url_for(spec)
        lignes.append(f"modèle actif : {spec.alias} → {spec.model_id}  ← {resolution.source}")
        lignes.append(f"  provider {spec.provider} · {url} ({source_url})")
        lignes.append(f"  caps : {_caps(spec)}")
        if not spec.key_present:
            lignes.append(f"  ⚠️  {spec.api_key_env} absente — {spec.key_url}")
            return "\n".join(lignes), False
        return "\n".join(lignes), True
    except ProvidallError as exc:
        lignes.append(f"⚠️  {exc}")
        return "\n".join(lignes), False


def _caps(spec: ModelSpec) -> str:
    c = spec.caps
    # `true`/`false` en minuscules, pas le `True` de Python : les deux CLI
    # doivent rendre la même ligne, et c'est aussi la forme du JSON du registre.
    b = {True: "true", False: "false"}
    return (
        f"tools={b[c.tools]} structured={c.structured} effort={b[c.effort]} "
        f"thinking={c.thinking} vision={b[c.vision]} temperature={b[c.temperature]}"
    )


def _cle_posee(nom: str) -> bool:
    from .env import env_str

    return bool(env_str(nom))


def _ping(model: str | None) -> int:
    client = Client(model, label="check")
    reponse = client.try_complete("Réponds uniquement : OK", max_tokens=16)
    if reponse.error is not None:
        print(f"ping : ÉCHEC — {reponse.error}", file=sys.stderr)
        return 1
    print(
        f"ping : OK — {reponse.text.strip()[:40]!r} en {reponse.latency_s:.1f}s, "
        f"in={reponse.usage.input_tokens} out={reponse.usage.output_tokens} "
        f"{format_cost(reponse.cost_usd)}"
    )
    return 0


def _ask(args: argparse.Namespace) -> int:
    client = Client(args.model, label="ask")
    options: dict[str, Any] = {
        "system": args.system,
        "effort": args.effort,
        "max_tokens": args.max_tokens,
    }
    options = {k: v for k, v in options.items() if v is not None}

    try:
        if args.stream:
            from .stream import Done, TextDelta

            finale = None
            for evenement in client.stream(args.prompt, **options):
                if isinstance(evenement, TextDelta):
                    sys.stdout.write(evenement.text)
                    sys.stdout.flush()
                elif isinstance(evenement, Done):
                    finale = evenement.response
            print()
            reponse = finale
        elif args.json:
            reponse = client.complete(
                args.prompt,
                json_schema={"type": "object", "additionalProperties": True},
                **options,
            )
            print(reponse.text)
        else:
            reponse = client.complete(args.prompt, **options)
            print(reponse.text)
    except ProvidallError as exc:
        print(f"échec : {exc}", file=sys.stderr)
        return 1

    if reponse is not None:
        # Métriques sur stderr : `providall ask … > sortie.txt` ne doit
        # contenir que la réponse.
        print(
            f"[{reponse.provider}:{reponse.model_id}] {reponse.latency_s:.1f}s "
            f"in={reponse.usage.input_tokens} out={reponse.usage.output_tokens} "
            f"{format_cost(reponse.cost_usd)} finish={reponse.finish_reason} "
            f"attempts={reponse.attempts}",
            file=sys.stderr,
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="providall", description="Appel LLM multi-provider : registre, contrôle, essai."
    )
    parser.add_argument("--version", action="version", version=f"providall {__version__}")
    sous = parser.add_subparsers(dest="command", required=True)

    p_models = sous.add_parser("models", help="table du registre")
    p_models.add_argument(
        "--available", action="store_true", help="uniquement les modèles dont la clé est posée"
    )

    p_check = sous.add_parser("check", help="clés, URLs et modèle actif")
    p_check.add_argument("--model", help="vérifier ce modèle plutôt que le défaut")
    p_check.add_argument("--ping", action="store_true", help="envoie un appel réel minimal")

    p_ask = sous.add_parser("ask", help="un appel, la réponse sur stdout")
    p_ask.add_argument("prompt")
    p_ask.add_argument("--model")
    p_ask.add_argument("--system", "-s")
    p_ask.add_argument("--json", action="store_true", help="force une réponse JSON")
    p_ask.add_argument("--effort", "-e")
    p_ask.add_argument("--max-tokens", type=int, dest="max_tokens")
    p_ask.add_argument("--stream", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if env_bool("LLM_DEBUG"):
        import logging

        logging.basicConfig(level=logging.DEBUG, format="%(message)s")

    if args.command == "models":
        print(models_table(only_available=args.available))
        return 0
    if args.command == "check":
        rapport, ok = check_report(args.model)
        print(rapport)
        if args.ping:
            return _ping(args.model) if ok else 1
        return 0 if ok else 1
    return _ask(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
