"""`decide()` — la famille System One.

    from providall import decide, noul, choice, score

    d = decide(
        "Mes virements échouent depuis 3 jours.",
        {
            "urgent": noul("Le message exprime-t-il de l'urgence ?"),
            "service": choice("Quelle équipe doit traiter ?", {
                "facturation": "Paiements, factures, remboursements",
                "technique": "Bugs, pannes, intégrations",
            }),
            "colere": score("Agacement du client ?", ["Calme", "Agacé", "Furieux"]),
        },
    )
    d.answers["service"].choice, d.answers["service"].confidence

Même plomberie que `complete()` — clé, retry, erreurs typées, coût, latence,
hooks, `fake_provider` — mais une autre résolution du modèle
(`LLM_MODEL_DECIDE`) et un autre retour : des probabilités, jamais de texte.
Passer de TypeSafe à OpenRouter, c'est changer `LLM_MODEL_DECIDE=jev` en
`or-jev`.
"""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from typing import Any

from . import hooks
from .config import (
    DECISION_MODEL_VAR,
    DEFAULT_RETRIES,
    DEFAULT_TIMEOUT_S,
    api_key_for,
    base_url_for,
    env_defaults,
    resolve_decision,
)
from .errors import CapabilityError, ConfigError, MissingKeyError, ProvidallError
from .pricing import compute_cost
from .providers import adapter_for
from .providers.base import map_exception
from .providers.systemone import DecisionRequest
from .registry import MODELS, is_system_one
from .retry import RetryPolicy, arun_with_retry, run_with_retry
from .types import Decision, DecisionState, Instructions

# --------------------------------------------------------------------------
# Questions
# --------------------------------------------------------------------------


def noul(
    instructions: Instructions,
    *,
    true: Instructions | None = None,
    false: Instructions | None = None,
) -> dict[str, Any]:
    """Oui/non. `true=` / `false=` disent ce que valent un oui et un non, si besoin."""
    question: dict[str, Any] = {"type": "noul", "instructions": instructions}
    criteres = {k: v for k, v in (("true", true), ("false", false)) if v is not None}
    if criteres:
        question["criteria"] = criteres
    return question


def choice(
    instructions: Instructions,
    options: Mapping[str, Instructions | None] | Sequence[str],
) -> dict[str, Any]:
    """Une option parmi plusieurs : en liste (`["a", "b"]`) ou décrites (`{"a": "…", "b": None}`)."""
    criteres = dict(options) if isinstance(options, Mapping) else dict.fromkeys(options)
    return {"type": "choice", "instructions": instructions, "criteria": criteres}


def score(instructions: Instructions, levels: Sequence[Instructions]) -> dict[str, Any]:
    """Position sur une échelle, du plus bas au plus haut niveau."""
    return {"type": "score", "instructions": instructions, "criteria": list(levels)}


def _check_questions(
    questions: Mapping[str, Mapping[str, Any]], *, provider: str, model: str
) -> None:
    """Refuse avant l'envoi ce qui ne peut pas être une question.

    Seules les règles de forme : les plafonds (255 options, 10 niveaux) sont
    ceux de TypeSafe aujourd'hui, et un 422 nommant le champ les dira mieux
    qu'une copie qui vieillirait ici.
    """
    if not questions:
        raise ConfigError("decide() sans aucune question", provider=provider, model=model)
    for cle, q in questions.items():
        type_ = q.get("type") if isinstance(q, Mapping) else None
        if type_ == "choice":
            options = q.get("criteria")
            if not isinstance(options, Mapping) or not options:
                raise ConfigError(
                    f"question {cle} : un choice demande au moins une option",
                    provider=provider,
                    model=model,
                )
        elif type_ == "score":
            niveaux = q.get("criteria")
            if not isinstance(niveaux, Sequence) or isinstance(niveaux, str) or len(niveaux) < 2:
                raise ConfigError(
                    f"question {cle} : un score demande au moins deux niveaux",
                    provider=provider,
                    model=model,
                )
        elif type_ != "noul":
            raise ConfigError(
                f"question {cle} : type {type_!r} inconnu — noul, choice ou score",
                provider=provider,
                model=model,
            )


# --------------------------------------------------------------------------
# Préparation
# --------------------------------------------------------------------------


def prepare_decision(
    state: DecisionState,
    questions: Mapping[str, Mapping[str, Any]],
    *,
    model: str | None = None,
    role: str | None = None,
    timeout: float | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    label: str | None = None,
    env: dict[str, str] | None = None,
    extra_body: dict[str, Any] | None = None,
) -> DecisionRequest:
    """Résout tout et vérifie tout, sans rien envoyer. Le pendant de `Client.prepare()`."""
    spec = resolve_decision(model, role=role, env=env).spec

    if not is_system_one(spec):
        modeles = ", ".join(sorted(a for a, m in MODELS.items() if is_system_one(m)))
        raise CapabilityError(
            "décisions System One",
            provider=spec.provider,
            model=spec.alias,
            hint=(
                f"decide() n'accepte que les modèles System One ({modeles}) : "
                f"poser {DECISION_MODEL_VAR} ou passer `model=`"
            ),
        )
    _check_questions(questions, provider=spec.provider, model=spec.alias)

    cle = api_key or api_key_for(spec, env)
    if not cle and spec.requires_key:
        raise MissingKeyError(spec.api_key_env, provider=spec.provider, key_url=spec.key_url)
    return DecisionRequest(
        spec=spec,
        state=state,
        questions=questions,
        timeout=timeout or env_defaults(env).timeout or DEFAULT_TIMEOUT_S,
        api_key=cle,
        base_url=base_url or base_url_for(spec, env)[0],
        label=label or spec.alias,
        extra=dict(extra_body or {}),
    )


