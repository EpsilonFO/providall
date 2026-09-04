/**
 * Journalisation : une ligne par appel, et rien d'autre.
 *
 * Jamais de `console.log` inconditionnel dans la lib : une lib qui écrit sur
 * stdout pollue les scripts qui redirigent leur sortie et les logs structurés
 * des serveurs. Le logger par défaut est SILENCIEUX sauf `warn` ; une
 * application qui veut la ligne d'appel passe le sien (ou pose `LLM_DEBUG=1`).
 */
import type { Logger, Response } from "./types.js";
export declare const silentLogger: Logger;
export declare const consoleLogger: Logger;
/** `[label] provider:model 3.2s in=… out=… cache=… $0.0041 finish=stop attempts=1` */
export declare function logLine(response: Response, label?: string): string;
//# sourceMappingURL=log.d.ts.map