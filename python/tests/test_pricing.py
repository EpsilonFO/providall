"""Coût : la formule, et le refus d'inventer un zéro."""

from __future__ import annotations

import pytest

from providall.pricing import CACHE_WRITE_MULTIPLIER, compute_cost, format_cost
from providall.registry import resolve_spec, spec
from providall.types import Usage


def test_formule_complete():
    s = spec("t", "anthropic", "m", price_in=3.0, price_out=15.0)
    usage = Usage(
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read_tokens=1_000_000,
        cache_write_tokens=1_000_000,
    )
    attendu = 3.0 + 15.0 + 0.3 + 3.0 * CACHE_WRITE_MULTIPLIER
    assert compute_cost(s, usage) == pytest.approx(attendu)


def test_tarif_inconnu_donne_none():
    """Un 0,00 $ faux se retrouve additionné dans un rapport sans qu'on le voie."""
    assert compute_cost(resolve_spec("glm-flash"), Usage(input_tokens=1000)) is None


def test_prix_de_cache_explicite():
    s = spec("t", "anthropic", "m", price_in=10.0, price_out=50.0, price_cache_read=0.25)
    assert compute_cost(s, Usage(cache_read_tokens=1_000_000)) == pytest.approx(0.25)


def test_usage_vide_coute_zero():
    assert compute_cost(resolve_spec("sonnet"), Usage()) == 0.0


def test_addition_d_usages():
    total = Usage(input_tokens=1, output_tokens=2) + Usage(input_tokens=3, cache_read_tokens=4)
    assert total.input_tokens == 4 and total.output_tokens == 2 and total.cache_read_tokens == 4
    assert total.total_tokens == 10


def test_format_cost():
    assert format_cost(None) == "$?"
    assert format_cost(0.00412) == "$0.0041"
