/**
 * Adaptateur Anthropic — API Messages native (/v1/messages).
 *
 * Jamais via une couche compatible OpenAI : elle masque `output_config.format`,
 * `output_config.effort`, le raisonnement adaptatif et `stop_reason=refusal`,
 * qui sont exactement les quatre raisons d'utiliser Anthropic.
 *
 * C'est la traduction la plus éloignée du pivot :
 *   - le prompt système est un champ à part, pas un message ;
 *   - les appels d'outils sont des blocs `tool_use` dans le contenu assistant,
 *     et les résultats des blocs `tool_result` dans un message **user** ;
 *   - `max_tokens` est obligatoire ;
 *   - les rôles doivent alterner, donc plusieurs réponses d'outils
 *     consécutives se regroupent dans un seul message.
 *
 * Le raisonnement produit des blocs signés qu'il faut renvoyer intacts au tour
 * suivant : d'où le rejeu verbatim de `Message._raw`.
 */
import { EmptyResponseError, RefusalError } from "../errors.js";
import { joinUrl } from "../http.js";
import { clampEffort } from "../registry.js";
import { schemaInstruction } from "../schema.js";
import { arr, baseResponse, contentParts, mergeSystem, messageText, num, obj, parseArguments, resolveToolChoice, str, } from "./adapter.js";
export const API_VERSION = "2023-06-01";
export const PROVIDER_TAG = "anthropic";
/**
 * Effort → budget de raisonnement, pour les modèles d'avant la 4.6 qui ne
 * connaissent que `budget_tokens` (Haiku 4.5). Sur la famille 5,
 * `budget_tokens` répond 400 : c'est `output_config.effort` qui règle la
 * profondeur.
 */
