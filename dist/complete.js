/**
 * `createClient` et le pipeline d'un appel.
 *
 * Les fonctions de module (`complete(...)`) délèguent à un client par défaut.
 * Un projet qui veut fixer un modèle, un timeout ou un logger une fois pour
 * toutes se construit le sien ; les deux surfaces sont identiques.
 *
 * `fetch` et `env` sont injectables partout. Ce n'est pas de la coquetterie :
 * c'est ce qui permet à toute la suite de tests de tourner sans réseau, et à
 * un projet consommateur d'en faire autant.
 */
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT_MS, apiKeyFor, baseUrlFor, envDefaults, resolve, } from "./config.js";
import { defaultEnv, envBool, normalizeEffort } from "./env.js";
import { MissingKeyError, ProvidallError, toProvidallError } from "./errors.js";
import { postJson, readSse, retry } from "./http.js";
import { consoleLogger, logLine, silentLogger } from "./log.js";
import { computeCost } from "./pricing.js";
import { adapterFor } from "./providers/index.js";
import { baseResponse, checkCapabilities, normalizePrompt } from "./providers/adapter.js";
import { toTextStream } from "./stream.js";
export function createClient(config = {}) {
    const fusion = (opts = {}) => ({ ...config, ...opts });
    return {
        complete: (input, opts) => runComplete(input, fusion(opts)),
        tryComplete: (input, opts) => runTryComplete(input, fusion(opts)),
        stream: (input, opts) => runStream(input, fusion(opts)),
        prepare: (input, opts) => prepare(input, fusion(opts)),
        config,
    };
}
/* ------------------------------------------------------------------------ */
/* Préparation                                                                */
/* ------------------------------------------------------------------------ */
export function prepare(input, opts = {}) {
    const env = opts.env ?? defaultEnv();
    const defauts = envDefaults(env);
    const { spec } = resolve(opts.model, { role: opts.role, env });
    const cle = opts.apiKey ?? apiKeyFor(spec, env);
    if (!cle && spec.requiresKey) {
        throw new MissingKeyError(spec.apiKeyEnv, { provider: spec.provider, keyUrl: spec.keyUrl });
    }
    const url = opts.baseUrl ?? baseUrlFor(spec, env)[0];
    const { messages, system } = normalizePrompt(input, opts.system);
    const req = {
        spec,
        messages,
        system,
        maxTokens: opts.maxTokens ?? defauts.maxTokens ?? spec.maxTokens,
        effort: normalizeEffort(opts.effort) ?? defauts.effort ?? spec.effort ?? null,
        temperature: opts.temperature ?? defauts.temperature ?? null,
        tools: opts.tools ?? null,
        toolChoice: opts.toolChoice ?? null,
        jsonSchema: opts.json && opts.json !== true ? opts.json : null,
        jsonOnly: opts.json === true,
        stream: false,
        apiKey: cle,
        baseUrl: url,
        label: opts.label ?? spec.alias,
        extraBody: opts.extraBody ?? null,
    };
    checkCapabilities(req);
    return req;
}
function loggerFor(opts, env) {
    return opts.logger ?? (envBool("LLM_DEBUG", env) ? consoleLogger : silentLogger);
}
function policyFor(opts, env) {
    return { retries: opts.retries ?? envDefaults(env).retries ?? DEFAULT_RETRIES };
}
function timeoutFor(opts, env) {
    return opts.timeoutMs ?? envDefaults(env).timeoutMs ?? DEFAULT_TIMEOUT_MS;
}
function finish(response, spec, startedAt, attempts, opts, env) {
    response.latencyMs = Date.now() - startedAt;
    response.attempts = attempts;
    response.costUsd = computeCost(spec, response.usage);
    loggerFor(opts, env).info(logLine(response, opts.label ?? spec.alias));
    opts.onResponse?.(response);
    return response;
}
/* ------------------------------------------------------------------------ */
/* complete                                                                   */
/* ------------------------------------------------------------------------ */
/** Un aller-retour. Rejette avec une `ProvidallError` typée en cas d'échec. */
export async function complete(input, opts = {}) {
    return runComplete(input, opts);
}
async function runComplete(input, opts) {
    const env = opts.env ?? defaultEnv();
    const req = prepare(input, opts);
    const adaptateur = adapterFor(req.spec.protocol);
    const construit = adaptateur.build(req);
    const contexte = { provider: req.spec.provider, model: req.spec.alias };
    const debut = Date.now();
    const { value, attempts } = await retry(policyFor(opts, env), async () => {
        const res = await postJson(construit.url, construit.headers, construit.body, {
            fetch: opts.fetch,
            timeoutMs: timeoutFor(opts, env),
            signal: opts.signal,
            context: contexte,
        });
        const brut = await res.json();
        return adaptateur.parse(brut, req);
    }, { logger: loggerFor(opts, env), signal: opts.signal, label: req.label });
    return finish(value, req.spec, debut, attempts, opts, env);
}
/**
 * Ne rejette JAMAIS : `{ ok, value, error }`.
 *
 * Pour les traitements en lot — un fournisseur en panne ne doit pas
 * interrompre un passage sur 142 fiches ; l'appelant escalade l'élément
 * concerné et continue.
 */
