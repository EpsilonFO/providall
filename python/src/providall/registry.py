"""Registre : providers, modèles, et l'échappatoire `provider:model_id`.

Trois étages, du plus stable au plus volatil :
  - PROTOCOL_DEFAULTS : ce que le protocole garantit. Deux entrées, qui ne
    bougent pas d'une année sur l'autre.
  - providers          : protocole, adresse, nom de clé, écarts au protocole.
  - modèles            : alias, identifiant, tarif. Une ligne par modèle.

Un modèle qui vient de sortir n'a pas besoin d'entrer au registre :
`LLM_MODEL=zai:glm-5.4-flash` suffit. C'est délibéré — les identifiants des
fournisseurs tiers bougent tous les mois, et rien d'autre ne doit bouger avec.
"""

from __future__ import annotations

from dataclasses import replace as with_fields
from typing import Any

from ._registry_data import MODELS_DATA, PROVIDERS_DATA
from .errors import UnknownModelError
from .types import Caps, Effort, ModelSpec, Protocol, ProviderSpec, Wire

# Ce que garantit chaque protocole. Un provider ne déclare que ses ÉCARTS :
# une valeur recopiée est une valeur qui ne suivra pas la prochaine correction.
PROTOCOL_DEFAULTS: dict[str, dict[str, Any]] = {
    "anthropic": {
        "caps": {
            "tools": True,
            "structured": "json_schema",
            "effort": True,
            "thinking": "adaptive",
            "vision": True,
            # La famille Claude 5 rejette tout paramètre d'échantillonnage non
            # par défaut par un 400 : `temperature` est opt-in, pas opt-out.
            "temperature": False,
            "forced_tool_choice": True,
            "stream": True,
        },
        "wire": {
            "max_tokens_param": "max_tokens",
            "effort_param": "output_config",
            "effort_values": ["low", "medium", "high", "xhigh", "max"],
        },
        "defaults": {"max_tokens": 16000, "effort": None},
    },
    "openai_compat": {
        "caps": {
            "tools": True,
            # `json_object` garantit du JSON VALIDE, pas CONFORME : le schéma
            # part quand même dans le prompt système (leçon monumia).
            "structured": "json_object",
            "effort": False,
            "thinking": "none",
            "vision": True,
            "temperature": True,
            "forced_tool_choice": True,
            "stream": True,
        },
        "wire": {
            "max_tokens_param": "max_tokens",
            "effort_param": None,
            "effort_values": [],
        },
        "defaults": {"max_tokens": 16000, "effort": None},
    },
}


def _caps(protocol: str, *couches: dict[str, Any] | None) -> Caps:
    valeurs = dict(PROTOCOL_DEFAULTS[protocol]["caps"])
    for couche in couches:
        if couche:
            valeurs.update(couche)
    return Caps(**valeurs)


def _wire(protocol: str, *couches: dict[str, Any] | None) -> Wire:
    valeurs = dict(PROTOCOL_DEFAULTS[protocol]["wire"])
    for couche in couches:
        if couche:
            valeurs.update(couche)
    return Wire(
        max_tokens_param=valeurs["max_tokens_param"],
        effort_param=valeurs["effort_param"],
        effort_values=tuple(valeurs["effort_values"]),
    )


def _defaults(protocol: str, *couches: dict[str, Any] | None) -> dict[str, Any]:
    valeurs = dict(PROTOCOL_DEFAULTS[protocol]["defaults"])
    for couche in couches:
        if couche:
            valeurs.update(couche)
    return valeurs


def _build_provider(name: str, data: dict[str, Any]) -> ProviderSpec:
    protocol: Protocol = data["protocol"]
    defauts = _defaults(protocol, data.get("defaults"))
    return ProviderSpec(
        name=name,
        protocol=protocol,
        base_url=data.get("base_url", ""),
        api_key_env=data["api_key_env"],
        aliases=tuple(data.get("aliases", ())),
        default_model=data.get("default_model", ""),
        key_url=data.get("key_url", ""),
        requires_key=data.get("requires_key", True),
        caps=_caps(protocol, data.get("caps")),
        wire=_wire(protocol, data.get("wire")),
        max_tokens=defauts["max_tokens"],
        effort=defauts["effort"],
        note=data.get("note", ""),
    )


PROVIDERS: dict[str, ProviderSpec] = {
    name: _build_provider(name, data) for name, data in PROVIDERS_DATA.items()
}


def spec(
    alias: str,
    provider: str,
    model_id: str,
    *,
    price_in: float | None = None,
    price_out: float | None = None,
    price_cache_read: float | None = None,
    id_verified: bool = True,
    note: str = "",
    caps: dict[str, Any] | None = None,
    wire: dict[str, Any] | None = None,
    defaults: dict[str, Any] | None = None,
) -> ModelSpec:
    """Un modèle = son alias, son fournisseur, son identifiant. Le reste est hérité.

    Exposé publiquement : c'est ce qu'un projet consommateur appelle pour
    déclarer un modèle à lui sans toucher au dépôt.
    """
    if provider not in PROVIDERS:
        raise UnknownModelError(
            f"{provider}:{model_id}", aliases=list(MODELS), providers=list(PROVIDERS)
        )
    # On part du `ProviderSpec` DÉJÀ résolu, pas du JSON brut : sinon un
    # fournisseur enregistré à l'exécution (`register_provider`) verrait ses
    # capacités silencieusement remplacées par celles du protocole.
    p = PROVIDERS[provider]
    return ModelSpec(
        alias=alias,
        provider=provider,
        protocol=p.protocol,
        model_id=model_id,
        api_key_env=p.api_key_env,
        base_url=p.base_url,
        requires_key=p.requires_key,
        key_url=p.key_url,
        caps=with_fields(p.caps, **(caps or {})),
        wire=(
            with_fields(p.wire, **{**wire, "effort_values": tuple(wire["effort_values"])})
            if wire and "effort_values" in wire
            else with_fields(p.wire, **(wire or {}))
        ),
        max_tokens=(defaults or {}).get("max_tokens", p.max_tokens),
        effort=(defaults or {}).get("effort", p.effort),
        price_in=price_in,
        price_out=price_out,
        # Tarif de lecture de cache : un dixième de l'entrée, sauf indication
        # contraire (barème Anthropic usuel). Inconnu si le tarif l'est.
        price_cache_read=(
            price_cache_read
            if price_cache_read is not None
            else (price_in / 10 if price_in is not None else None)
        ),
        id_verified=id_verified,
        note=note,
    )


