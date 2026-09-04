/**
 * Journalisation : une ligne par appel, et rien d'autre.
 *
 * Jamais de `console.log` inconditionnel dans la lib : une lib qui écrit sur
 * stdout pollue les scripts qui redirigent leur sortie et les logs structurés
 * des serveurs. Le logger par défaut est SILENCIEUX sauf `warn` ; une
 * application qui veut la ligne d'appel passe le sien (ou pose `LLM_DEBUG=1`).
 */

import { formatCost } from "./pricing.js";
import type { Logger, Response } from "./types.js";

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, ...rest) => console.warn(message, ...rest),
};

export const consoleLogger: Logger = {
  debug: (message, ...rest) => console.debug(message, ...rest),
  info: (message, ...rest) => console.info(message, ...rest),
  warn: (message, ...rest) => console.warn(message, ...rest),
};

/** `[label] provider:model 3.2s in=… out=… cache=… $0.0041 finish=stop attempts=1` */
export function logLine(response: Response, label = ""): string {
  const u = response.usage;
  const morceaux = [
    label ? `[${label}]` : "",
    `${response.provider}:${response.model}`,
    `${(response.latencyMs / 1000).toFixed(1)}s`,
    `in=${u.inputTokens}`,
    `out=${u.outputTokens}`,
  ];
  if (u.cacheReadTokens || u.cacheWriteTokens) {
    morceaux.push(`cache=${u.cacheReadTokens}/${u.cacheWriteTokens}`);
  }
  if (u.reasoningTokens) morceaux.push(`reasoning=${u.reasoningTokens}`);
  morceaux.push(formatCost(response.costUsd));
  morceaux.push(`finish=${response.finishReason}`);
  if (response.attempts > 1) morceaux.push(`attempts=${response.attempts}`);
  if (response.error) morceaux.push(`error=${response.error.name}`);
  return morceaux.filter(Boolean).join(" ");
}
