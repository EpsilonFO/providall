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
import type { Effort, Env } from "./types.js";
export declare function defaultEnv(): Env;
/**
 * Valeur non vide d'une variable, espaces retirés.
 *
 * Une variable posée à la chaîne vide (`ANTHROPIC_API_KEY=` dans un `.env`)
 * compte comme absente, pas comme une clé de longueur zéro.
 */
export declare function envStr(name: string, env?: Env): string | undefined;
export declare function envNum(name: string, env?: Env): number | undefined;
export declare function envBool(name: string, env?: Env): boolean;
/** Valide un effort venu de l'environnement ou d'un appelant. Inconnu → undefined. */
export declare function normalizeEffort(value: string | undefined | null): Effort | undefined;
//# sourceMappingURL=env.d.ts.map