def _build_model(alias: str, data: dict[str, Any]) -> ModelSpec:
    surcharges = data.get("overrides", {})
    return spec(
        alias,
        data["provider"],
        data["model_id"],
        price_in=data.get("price_in"),
        price_out=data.get("price_out"),
        price_cache_read=data.get("price_cache_read"),
        id_verified=data.get("id_verified", True),
        note=data.get("note", ""),
        caps=surcharges.get("caps"),
        wire=surcharges.get("wire"),
        defaults=surcharges.get("defaults"),
    )


MODELS: dict[str, ModelSpec] = {
    alias: _build_model(alias, data) for alias, data in MODELS_DATA.items()
}


# --------------------------------------------------------------------------
# Enregistrement à l'exécution
# --------------------------------------------------------------------------


def register_provider(provider: ProviderSpec, *, replace: bool = False) -> None:
    """Ajoute un fournisseur sans toucher au dépôt (endpoint interne, proxy…)."""
    if provider.name in PROVIDERS and not replace:
        raise ValueError(f"provider déjà enregistré : {provider.name} (replace=True pour forcer)")
    PROVIDERS[provider.name] = provider
    PROVIDERS_DATA.setdefault(
        provider.name,
        {"protocol": provider.protocol, "api_key_env": provider.api_key_env},
    )


def register_model(model: ModelSpec, *, replace: bool = False) -> None:
    """Ajoute ou corrige un modèle : nouvel identifiant, tarif enfin connu…"""
    if model.alias in MODELS and not replace:
        raise ValueError(f"alias déjà enregistré : {model.alias} (replace=True pour forcer)")
    MODELS[model.alias] = model


# --------------------------------------------------------------------------
# Résolution
# --------------------------------------------------------------------------


def find_provider(name: str) -> ProviderSpec | None:
    """Nom canonique ou alias (`claude` → `anthropic`, `grok` → `xai`)."""
    cle = name.strip().lower()
    p = PROVIDERS.get(cle)
    if p:
        return p
    for provider in PROVIDERS.values():
        if cle in provider.aliases:
            return provider
    return None


def resolve_spec(name: str) -> ModelSpec:
    """Alias du registre, ou `provider:model_id` pour un modèle non inscrit.

    Ne consulte PAS l'environnement : c'est `config.resolve_model()` qui décide
    QUEL nom résoudre. Séparé pour que la table du registre reste testable sans
    variable d'environnement.
    """
    nom = name.strip()
    if nom in MODELS:
        return MODELS[nom]
    if ":" in nom:
        provider_nom, _, model_id = nom.partition(":")
        provider = find_provider(provider_nom)
        model_id = model_id.strip()
        if provider is None:
            raise UnknownModelError(nom, aliases=list(MODELS), providers=list(PROVIDERS))
        if not model_id:
            raise UnknownModelError(nom, aliases=list(MODELS), providers=list(PROVIDERS))
        return spec(
            nom,
            provider.name,
            model_id,
            id_verified=False,
            note="hors registre : identifiant et tarif non vérifiés",
        )
    raise UnknownModelError(nom, aliases=list(MODELS), providers=list(PROVIDERS))


def list_models(*, only_available: bool = False) -> list[ModelSpec]:
    modeles = list(MODELS.values())
    return [m for m in modeles if m.key_present] if only_available else modeles


def list_providers() -> list[ProviderSpec]:
    return list(PROVIDERS.values())


def clamp_effort(value: Effort | None, wire: Wire) -> str | None:
    """Ramène un effort à l'échelle du fournisseur plutôt que d'échouer.

    `xhigh` demandé à OpenAI (qui s'arrête à `high`) doit donner `high`, pas un
    400. L'inverse aussi : `none` chez Anthropic, qui n'a pas ce niveau, donne
    `low`. Un appel générique ne doit pas casser en changeant de fournisseur —
    c'est tout l'intérêt de la lib.
    """
    if value is None or not wire.effort_values:
        return None
    if value in wire.effort_values:
        return value
    ECHELLE = ["none", "low", "medium", "high", "xhigh", "max"]
    if value not in ECHELLE:
        return None
    voulu = ECHELLE.index(value)
    accepte = [(abs(ECHELLE.index(v) - voulu), ECHELLE.index(v), v) for v in wire.effort_values]
    return min(accepte)[2]


__all__ = [
    "MODELS",
    "PROTOCOL_DEFAULTS",
    "PROVIDERS",
    "clamp_effort",
    "find_provider",
    "list_models",
    "list_providers",
    "register_model",
    "register_provider",
    "resolve_spec",
    "spec",
]