export async function tryComplete(input, opts = {}) {
    return runTryComplete(input, opts);
}
async function runTryComplete(input, opts) {
    try {
        return { ok: true, value: await runComplete(input, opts) };
    }
    catch (err) {
        return { ok: false, error: toProvidallError(err) };
    }
}
/* ------------------------------------------------------------------------ */
/* stream                                                                     */
/* ------------------------------------------------------------------------ */
/**
 * Flux de texte. `for await (const morceau of stream(...))` rend les deltas ;
 * `await stream(...).response` rend la réponse complète (usage, coût).
 */
export function stream(input, opts = {}) {
    return runStream(input, opts);
}
function runStream(input, opts) {
    return toTextStream(streamEvents(input, opts));
}
async function* streamEvents(input, opts) {
    const env = opts.env ?? defaultEnv();
    const req = { ...prepare(input, opts), stream: true };
    checkCapabilities(req);
    const adaptateur = adapterFor(req.spec.protocol);
    const construit = adaptateur.build(req);
    const contexte = { provider: req.spec.provider, model: req.spec.alias };
    const politique = policyFor(opts, env);
    for (let tentative = 0;; tentative++) {
        const debut = Date.now();
        let emis = false;
        try {
            const res = await postJson(construit.url, construit.headers, construit.body, {
                fetch: opts.fetch,
                timeoutMs: timeoutFor(opts, env),
                signal: opts.signal,
                context: contexte,
            });
            const etat = adaptateur.newStreamState();
            for await (const brut of readSse(res, contexte)) {
                for (const evenement of adaptateur.streamEvents(brut, etat)) {
                    emis = true;
                    yield evenement;
                }
            }
            const reponse = adaptateur.parse(adaptateur.finalize(etat), req);
            yield {
                type: "done",
                response: finish(reponse, req.spec, debut, tentative + 1, opts, env),
            };
            return;
        }
        catch (err) {
            const erreur = toProvidallError(err, contexte);
            // Une fois des octets rendus à l'appelant, plus de relance : il a déjà
            // affiché du texte, rejouer le dupliquerait.
            if (!erreur.retryable || emis || tentative >= politique.retries) {
                erreur.attempts = tentative + 1;
                throw erreur;
            }
            loggerFor(opts, env).warn(`[providall:${req.label}] ${erreur.message} — relance ${tentative + 1}/${politique.retries}`);
            await new Promise((r) => setTimeout(r, 2000 * (tentative + 1)));
        }
    }
}
/** `Response` d'échec, pour un appelant qui veut la même forme partout. */
export function errorResponse(error, spec) {
    const reponse = baseResponse({
        spec,
        messages: [],
        system: null,
        maxTokens: 0,
        effort: null,
        temperature: null,
        tools: null,
        toolChoice: null,
        jsonSchema: null,
        jsonOnly: false,
        stream: false,
        apiKey: "",
        baseUrl: "",
        label: "",
    }, null);
    reponse.error = error;
    reponse.attempts = error.attempts;
    return reponse;
}
