"""Coût d'un appel. `None` quand le tarif est inconnu — jamais un faux 0.

Un 0,00 $ affiché pour un modèle dont on n'a pas saisi le tarif est pire que
pas de chiffre du tout : il se retrouve additionné dans un rapport de benchmark
et fausse la comparaison sans que personne ne le voie.
"""

from __future__ import annotations

from .types import ModelSpec, Usage

# L'écriture de cache est facturée 1,25× le tarif d'entrée chez Anthropic.
CACHE_WRITE_MULTIPLIER = 1.25


def compute_cost(spec: ModelSpec, usage: Usage) -> float | None:
    if not spec.price_known:
        return None
    prix_in = spec.price_in or 0.0
    prix_out = spec.price_out or 0.0
    prix_cache = spec.price_cache_read if spec.price_cache_read is not None else prix_in / 10
    return (
        usage.input_tokens * prix_in
        + usage.cache_read_tokens * prix_cache
        + usage.cache_write_tokens * prix_in * CACHE_WRITE_MULTIPLIER
        + usage.output_tokens * prix_out
    ) / 1e6


def format_cost(cost: float | None) -> str:
    if cost is None:
        return "$?"
    # Quatre décimales : un appel court coûte quelques dixièmes de centime, et
    # « $0.00 » ne dit rien.
    return f"${cost:.4f}"


__all__ = ["CACHE_WRITE_MULTIPLIER", "compute_cost", "format_cost"]
