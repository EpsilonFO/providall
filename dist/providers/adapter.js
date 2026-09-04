/**
 * Socle des adaptateurs : requête résolue, normalisation, vérifications.
 *
 * Le pipeline d'un appel est identique dans les deux langages :
 *
 *     résoudre le modèle
 *   → vérifier clé et capacités          (ConfigError avant tout octet envoyé)
 *   → normaliser le prompt               (system fusionné, parties multimodales)
 *   → build(request)      ← PUR          (testable sans réseau)
 *   → fetch / SSE         ← le seul I/O
 *   → parse(raw)          ← PUR
 *   → coût, hook, Response
 *
 * `build` et `parse` purs, c'est ce qui permet de tester la totalité de la
 * traduction sans une seule requête.
 */
import { CapabilityError } from "../errors.js";
export function emptyUsage() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
    };
}
export function addUsage(a, b) {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
        reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    };
}
/* ------------------------------------------------------------------------ */
/* Normalisation du prompt                                                    */
/* ------------------------------------------------------------------------ */
/**
 * `string | Message[]` → `{ messages, system }`.
 *
 * Les messages `role: "system"` du prompt sont extraits et fusionnés avec
 * l'argument `system`, dans cet ordre. Un seul endroit décide, donc les deux
 * adaptateurs n'ont plus à se poser la question.
 */
export function normalizePrompt(prompt, system) {
    const entrants = typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt;
    const systemes = [];
    if (system?.trim())
        systemes.push(system.trim());
    const restants = [];
    for (const m of entrants) {
        if (m.role === "system") {
            const texte = messageText(m).trim();
            if (texte)
                systemes.push(texte);
        }
        else {
            restants.push(m);
        }
    }
    return { messages: restants, system: systemes.join("\n\n") || null };
}
export function messageText(m) {
    if (typeof m.content === "string")
        return m.content;
    if (Array.isArray(m.content)) {
        return m.content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
    }
    return "";
}
/** Contenu d'un message en liste de parties, quelle que soit sa forme d'entrée. */
export function contentParts(m) {
    if (typeof m.content === "string") {
        return m.content ? [{ type: "text", text: m.content }] : [];
    }
    return Array.isArray(m.content) ? m.content : [];
}
export function mergeSystem(...morceaux) {
    const gardes = morceaux.map((m) => m?.trim()).filter((m) => Boolean(m));
    return gardes.length ? gardes.join("\n\n") : null;
}
/**
 * Refuse AVANT d'envoyer ce que le modèle ne sait pas faire.
 *
 * Un `ConfigError` immédiat vaut mieux qu'un 400 obscur trois secondes plus
 * tard, et mieux encore qu'un `tools` silencieusement ignoré.
 */
export function checkCapabilities(req) {
    const { spec } = req;
    const ctx = { provider: spec.provider, model: spec.alias };
    if (req.tools?.length && !spec.caps.tools) {
        throw new CapabilityError("appels d'outils", {
            ...ctx,
            hint: "choisir un autre modèle, ou retirer `tools`",
        });
    }
    if (req.stream && !spec.caps.stream)
        throw new CapabilityError("streaming", ctx);
    for (const m of req.messages) {
        for (const part of contentParts(m)) {
            if ((part.type === "image_url" || part.type === "image_base64") && !spec.caps.vision) {
                throw new CapabilityError("images en entrée", {
                    ...ctx,
                    hint: "`caps.vision` est faux pour ce provider dans registry/providers.json",
                });
            }
        }
    }
}
/**
 * `tool_choice` effectif, et l'instruction de repli s'il a fallu dégrader.
 *
 * Claude Fable 5.1 répond 400 à `tool_choice` `any`/`tool` : on retombe sur
 * `auto` en demandant l'outil dans le prompt, plutôt que de faire échouer
 * l'appel.
 */
export function resolveToolChoice(req) {
    const choix = req.toolChoice ?? (req.tools?.length ? "auto" : "none");
    if (choix !== "required")
        return { choice: choix, instruction: null };
    if (req.spec.caps.forced_tool_choice)
        return { choice: "required", instruction: null };
    const noms = (req.tools ?? []).map((t) => t.name).join(", ");
    return {
        choice: "auto",
        instruction: `Tu dois appeler l'un de ces outils pour répondre : ${noms}. ` +
            "N'écris pas de réponse en texte à la place.",
    };
}
/* ------------------------------------------------------------------------ */
/* Lecture défensive des réponses                                             */
/* ------------------------------------------------------------------------ */
export function obj(value) {
    return typeof value === "object" && value !== null ? value : {};
}
export function str(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
export function num(value, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function arr(value) {
    return Array.isArray(value) ? value : [];
}
export function baseResponse(req, finishReason) {
    return {
        text: "",
        message: { role: "assistant", content: "" },
        toolCalls: [],
        reasoning: null,
        usage: emptyUsage(),
        costUsd: null,
        latencyMs: 0,
        model: req.spec.modelId,
        // `alias` est null hors registre : c'est ce qui distingue `sonnet` de
        // `anthropic:un-modele-tout-neuf` dans les logs et les rapports.
        alias: req.spec.alias.includes(":") ? null : req.spec.alias,
        provider: req.spec.provider,
        finishReason,
        attempts: 1,
        raw: null,
    };
}
export function parseArguments(raw) {
    try {
        const valeur = JSON.parse(raw || "{}");
        return typeof valeur === "object" && valeur !== null
            ? valeur
            : {};
    }
    catch {
        return {};
    }
}
