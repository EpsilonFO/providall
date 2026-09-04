#!/usr/bin/env node
/**
 * CLI `providall` : `models`, `check`, `ask`.
 *
 * Même sortie que la commande Python, à la ligne près : c'est le test le plus
 * simple qu'un seul registre sert bien les deux packages.
 *
 * La CLI est la SEULE partie qui lit des fichiers `.env` — elle est
 * l'application, pas la bibliothèque.
 */
import type { Env } from "./types.js";
/** Port de `table_registre()` (monumia), colonnes comprises. */
export declare function modelsTable(env?: Env, onlyAvailable?: boolean): string;
/** État de la configuration. Deuxième membre : tout va bien ? */
export declare function checkReport(model?: string, env?: Env, loaded?: string[]): [string, boolean];
type Args = {
    command: string;
    positional: string[];
    flags: Record<string, string | boolean>;
};
export declare function parseArgs(argv: string[]): Args;
export declare function main(argv?: string[]): Promise<number>;
export {};
//# sourceMappingURL=cli.d.ts.map