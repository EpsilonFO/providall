"""Télémétrie : une ligne de log par appel, et un hook pour tout le reste.

Jamais de `print` dans la lib : une lib qui écrit sur stdout casse les scripts
qui redirigent leur sortie. Tout passe par le logger `providall`, silencieux
tant que l'application ne configure pas `logging`.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from .pricing import format_cost
from .types import Decision, Response

logger = logging.getLogger("providall")

ResponseHook = Callable[[Response], None]
_hooks: list[ResponseHook] = []

DecisionHook = Callable[[Decision], None]
_decision_hooks: list[DecisionHook] = []


def on_response(hook: ResponseHook) -> ResponseHook:
    """Enregistre un hook appelé après chaque appel, succès ou échec.

    Utilisable en décorateur. Sert à brancher un compteur de coût, une trace
    OpenTelemetry ou un fichier de mesures sans que la lib connaisse aucun des
    trois.
    """
    _hooks.append(hook)
    return hook


def on_decision(hook: DecisionHook) -> DecisionHook:
    """Pendant d'`on_response` pour `decide()` : appelé après chaque décision.

    Séparé plutôt que mêlé : un hook écrit pour `Response` lit `text` et
    `finish_reason`, qu'une `Decision` n'a pas.
    """
    _decision_hooks.append(hook)
    return hook


def clear_hooks() -> None:
    _hooks.clear()
    _decision_hooks.clear()


def emit(response: Response, *, label: str = "", extra: ResponseHook | None = None) -> None:
    logger.info("%s", log_line(response, label=label))
    for hook in (*_hooks, extra):
        if hook is None:
            continue
        try:
            hook(response)
        except Exception:  # noqa: BLE001 — un hook cassé ne doit pas casser l'appel
            logger.exception("hook on_response en échec")


def emit_decision(
    decision: Decision, *, label: str = "", extra: DecisionHook | None = None
) -> None:
    logger.info("%s", decision_log_line(decision, label=label))
    for hook in (*_decision_hooks, extra):
        if hook is None:
            continue
        try:
            hook(decision)
        except Exception:  # noqa: BLE001 — un hook cassé ne doit pas casser l'appel
            logger.exception("hook on_decision en échec")


def decision_log_line(decision: Decision, *, label: str = "") -> str:
    """`[label] provider:served_model 0.1s in=… out=… $0.000012 questions=3 attempts=1`"""
    morceaux = [
        f"[{label}]" if label else "",
        f"{decision.provider}:{decision.served_model or decision.model_id}",
        f"{decision.latency_s:.1f}s",
        f"in={decision.usage.input_tokens}",
        f"out={decision.usage.output_tokens}",
        format_cost(decision.cost_usd),
        f"questions={len(decision.answers)}",
    ]
    if decision.attempts > 1:
        morceaux.append(f"attempts={decision.attempts}")
    if decision.error is not None:
        morceaux.append(f"error={type(decision.error).__name__}")
    return " ".join(m for m in morceaux if m)


def log_line(response: Response, *, label: str = "") -> str:
    """`[label] provider:model 3.2s in=… out=… cache=… $0.0041 finish=stop attempts=1`"""
    u = response.usage
    morceaux = [
        f"[{label}]" if label else "",
        f"{response.provider}:{response.model_id}",
        f"{response.latency_s:.1f}s",
        f"in={u.input_tokens}",
        f"out={u.output_tokens}",
    ]
    if u.cache_read_tokens or u.cache_write_tokens:
        morceaux.append(f"cache={u.cache_read_tokens}/{u.cache_write_tokens}")
    if u.reasoning_tokens:
        morceaux.append(f"reasoning={u.reasoning_tokens}")
    morceaux.append(format_cost(response.cost_usd))
    morceaux.append(f"finish={response.finish_reason}")
    if response.attempts > 1:
        morceaux.append(f"attempts={response.attempts}")
    if response.error is not None:
        morceaux.append(f"error={type(response.error).__name__}")
    return " ".join(m for m in morceaux if m)


__all__ = [
    "DecisionHook",
    "ResponseHook",
    "clear_hooks",
    "decision_log_line",
    "emit",
    "emit_decision",
    "log_line",
    "logger",
    "on_decision",
    "on_response",
]
