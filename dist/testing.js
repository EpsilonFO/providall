/**
 * Faux `fetch` et fabriques de réponses, livrés dans le package.
 *
 * Livrés et pas cantonnés aux tests de la lib : un projet qui appelle
 * `complete()` doit pouvoir tester sa propre logique sans réseau ni clé, et
 * sans réécrire ce harnais. C'est la contrepartie de « une seule couche
 * d'appel » — si elle est partagée, son double de test doit l'être aussi.
 *
 *     import { fakeFetch, chatReply } from "providall/testing";
 *
 *     const faux = fakeFetch([chatReply("bonjour")]);
 *     const r = await complete("salut", { fetch: faux.fetch, env: FAUX_ENV });
 *     expect(faux.calls[0].body.model).toBe("deepseek-v4-flash");
 *
 * Seul le transport est remplacé : `build()` et `parse()` restent ceux des
 * vrais adaptateurs, donc un test peut affirmer sur le corps exact envoyé.
 */
/**
 * Rend les réponses en file. La DERNIÈRE se répète : un test de retry n'a pas
 * à fournir autant de réponses que de tentatives possibles.
 */
export function fakeFetch(responses) {
    const calls = [];
    let index = 0;
    return {
        calls,
        get bodies() {
            return calls.map((c) => c.body);
        },
        async fetch(url, init) {
            calls.push({
                url: String(url),
                headers: (init.headers ?? {}),
                body: JSON.parse(String(init.body ?? "{}")),
            });
            const choisie = responses[Math.min(index++, responses.length - 1)];
            if (choisie instanceof Error)
                throw choisie;
            if (typeof choisie === "function")
                return choisie();
            if (!choisie)
                throw new Error("fakeFetch : aucune réponse fournie");
            // Un `Response` ne se consomme qu'une fois : on le clone pour que la
            // dernière réponse puisse effectivement se répéter.
            return choisie.clone();
        },
    };
}
/** Réponse JSON classique. */
export function jsonRes(payload, status = 200, headers = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}
/** Réponse d'erreur, corps au format des APIs (`error.message`). */
export function errorRes(status, message, headers = {}) {
    return new Response(JSON.stringify({ error: { message } }), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}
/**
 * Réponse en flux SSE. `chunks` permet de découper le corps arbitrairement,
 * pour vérifier qu'un événement coupé en deux par le réseau est bien réassemblé.
 */
export function sseRes(events, opts = {}) {
    const separateur = opts.crlf ? "\r\n\r\n" : "\n\n";
    const corps = events.map((e) => `data: ${JSON.stringify(e)}${separateur}`).join("");
    const octets = new TextEncoder().encode(corps);
    const taille = opts.chunkSize ?? octets.length;
    const flux = new ReadableStream({
        start(controller) {
            for (let i = 0; i < octets.length; i += taille) {
                controller.enqueue(octets.slice(i, i + taille));
            }
            controller.close();
        },
    });
    return new Response(flux, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
}
/* ------------------------------------------------------------------------ */
/* Fabriques de charges utiles                                                */
/* ------------------------------------------------------------------------ */
export function chatReply(text = "", opts = {}) {
    const message = { role: "assistant", content: text };
    if (opts.toolCalls)
        message["tool_calls"] = opts.toolCalls;
    if (opts.reasoningContent)
        message["reasoning_content"] = opts.reasoningContent;
    return jsonRes({
        choices: [{ message, finish_reason: opts.finishReason ?? "stop" }],
        usage: {
            prompt_tokens: opts.promptTokens ?? 10,
            completion_tokens: opts.completionTokens ?? 5,
            prompt_tokens_details: { cached_tokens: opts.cachedTokens ?? 0 },
            completion_tokens_details: { reasoning_tokens: opts.reasoningTokens ?? 0 },
        },
    });
}
export function anthropicReply(text = "", opts = {}) {
    const blocs = [];
    if (opts.thinking)
        blocs.push({ type: "thinking", thinking: opts.thinking });
    if (text)
        blocs.push({ type: "text", text });
    for (const u of opts.toolUses ?? [])
        blocs.push({ type: "tool_use", ...u });
    return jsonRes({
        content: blocs,
        stop_reason: opts.stopReason ?? "end_turn",
        stop_details: opts.stopDetails ?? null,
        usage: {
            input_tokens: opts.inputTokens ?? 10,
            output_tokens: opts.outputTokens ?? 5,
            cache_read_input_tokens: opts.cacheRead ?? 0,
            cache_creation_input_tokens: opts.cacheWrite ?? 0,
        },
    });
}
export function toolCall(name, args, id = "call_0") {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
export function jsonReply(payload, opts = {}) {
    return chatReply(JSON.stringify(payload), opts);
}
/** Environnement de test minimal : une clé, un modèle, rien d'autre. */
export function testEnv(extra = {}) {
    return { DEEPSEEK_API_KEY: "sk-test", LLM_MODEL: "ds-flash", ...extra };
}