export const THINKING_BUDGET = {
    none: 0,
    low: 2048,
    medium: 6000,
    high: 12_000,
    xhigh: 24_000,
    max: 32_000,
};
const STOP_REASONS = {
    end_turn: "stop",
    stop_sequence: "stop",
    max_tokens: "length",
    tool_use: "tool_calls",
    refusal: "refusal",
    pause_turn: "pause",
};
/* ------------------------------------------------------------------------ */
/* build                                                                      */
/* ------------------------------------------------------------------------ */
export function build(req) {
    const { spec } = req;
    const { choice, instruction } = resolveToolChoice(req);
    let system = mergeSystem(req.system, instruction);
    if (req.jsonSchema && spec.caps.structured !== "json_schema") {
        // Le fournisseur ne sait pas contraindre : le schéma part dans le système.
        // `json_object` n'existe pas ici — c'est schéma ou rien.
        system = mergeSystem(system, schemaInstruction(req.jsonSchema));
    }
    else if (req.jsonOnly && !req.jsonSchema) {
        system = mergeSystem(system, "Réponds UNIQUEMENT avec un objet JSON valide, sans texte ni balises autour.");
    }
    const body = {
        model: spec.modelId,
        [spec.wire.maxTokensParam]: req.maxTokens,
        messages: toNativeMessages(req.messages),
    };
    if (system)
        body["system"] = system;
    const outputConfig = {};
    if (req.jsonSchema && spec.caps.structured === "json_schema") {
        outputConfig["format"] = { type: "json_schema", schema: req.jsonSchema };
    }
    if (spec.caps.effort) {
        const effort = clampEffort(req.effort ?? spec.effort, spec.wire);
        if (effort)
            outputConfig["effort"] = effort;
    }
    if (Object.keys(outputConfig).length)
        body["output_config"] = outputConfig;
    if (spec.caps.thinking === "adaptive") {
        // Jamais `disabled` : refusé au-delà de `high` sur Opus 5, et laisser le
        // raisonnement actif à effort bas coûte moins cher que de le couper (le
        // modèle écrit alors son raisonnement en clair dans la réponse).
        body["thinking"] = { type: "adaptive" };
    }
    else if (spec.caps.thinking === "budget") {
        const budget = THINKING_BUDGET[req.effort ?? spec.effort ?? ""] ?? 0;
        if (budget) {
            // Le budget doit rester sous `max_tokens`, réponse comprise.
            body["thinking"] = {
                type: "enabled",
                budget_tokens: Math.min(budget, Math.max(req.maxTokens - 4096, 1024)),
            };
        }
    }
    if (req.temperature !== null && spec.caps.temperature)
        body["temperature"] = req.temperature;
    if (req.tools?.length) {
        body["tools"] = req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: Object.keys(t.parameters).length
                ? t.parameters
                : { type: "object", properties: {} },
        }));
        const natif = choice === "required" ? "any" : choice === "none" ? "none" : "auto";
        body["tool_choice"] = { type: natif };
    }
    if (req.stream)
        body["stream"] = true;
    // En dernier : un paramètre propre au fournisseur l'emporte sur ce que la
    // lib a construit (cf. `CompleteOptions.extraBody`).
    if (req.extraBody)
        Object.assign(body, req.extraBody);
    return {
        url: joinUrl(req.baseUrl, "/messages"),
        headers: { "x-api-key": req.apiKey, "anthropic-version": API_VERSION },
        body,
    };
}
/** Pivot → messages Anthropic, rôles alternés et `tool_result` groupés. */
export function toNativeMessages(messages) {
    const natifs = [];
    const pousser = (role, blocs) => {
        if (!blocs.length)
            return;
        const dernier = natifs[natifs.length - 1];
        // Les rôles doivent alterner : on fusionne au lieu d'empiler. C'est aussi
        // ce qui met tous les `tool_result` d'un tour dans un seul message.
        if (dernier && dernier.role === role)
            dernier.content.push(...blocs);
        else
            natifs.push({ role, content: [...blocs] });
    };
    for (const m of messages) {
        if (m.role === "tool") {
            pousser("user", [
                { type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: messageText(m) },
            ]);
            continue;
        }
        if (m.role === "assistant") {
            if (m._raw?.provider === PROVIDER_TAG && Array.isArray(m._raw.items)) {
                pousser("assistant", m._raw.items);
                continue;
            }
            const blocs = [];
            const texte = messageText(m).trim();
            if (texte)
                blocs.push({ type: "text", text: texte });
            for (const appel of m.tool_calls ?? []) {
                blocs.push({
                    type: "tool_use",
                    id: appel.id,
                    name: appel.function.name,
                    input: parseArguments(appel.function.arguments),
                });
            }
            pousser("assistant", blocs);
            continue;
        }
        const blocs = contentParts(m)
            .map(partToBlock)
            .filter((b) => b !== null);
        pousser("user", blocs);
    }
    return natifs;
}
function partToBlock(part) {
    if (part.type === "text") {
        const texte = str(part["text"]);
        return texte.trim() ? { type: "text", text: texte } : null;
    }
    if (part.type === "image_url") {
        return { type: "image", source: { type: "url", url: part["url"] } };
    }
    if (part.type === "image_base64") {
        return {
            type: "image",
            source: {
                type: "base64",
                media_type: str(part["media_type"], "image/png"),
                data: part["data"],
            },
        };
    }
    return { ...part }; // bloc natif déjà formé : laissé passer tel quel
}
/* ------------------------------------------------------------------------ */
/* parse                                                                      */
/* ------------------------------------------------------------------------ */
export function parse(raw, req) {
    const data = obj(raw);
    const blocs = arr(data["content"]).map(obj);
    const stopReason = str(data["stop_reason"]) || null;
    const texte = blocs
        .filter((b) => b["type"] === "text")
        .map((b) => str(b["text"]))
        .join("");
    const raisonnement = blocs
        .filter((b) => b["type"] === "thinking")
        .map((b) => str(b["thinking"]))
        .join("") || null;
    const appels = blocs
        .filter((b) => b["type"] === "tool_use")
        .map((b) => ({
        id: str(b["id"]),
        function: {
            name: str(b["name"]),
            arguments: JSON.stringify(b["input"] ?? {}),
        },
    }));
    if (stopReason === "refusal") {
        const details = obj(data["stop_details"]);
        throw new RefusalError("refus du modèle (stop_reason=refusal)", {
            category: str(details["category"]) || null,
            explanation: str(details["explanation"]) || null,
            provider: req.spec.provider,
            model: req.spec.alias,
        });
    }
    if (!texte && !appels.length) {
        const tronque = stopReason === "max_tokens";
        throw new EmptyResponseError(diagnosticVide(stopReason, req.maxTokens), {
            finishReason: stopReason,
            // Une troncature se reproduirait à l'identique : inutile de rejouer, il
            // faut augmenter `max_tokens`.
            retryable: !tronque,
            provider: req.spec.provider,
            model: req.spec.alias,
        });
    }
    const reponse = baseResponse(req, stopReason ? (STOP_REASONS[stopReason] ?? "other") : null);
    reponse.text = texte;
    reponse.toolCalls = appels;
    reponse.reasoning = raisonnement;
    reponse.usage = parseUsage(obj(data["usage"]));
    reponse.raw = raw;
    reponse.message = {
        role: "assistant",
        content: texte,
        ...(appels.length ? { tool_calls: appels } : {}),
        // Rejeu verbatim : conserve les blocs signés, exigés dès qu'un `tool_use`
        // suit un raisonnement.
        _raw: { provider: PROVIDER_TAG, items: blocs },
    };
    return reponse;
}
function parseUsage(usage) {
    return {
        // `input_tokens` d'Anthropic exclut déjà le cache : les deux adaptateurs
        // exposent donc la même chose, « entrée hors cache ».
        inputTokens: num(usage["input_tokens"]),
        outputTokens: num(usage["output_tokens"]),
        cacheReadTokens: num(usage["cache_read_input_tokens"]),
        cacheWriteTokens: num(usage["cache_creation_input_tokens"]),
        reasoningTokens: 0,
    };
}
/** Toujours nommer la cause : « contenu vide » seul ne se débogue pas. */
function diagnosticVide(stopReason, maxTokens) {
    if (stopReason === "max_tokens") {
        return (`contenu vide — budget de sortie épuisé avant la réponse (${maxTokens} jetons) : ` +
            "modèle à raisonnement, augmenter maxTokens");
    }
    if (stopReason === "pause_turn") {
        return "contenu vide — tour mis en pause par un outil serveur (relancer avec l'historique)";
    }
    return `contenu vide — stop_reason=${JSON.stringify(stopReason)}`;
}
function newStreamState() {
    return {
        blocks: [],
        partialJson: [],
        stopReason: null,
        stopDetails: null,
        usage: {},
    };
}
/**
 * Réassemble les blocs d'un flux SSE Anthropic.
 * Les arguments d'outil arrivent en fragments (`input_json_delta`) qu'il faut
 * concaténer avant de parser.
 */
