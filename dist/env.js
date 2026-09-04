/**
 * Lecture de l'environnement. Aucune lecture de FICHIER, jamais.
 *
 * Next.js charge ses `.env*` lui-même, et Node a `process.loadEnvFile()`
 * depuis la 20 : une lib qui lirait un `.env` en plus se battrait avec l'un ou
 * l'autre pour savoir qui gagne. Seule la CLI (`cli.ts`) charge des fichiers,
 * parce qu'elle est l'application.
 *
 * Toute fonction accepte un `env` injecté : c'est ce qui rend la couche
 * testable sans toucher à `process.env`.
 */
import { EFFORTS } from "./types.js";
export function defaultEnv() {
    return typeof process !== "undefined" && process.env ? process.env : {};
}
/**
 * Valeur non vide d'une variable, espaces retirés.
 *
 * Une variable posée à la chaîne vide (`ANTHROPIC_API_KEY=` dans un `.env`)
 * compte comme absente, pas comme une clé de longueur zéro.
 */
export function envStr(name, env = defaultEnv()) {
    const brut = env[name];
    const valeur = brut ? brut.trim() : "";
    return valeur || undefined;
}
export function envNum(name, env = defaultEnv()) {
    const valeur = envStr(name, env);
    if (valeur === undefined)
        return undefined;
    const nombre = Number(valeur);
    return Number.isFinite(nombre) ? nombre : undefined;
}
export function envBool(name, env = defaultEnv()) {
    const valeur = envStr(name, env)?.toLowerCase();
    return valeur === "1" || valeur === "true" || valeur === "yes" || valeur === "on";
}
/** Valide un effort venu de l'environnement ou d'un appelant. Inconnu → undefined. */
export function normalizeEffort(value) {
    if (!value)
        return undefined;
    const v = value.trim().toLowerCase();
    return EFFORTS.includes(v) ? v : undefined;
}
