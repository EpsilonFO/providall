"""Lecture de l'environnement, et chargement paresseux du `.env`.

Rien ne se charge à l'import : une lib qui lit des fichiers au moment où on
l'importe casse dès qu'un framework charge son propre `.env` après elle. Le
premier appel effectif déclenche le chargement, une seule fois.

L'environnement du process PRIME toujours sur les fichiers — c'est ce qui
permet à `LLM_MODEL=x uv run mon-script` de marcher, et à la CI de ne pas se
faire écraser par un `.env` traîné dans l'image. Entre les deux fichiers,
`.env.local` prime sur `.env` (convention de monumia et d'agenda).

Opt-out : `PROVIDALL_NO_DOTENV=1` — utilisé par la fixture de test.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

_NOMS = (".env", ".env.local")  # ordre de priorité croissante
_lock = threading.Lock()
_charge = False
_charges: list[Path] = []


def _remonter(depart: Path) -> list[Path]:
    """`.env` et `.env.local` trouvés en remontant depuis `depart` jusqu'à la racine.

    Remonter, et pas seulement regarder le cwd : un script lancé depuis
    `backend/scripts/` doit voir le `.env` de `backend/`.
    """
    trouves: list[Path] = []
    for dossier in [depart, *depart.parents]:
        for nom in _NOMS:
            chemin = dossier / nom
            if chemin.is_file():
                trouves.append(chemin)
        if trouves:
            # Le premier dossier qui en contient gagne : on ne fusionne pas
            # deux niveaux, sinon un `.env` de $HOME contaminerait tout projet.
            break
    return trouves


def load_env(directory: str | Path | None = None) -> list[Path]:
    """Charge `.env` puis `.env.local` sans écraser l'environnement du process.

    Appel explicite, pour les applications qui veulent maîtriser le moment
    (monumia le fait au démarrage). Le chargement paresseux fait la même chose
    au premier appel LLM si personne ne l'a appelé.
    """
    global _charge
    from dotenv import load_dotenv

    depart = Path(directory) if directory else Path.cwd()
    fichiers = _remonter(depart.resolve())
    # Chargé du MOINS prioritaire au plus prioritaire ne marcherait pas :
    # `override=False` fait gagner le PREMIER qui pose la variable. On charge
    # donc `.env.local` d'abord, puis `.env` ne comble que les trous — et
    # l'environnement du process, déjà en place, gagne sur les deux.
    for chemin in reversed(fichiers):
        load_dotenv(chemin, override=False)
    with _lock:
        _charge = True
        for chemin in fichiers:
            if chemin not in _charges:
                _charges.append(chemin)
    return fichiers


def ensure_loaded() -> None:
    """Chargement paresseux, une seule fois, sauf opt-out."""
    global _charge
    if _charge or os.environ.get("PROVIDALL_NO_DOTENV", "").strip() in ("1", "true", "yes"):
        return
    with _lock:
        if _charge:
            return
        _charge = True
    load_env()


def loaded_files() -> list[Path]:
    """Fichiers `.env` effectivement chargés — affiché par `providall check`."""
    return list(_charges)


def reset_for_tests() -> None:
    """Réarme le chargement paresseux. Réservé aux fixtures."""
    global _charge
    with _lock:
        _charge = False
        _charges.clear()


def get_env() -> dict[str, str]:
    ensure_loaded()
    return dict(os.environ)


def env_str(name: str, env: dict[str, str] | None = None) -> str | None:
    """Valeur non vide d'une variable, espaces retirés. `None` si absente ou vide.

    Une variable posée à la chaîne vide (`ANTHROPIC_API_KEY=` dans un `.env`)
    doit compter comme absente, pas comme une clé de longueur zéro.
    """
    source = env if env is not None else get_env()
    valeur = source.get(name)
    valeur = valeur.strip() if valeur else ""
    return valeur or None


def env_int(name: str, env: dict[str, str] | None = None) -> int | None:
    valeur = env_str(name, env)
    if valeur is None:
        return None
    try:
        return int(float(valeur))
    except ValueError:
        return None


def env_float(name: str, env: dict[str, str] | None = None) -> float | None:
    valeur = env_str(name, env)
    if valeur is None:
        return None
    try:
        return float(valeur)
    except ValueError:
        return None


def env_bool(name: str, env: dict[str, str] | None = None) -> bool:
    return (env_str(name, env) or "").lower() in ("1", "true", "yes", "on")


__all__ = ["ensure_loaded", "env_bool", "env_float", "env_int", "env_str", "get_env", "load_env"]
