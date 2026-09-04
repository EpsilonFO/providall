"""Une seule couche de retry, dans la lib.

Les SDK Anthropic et OpenAI retentent deux fois par défaut, en silence. Empilé
avec un retry applicatif, un timeout de dix minutes devient trente minutes sans
qu'aucun log ne le dise — c'est ce qui faisait passer un appel lent pour un
blocage chez monumia. Les deux SDK sont donc construits avec `max_retries=0`
(voir `providers/base.py`) et tout se passe ici, avec `Response.attempts` pour
rendre le compte visible.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from .errors import ProvidallError, RateLimitError

# Backoff linéaire, pas exponentiel : au-delà de deux tentatives on abandonne
# de toute façon, et 2 s puis 4 s suffisent à laisser passer un pic de charge.
BACKOFF_STEP_S = 2.0


@dataclass(frozen=True)
class RetryPolicy:
    retries: int = 2
    backoff_step_s: float = BACKOFF_STEP_S
    max_backoff_s: float = 30.0

    def delay(self, attempt: int, error: ProvidallError | None = None) -> float:
        """Délai avant la tentative `attempt` (1 = première relance).

        Un `Retry-After` du fournisseur prime : il sait mieux que nous.
        """
        if isinstance(error, RateLimitError) and error.retry_after is not None:
            return min(max(error.retry_after, 0.0), self.max_backoff_s)
        return min(self.backoff_step_s * attempt, self.max_backoff_s)


def run_with_retry[T](
    policy: RetryPolicy,
    attempt_fn: Callable[[int], T],
    *,
    on_retry: Callable[[int, ProvidallError, float], None] | None = None,
) -> tuple[T, int]:
    """Exécute `attempt_fn(n)` jusqu'à succès. Renvoie `(valeur, tentatives)`."""
    derniere: ProvidallError | None = None
    for n in range(policy.retries + 1):
        if n:
            pause = policy.delay(n, derniere)
            if on_retry and derniere:
                on_retry(n, derniere, pause)
            time.sleep(pause)
        try:
            return attempt_fn(n + 1), n + 1
        except ProvidallError as exc:
            exc.attempts = n + 1
            if not exc.retryable:
                raise
            derniere = exc
    assert derniere is not None
    raise derniere


async def arun_with_retry[T](
    policy: RetryPolicy,
    attempt_fn: Callable[[int], Awaitable[T]],
    *,
    on_retry: Callable[[int, ProvidallError, float], None] | None = None,
) -> tuple[T, int]:
    derniere: ProvidallError | None = None
    for n in range(policy.retries + 1):
        if n:
            pause = policy.delay(n, derniere)
            if on_retry and derniere:
                on_retry(n, derniere, pause)
            await asyncio.sleep(pause)
        try:
            return await attempt_fn(n + 1), n + 1
        except ProvidallError as exc:
            exc.attempts = n + 1
            if not exc.retryable:
                raise
            derniere = exc
    assert derniere is not None
    raise derniere


__all__ = ["BACKOFF_STEP_S", "RetryPolicy", "arun_with_retry", "run_with_retry"]
