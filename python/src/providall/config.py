"""Résolution du modèle et des réglages depuis l'environnement.

Le seul levier obligatoire est `LLM_MODEL`. Tout le reste a un défaut, et
l'ordre de résolution est conçu pour qu'un `.env` contenant une seule clé API
suffise à faire marcher `complete("bonjour")` sans autre configuration :

    argument explicite
  > LLM_MODEL_<ROLE>          (rôle passé à l'appel)
  > LLM_MODEL
  > LLM_PROVIDER              (compat agenda)
  > une seule clé *_API_KEY présente → default_model de ce provider
  > ConfigError listant alias et providers

La dernière étape avant l'erreur est ce qui rend « une clé dans .env, un
appel » possible. Elle ne se déclenche que s'il n'y a AUCUNE ambiguïté : deux
clés posées, et la lib redemande un `LLM_MODEL` plutôt que de choisir.

C'est la résolution de la famille chat. `decide()` a la sienne
(`resolve_decision`), qui ne regarde que les fournisseurs System One.
"""

from __future__ import annotations

from dataclasses import dataclass

from .env import env_float, env_int, env_str, get_env
from .errors import ConfigError, UnknownModelError
from .registry import MODELS, PROVIDERS, find_provider, is_system_one, resolve_spec
from .types import EFFORTS, Effort, ModelSpec

DEFAULT_TIMEOUT_S = 600.0
DEFAULT_RETRIES = 2


@dataclass(frozen=True)
class Resolution:
    """Le modèle retenu, et POURQUOI. La raison est affichée par la CLI."""

    spec: ModelSpec
    source: str


def _role_var(role: str) -> str:
    return f"LLM_MODEL_{role.strip().upper().replace('-', '_')}"


def _providers_with_key(env: dict[str, str], *, system_one: bool) -> list[str]:
    """Providers dont la clé est posée, dédupliqués par nom de variable, dans
    UNE famille.

    Dédupliqués : `zai` et `zai_anthropic` partagent `ZAI_API_KEY`, et deux
    entrées pour une même clé ne sont pas une ambiguïté pour l'utilisateur —
    mais il faut quand même en choisir une, donc on garde la première déclarée.
    La famille, elle, sépare : `TYPESAFE_API_KEY` seule ne doit pas faire partir
    `complete()` vers un modèle qui ne produit pas de texte, et
    `OPENROUTER_API_KEY` seule désigne le chat d'OpenRouter pour `complete()` ET
    Jev chez OpenRouter pour `decide()`.
    """
    vus: set[str] = set()
    trouves: list[str] = []
    for nom, p in PROVIDERS.items():
        if is_system_one(p) != system_one:
            continue
        if not p.requires_key or not p.default_model:
            # Un provider sans clé (ollama, openai_compat) n'est jamais un
            # défaut implicite : il faudrait aussi deviner base_url et modèle.
            continue
        if p.api_key_env in vus:
            continue
        if (env.get(p.api_key_env) or "").strip():
            vus.add(p.api_key_env)
            trouves.append(nom)
    return trouves