def _policy(retry: RetryPolicy | None, env: dict[str, str] | None) -> RetryPolicy:
    if retry is not None:
        return retry
    depuis_env = env_defaults(env).retries
    return RetryPolicy(retries=depuis_env if depuis_env is not None else DEFAULT_RETRIES)


def _finish(
    decision: Decision,
    req: DecisionRequest,
    started: float,
    attempts: int,
    on_decision: hooks.DecisionHook | None,
) -> Decision:
    decision.latency_s = time.monotonic() - started
    decision.attempts = attempts
    # Le coût facturé, quand le fournisseur le rend, prime sur le tarif saisi.
    if decision.cost_usd is None:
        decision.cost_usd = compute_cost(req.spec, decision.usage)
    hooks.emit_decision(decision, label=req.label, extra=on_decision)
    return decision


def _journaliser(tentative: int, erreur: ProvidallError, pause: float) -> None:
    hooks.logger.warning("%s — relance %d dans %.0fs", erreur, tentative, pause)


# --------------------------------------------------------------------------
# decide
# --------------------------------------------------------------------------


def decide(
    state: DecisionState,
    questions: Mapping[str, Mapping[str, Any]],
    *,
    retry: RetryPolicy | None = None,
    on_decision: hooks.DecisionHook | None = None,
    **kw: Any,
) -> Decision:
    """Un aller-retour. Lève une `ProvidallError` typée en cas d'échec.

    Options : `model`, `role`, `timeout`, `api_key`, `base_url`, `label`,
    `env`, `extra_body` (voir `prepare_decision`), plus `retry` et `on_decision`.
    """
    req = prepare_decision(state, questions, **kw)
    adaptateur: Any = adapter_for("systemone")
    corps = adaptateur.build(req)
    depart = time.monotonic()

    def tentative(_n: int) -> Decision:
        try:
            brut = adaptateur.send(req, corps)
        except ProvidallError:
            raise
        except Exception as exc:  # noqa: BLE001 — toute panne fournisseur est traduite
            raise map_exception(exc, provider=req.spec.provider, model=req.spec.alias) from exc
        return adaptateur.parse(brut, req)

    decision, essais = run_with_retry(
        _policy(retry, kw.get("env")), tentative, on_retry=_journaliser
    )
    return _finish(decision, req, depart, essais, on_decision)


async def adecide(
    state: DecisionState,
    questions: Mapping[str, Mapping[str, Any]],
    *,
    retry: RetryPolicy | None = None,
    on_decision: hooks.DecisionHook | None = None,
    **kw: Any,
) -> Decision:
    req = prepare_decision(state, questions, **kw)
    adaptateur: Any = adapter_for("systemone")
    corps = adaptateur.build(req)
    depart = time.monotonic()

    async def tentative(_n: int) -> Decision:
        try:
            brut = await adaptateur.asend(req, corps)
        except ProvidallError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise map_exception(exc, provider=req.spec.provider, model=req.spec.alias) from exc
        return adaptateur.parse(brut, req)

    decision, essais = await arun_with_retry(
        _policy(retry, kw.get("env")), tentative, on_retry=_journaliser
    )
    return _finish(decision, req, depart, essais, on_decision)


def try_decide(
    state: DecisionState, questions: Mapping[str, Mapping[str, Any]], **kw: Any
) -> Decision:
    """Ne lève JAMAIS : l'erreur est dans `.error`, et `.ok` dit si c'est passé.

    Pour les traitements en lot — un 529 sur un élément ne doit pas arrêter le
    passage sur tous les autres.
    """
    depart = time.monotonic()
    try:
        return decide(state, questions, **kw)
    except ProvidallError as exc:
        return _failed(exc, depart, kw)


async def atry_decide(
    state: DecisionState, questions: Mapping[str, Mapping[str, Any]], **kw: Any
) -> Decision:
    depart = time.monotonic()
    try:
        return await adecide(state, questions, **kw)
    except ProvidallError as exc:
        return _failed(exc, depart, kw)


def _failed(exc: ProvidallError, started: float, kw: dict[str, Any]) -> Decision:
    """`Decision` d'échec, pour `try_decide` : même forme que le succès, sans réponses."""
    decision = Decision(
        model=exc.model or "?",
        provider=exc.provider or "?",
        latency_s=time.monotonic() - started,
        attempts=exc.attempts,
        request_id=exc.request_id,
        error=exc,
    )
    hooks.emit_decision(decision, label=kw.get("label") or "", extra=kw.get("on_decision"))
    return decision


__all__ = [
    "adecide",
    "atry_decide",
    "choice",
    "decide",
    "noul",
    "prepare_decision",
    "score",
    "try_decide",
]
