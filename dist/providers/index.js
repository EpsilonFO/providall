/** Deux adaptateurs, un par protocole. En ajouter un = ajouter une entrée ici. */
import { ADAPTER as ANTHROPIC } from "./anthropic.js";
import { ADAPTER as CHAT_COMPLETIONS } from "./chat-completions.js";
export const ADAPTERS = new Map([
    ["anthropic", ANTHROPIC],
    ["openai_compat", CHAT_COMPLETIONS],
]);
export function adapterFor(protocol) {
    const adaptateur = ADAPTERS.get(protocol);
    // Le registre valide déjà le protocole : cette garde n'attrape qu'un bug.
    if (!adaptateur)
        throw new Error(`protocole inconnu : ${protocol}`);
    return adaptateur;
}
