"""Télémétrie : une ligne de log par appel, et un hook pour tout le reste.

Jamais de `print` dans la lib : une lib qui écrit sur stdout casse les scripts
qui redirigent leur sortie. Tout passe par le logger `providall`, silencieux
tant que l'application ne configure pas `logging`.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from .pricing import format_cost
from .types import Response

logger = logging.getLogger("providall")

ResponseHook = Callable[[Response], None]
_hooks: list[ResponseHook] = []


def on_response(hook: ResponseHook) -> ResponseHook:
    """Enregistre un hook appelé après chaque appel, succès ou échec.

    Utilisable en décorateur. Sert à brancher un compteur de coût, une trace
    OpenTelemetry ou un fichier de mesures sans que la lib connaisse aucun des
    trois.
    """
    _hooks.append(hook)
    return hook


def clear_hooks() -> None:
    _hooks.clear()


def emit(response: Response, *, label: str = "", extra: ResponseHook | None = None) -> None:
    logger.info("%s", log_line(response, label=label))
    for hook in (*_hooks, extra):
        if hook is None:
            continue
        try:
            hook(response)
        except Exception:  # noqa: BLE001 — un hook cassé ne doit pas casser l'appel
            logger.exception("hook on_response en échec")


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


__all__ = ["ResponseHook", "clear_hooks", "emit", "log_line", "logger", "on_response"]
