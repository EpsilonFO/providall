"""Adaptateur System One — modèles de décision (Jev, de TypeSafe).

Pas un troisième dialecte de chat : un autre contrat. On envoie un `state` et
des questions typées (`noul`, `choice`, `score`), on reçoit des probabilités,
jamais de texte. `decide()` est le seul à l'atteindre ; il est inscrit dans
`ADAPTERS` pour que `providall.testing.fake_provider` le remplace comme les
deux autres.

Un seul format pour deux portes : TypeSafe (`api.typesafe.ai/v1/systemone`) et
OpenRouter (`openrouter.ai/api/v1/systemone`), qui reprend le format à
l'identique et ajoute `id`, `provider` et `usage.cost`.

Aucun SDK ici : `httpx2`, sur lequel s'appuient déjà les SDK Anthropic et
OpenAI — rien de plus à installer, et un seul pool de connexions par timeout.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ..errors import EmptyResponseError
from ..types import Answer, ChoiceAnswer, Decision, ModelSpec, NoulAnswer, ScoreAnswer, Usage
from .base import api_message, from_status, sdk_client

_REQUEST_ID = "_request_id"
"""Clé où `send()` range l'en-tête `x-typesafe-request-id` pour `parse()`."""


@dataclass
class DecisionRequest:
    """Tout ce dont l'adaptateur a besoin. Aucune lecture d'environnement au-delà."""

    spec: ModelSpec
    state: Any
    questions: Mapping[str, Mapping[str, Any]]
    timeout: float = 600.0
    api_key: str = ""
    base_url: str = ""
    label: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


def system_one_url(base: str) -> str:
    """`…/v1` (convention providall) ou racine nue (convention des SDK TypeSafe).

    La doc d'OpenRouter fait poser `TYPESAFE_BASE_URL=https://openrouter.ai/api`
    pour le SDK TypeSafe ; les deux formes mènent à `…/v1/systemone`.
    """
    nette = base.rstrip("/")
    dernier = nette.rsplit("/", 1)[-1]
    if len(dernier) > 1 and dernier[0] == "v" and dernier[1:].isdigit():
        return f"{nette}/systemone"
    return f"{nette}/v1/systemone"


class SystemOneAdapter:
    protocol = "systemone"

    def build(self, req: DecisionRequest) -> dict[str, Any]:
        return {
            "model": req.spec.model_id,
            "state": req.state,
            "questions": {k: dict(q) for k, q in req.questions.items()},
            **req.extra,
        }

    def parse(self, raw: Any, req: DecisionRequest) -> Decision:
        """Réponse native → `Decision`. Coût, latence et tentatives viennent après.

        Chaque question posée doit revenir, avec le bon type : une réponse
        partielle est traitée en réponse vide inexpliquée (rejouable), pas rendue
        trouée à un appelant qui brancherait dessus.
        """
        corps = dict(raw) if isinstance(raw, Mapping) else {}
        request_id = corps.pop(_REQUEST_ID, None) or corps.get("id") or None
        reponses: Mapping[str, Any] = corps.get("answers") or {}
        if not isinstance(reponses, Mapping):
            reponses = {}

        manquantes = [
            cle
            for cle, q in req.questions.items()
            if not isinstance(reponses.get(cle), Mapping)
            or reponses[cle].get("type") != q.get("type")
        ]
        if manquantes:
            raise EmptyResponseError(
                f"réponse System One incomplète : {', '.join(manquantes)} absente(s) ou mal typée(s)",
                provider=req.spec.provider,
                model=req.spec.alias,
            )

        u: Mapping[str, Any] = corps.get("usage") or {}
        if not isinstance(u, Mapping):
            u = {}
        facture = u.get("cost")
        return Decision(
            answers={cle: _answer(reponses[cle]) for cle in req.questions},
            model=req.spec.alias,
            model_id=req.spec.model_id,
            served_model=str(corps.get("model") or req.spec.model_id),
            provider=req.spec.provider,
            usage=Usage(
                input_tokens=int(u.get("input_tokens") or 0),
                output_tokens=int(u.get("output_tokens") or 0),
            ),
            cost_usd=float(facture) if isinstance(facture, int | float) else None,
            request_id=str(request_id) if request_id else None,
            raw=corps,
        )

    def send(self, req: DecisionRequest, body: dict[str, Any]) -> Any:
        client = sdk_client("httpx2", api_key="", base_url="", timeout=req.timeout)
        reponse = client.post(system_one_url(req.base_url), json=body, headers=_headers(req))
        return _read(reponse, req)

    async def asend(self, req: DecisionRequest, body: dict[str, Any]) -> Any:
        client = sdk_client("httpx2_async", api_key="", base_url="", timeout=req.timeout)
        reponse = await client.post(system_one_url(req.base_url), json=body, headers=_headers(req))
        return _read(reponse, req)


def _headers(req: DecisionRequest) -> dict[str, str]:
    return {"Authorization": f"Bearer {req.api_key}"} if req.api_key else {}


def _read(reponse: Any, req: DecisionRequest) -> Any:
    """Corps JSON d'une réponse 2xx ; erreur typée sinon (même table que le chat)."""
    request_id = reponse.headers.get("x-typesafe-request-id")
    if reponse.status_code >= 400:
        try:
            corps: Any = reponse.json()
        except ValueError:
            corps = reponse.text
        brut = corps[:400] if isinstance(corps, str) else ""
        raise from_status(
            reponse.status_code,
            api_message(corps) or brut or f"HTTP {reponse.status_code}",
            provider=req.spec.provider,
            model=req.spec.alias,
            body=corps,
            request_id=request_id,
            retry_after=_secondes(reponse.headers.get("retry-after")),
        )
    corps = reponse.json()
    if request_id and isinstance(corps, dict):
        corps = {**corps, _REQUEST_ID: request_id}
    return corps


def _secondes(valeur: str | None) -> float | None:
    try:
        return float(valeur) if valeur else None
    except ValueError:
        return None


def _answer(data: Mapping[str, Any]) -> Answer:
    """Réponse du fil → dataclass typée. Le type a déjà été vérifié par `parse()`."""
    if data["type"] == "noul":
        return NoulAnswer(noul=float(data.get("noul", 0.0)))
    if data["type"] == "choice":
        return ChoiceAnswer(
            choice=str(data.get("choice", "")),
            probabilities=dict(data.get("probabilities") or {}),
            confidence=float(data.get("confidence", 0.0)),
        )
    return ScoreAnswer(
        score=float(data.get("score", 0.0)),
        legend=dict(data.get("legend") or {}),
        probabilities=dict(data.get("probabilities") or {}),
        confidence=float(data.get("confidence", 0.0)),
    )


ADAPTER = SystemOneAdapter()

__all__ = ["ADAPTER", "DecisionRequest", "SystemOneAdapter", "system_one_url"]