def resolve(
    name: str | None = None,
    *,
    role: str | None = None,
    env: dict[str, str] | None = None,
) -> Resolution:
    """Résout le modèle ET la raison de ce choix."""
    e = env if env is not None else get_env()

    if name:
        return Resolution(resolve_spec(name), "argument")

    if role:
        variable = _role_var(role)
        depuis_role = env_str(variable, e)
        if depuis_role:
            return Resolution(resolve_spec(depuis_role), variable)

    depuis_modele = env_str("LLM_MODEL", e)
    depuis_provider = env_str("LLM_PROVIDER", e)

    if depuis_modele:
        if depuis_provider and ":" not in depuis_modele and depuis_modele not in MODELS:
            # Compat agenda : `LLM_PROVIDER=openai` + `LLM_MODEL=gpt-5.6-terra`
            # désignait un identifiant nu chez ce provider. Un alias du registre
            # ou une forme `provider:id` restent prioritaires sur cette lecture.
            provider = find_provider(depuis_provider)
            if provider:
                return Resolution(
                    resolve_spec(f"{provider.name}:{depuis_modele}"),
                    "LLM_PROVIDER + LLM_MODEL",
                )
        return Resolution(resolve_spec(depuis_modele), "LLM_MODEL")

    if depuis_provider:
        provider = find_provider(depuis_provider)
        if provider is None:
            raise ConfigError(
                f"LLM_PROVIDER={depuis_provider!r} inconnu — connus : "
                + ", ".join(sorted(PROVIDERS))
            )
        if not provider.default_model:
            raise ConfigError(
                f"LLM_PROVIDER={depuis_provider!r} n'a pas de modèle par défaut : "
                f"poser aussi LLM_MODEL (et LLM_BASE_URL pour un serveur compatible)."
            )
        return Resolution(
            resolve_spec(f"{provider.name}:{provider.default_model}"),
            f"LLM_PROVIDER ({provider.name})",
        )

    candidats = _providers_with_key(e, system_one=False)
    if len(candidats) == 1:
        provider = PROVIDERS[candidats[0]]
        return Resolution(
            resolve_spec(f"{provider.name}:{provider.default_model}"),
            f"seule clé présente ({provider.api_key_env})",
        )
    if len(candidats) > 1:
        raise ConfigError(
            "plusieurs clés API présentes ("
            + ", ".join(PROVIDERS[c].api_key_env for c in candidats)
            + ") : poser LLM_MODEL pour trancher.\n"
            f"  alias du registre : {', '.join(sorted(MODELS))}"
        )
    raise UnknownModelError("(aucun)", aliases=list(MODELS), providers=list(PROVIDERS))


def resolve_model(
    name: str | None = None, *, role: str | None = None, env: dict[str, str] | None = None
) -> ModelSpec:
    """Le modèle actif. `providall.resolve_model()` est le point d'entrée public."""
    return resolve(name, role=role, env=env).spec


DECISION_MODEL_VAR = "LLM_MODEL_DECIDE"
"""Modèle de `decide()`. Le pendant de `LLM_MODEL` pour la famille System One."""


def resolve_decision(
    name: str | None = None,
    *,
    role: str | None = None,
    env: dict[str, str] | None = None,
) -> Resolution:
    """Résolution de la famille System One, pour `decide()` :

        argument explicite
      > LLM_MODEL_<ROLE>          (rôle passé à l'appel)
      > LLM_MODEL_DECIDE
      > LLM_MODEL, s'il désigne un modèle System One
      > une seule clé System One présente → default_model de ce provider
      > ConfigError

    `LLM_MODEL` désigne d'ordinaire le modèle de chat : il est SAUTÉ, pas
    refusé, quand il n'est pas System One. Ce que désignent les trois premiers
    étages est rendu tel quel — c'est `prepare_decision()` qui refuse un modèle
    de chat, avec un message qui dit quoi faire.
    """
    e = env if env is not None else get_env()

    if name:
        return Resolution(resolve_spec(name), "argument")

    if role:
        variable = _role_var(role)
        depuis_role = env_str(variable, e)
        if depuis_role:
            return Resolution(resolve_spec(depuis_role), variable)

    dedie = env_str(DECISION_MODEL_VAR, e)
    if dedie:
        return Resolution(resolve_spec(dedie), DECISION_MODEL_VAR)

    general = env_str("LLM_MODEL", e)
    if general:
        try:
            candidat = resolve_spec(general)
        except UnknownModelError:
            candidat = None
        if candidat is not None and is_system_one(candidat):
            return Resolution(candidat, "LLM_MODEL")

    candidats = _providers_with_key(e, system_one=True)
    if len(candidats) == 1:
        provider = PROVIDERS[candidats[0]]
        return Resolution(
            resolve_spec(f"{provider.name}:{provider.default_model}"),
            f"seule clé System One présente ({provider.api_key_env})",
        )
    modeles = ", ".join(sorted(a for a, m in MODELS.items() if is_system_one(m)))
    if len(candidats) > 1:
        raise ConfigError(
            "plusieurs clés System One présentes ("
            + ", ".join(PROVIDERS[c].api_key_env for c in candidats)
            + f") : poser {DECISION_MODEL_VAR} pour trancher.\n"
            f"  modèles System One : {modeles}"
        )
    cles = " ou ".join(dict.fromkeys(p.api_key_env for p in PROVIDERS.values() if is_system_one(p)))
    raise ConfigError(
        f"aucun modèle System One : poser {DECISION_MODEL_VAR} ({modeles}) "
        f"et la clé de son fournisseur ({cles})."
    )