function streamEvents(event, raw) {
    const state = raw;
    const type = str(event["type"]);
    const index = num(event["index"]);
    if (type === "message_start") {
        const message = obj(event["message"]);
        state.usage = { ...state.usage, ...obj(message["usage"]) };
        return [];
    }
    if (type === "message_delta") {
        const delta = obj(event["delta"]);
        state.stopReason = str(delta["stop_reason"]) || state.stopReason;
        if (delta["stop_details"])
            state.stopDetails = obj(delta["stop_details"]);
        state.usage = { ...state.usage, ...obj(event["usage"]) };
        return [];
    }
    if (type === "content_block_start") {
        const bloc = { ...obj(event["content_block"]) };
        state.blocks[index] = bloc;
        state.partialJson[index] = "";
        if (bloc["type"] === "tool_use") {
            return [
                {
                    type: "tool_call",
                    index,
                    id: str(bloc["id"]),
                    name: str(bloc["name"]),
                    arguments: "",
                },
            ];
        }
        return [];
    }
    if (type === "content_block_delta") {
        const delta = obj(event["delta"]);
        const bloc = (state.blocks[index] ??= {});
        const dtype = str(delta["type"]);
        if (dtype === "text_delta") {
            const morceau = str(delta["text"]);
            bloc["text"] = str(bloc["text"]) + morceau;
            return [{ type: "text", text: morceau }];
        }
        if (dtype === "thinking_delta") {
            const morceau = str(delta["thinking"]);
            bloc["thinking"] = str(bloc["thinking"]) + morceau;
            return [{ type: "reasoning", text: morceau }];
        }
        if (dtype === "signature_delta") {
            bloc["signature"] = str(bloc["signature"]) + str(delta["signature"]);
            return [];
        }
        if (dtype === "input_json_delta") {
            const morceau = str(delta["partial_json"]);
            state.partialJson[index] = (state.partialJson[index] ?? "") + morceau;
            return [{ type: "tool_call", index, arguments: morceau }];
        }
        return [];
    }
    if (type === "content_block_stop") {
        const bloc = state.blocks[index];
        if (bloc && bloc["type"] === "tool_use") {
            bloc["input"] = parseArguments(state.partialJson[index] ?? "{}");
        }
        return [];
    }
    return [];
}
/** État du flux → objet de la même forme qu'une réponse non streamée. */
function finalize(raw) {
    const state = raw;
    return {
        content: state.blocks.filter(Boolean),
        stop_reason: state.stopReason,
        stop_details: state.stopDetails,
        usage: state.usage,
    };
}
export const ADAPTER = {
    protocol: "anthropic",
    build,
    parse,
    streamEvents,
    finalize,
    newStreamState,
};