def base_url_for(spec: ModelSpec, env: dict[str, str] | None = None) -> tuple[str, str]:
    """URL de base effective, et d'où elle vient.

    `<PROVIDER>_BASE_URL` surcharge un provider connu (utile pour un proxy
    d'entreprise) ; `LLM_BASE_URL` sert au provider générique `openai_compat`.
    """
    e = env if env is not None else get_env()
    variable = f"{spec.provider.upper()}_BASE_URL"
    depuis_provider = env_str(variable, e)
    if depuis_provider:
        return depuis_provider, variable
    # Les replis génériques `LLM_BASE_URL` et `LLM_API_KEY` désignent un serveur
    # de CHAT compatible : les appliquer à un fournisseur System One enverrait
    # la requête — ou la clé — au mauvais service.
    generique = None if is_system_one(spec) else env_str("LLM_BASE_URL", e)
    if generique:
        return generique, "LLM_BASE_URL"
    if not spec.base_url:
        raise ConfigError(
            f"aucune URL de base pour {spec.provider} : poser LLM_BASE_URL (ou {variable}).",
            provider=spec.provider,
            model=spec.alias,
        )
    return spec.base_url, "registre"


def api_key_for(spec: ModelSpec, env: dict[str, str] | None = None) -> str:
    """Clé du provider, `LLM_API_KEY` en repli (famille chat seulement).

    Vide autorisée si `requires_key` est faux.
    """
    e = env if env is not None else get_env()
    repli = None if is_system_one(spec) else env_str("LLM_API_KEY", e)
    return env_str(spec.api_key_env, e) or repli or ""


def normalize_effort(value: str | None) -> Effort | None:
    """Valide un effort venu de l'environnement ou d'un appelant. Inconnu → None."""
    if not value:
        return None
    v = value.strip().lower()
    return v if v in EFFORTS else None  # type: ignore[return-value]


@dataclass(frozen=True)
class EnvDefaults:
    """Réglages globaux du `.env`, tous surchargeables à l'appel."""

    max_tokens: int | None = None
    effort: Effort | None = None
    temperature: float | None = None
    timeout: float | None = None
    retries: int | None = None


def env_defaults(env: dict[str, str] | None = None) -> EnvDefaults:
    e = env if env is not None else get_env()
    return EnvDefaults(
        max_tokens=env_int("LLM_MAX_TOKENS", e),
        effort=normalize_effort(env_str("LLM_EFFORT", e)),
        temperature=env_float("LLM_TEMPERATURE", e),
        timeout=_timeout(e),
        retries=env_int("LLM_RETRIES", e),
    )


def _timeout(env: dict[str, str]) -> float | None:
    """`LLM_TIMEOUT` en secondes, `LLM_TIMEOUT_MS` accepté en repli.

    Repli conservé pour agenda, dont le `.env.local` porte `LLM_TIMEOUT_MS`.
    """
    secondes = env_float("LLM_TIMEOUT", env)
    if secondes is not None:
        return secondes
    ms = env_float("LLM_TIMEOUT_MS", env)
    return ms / 1000 if ms is not None else None


__all__ = [
    "DECISION_MODEL_VAR",
    "DEFAULT_RETRIES",
    "DEFAULT_TIMEOUT_S",
    "EnvDefaults",
    "Resolution",
    "api_key_for",
    "base_url_for",
    "env_defaults",
    "normalize_effort",
    "resolve",
    "resolve_decision",
    "resolve_model",
]
