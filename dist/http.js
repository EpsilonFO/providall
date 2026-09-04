/**
 * Plomberie HTTP : timeout, retries, lecture SSE. Écrite une fois.
 *
 * `fetch` brut, zéro dépendance. C'est le choix d'agenda, et il se justifie
 * autrement qu'esthétiquement : deux protocoles, quatre endpoints, aucun SDK
 * n'apporte assez pour valoir sa surface de mise à jour — et un package sans
 * dépendance runtime s'installe depuis git dans n'importe quel projet.
 *
 * Une seule couche de retry ici, celle de `retry()`. Le corollaire côté
 * Python est `max_retries=0` sur les SDK : ce qu'on ne veut nulle part, c'est
 * trois timeouts de dix minutes empilés en silence.
 */
import { ProvidallError, RateLimitError, fromHttp, toProvidallError } from "./errors.js";
/** Backoff linéaire : au-delà de deux tentatives on abandonne de toute façon. */
export const BACKOFF_STEP_MS = 2000;
export const MAX_BACKOFF_MS = 30_000;
export function joinUrl(base, path) {
    return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
function sleep(ms, signal) {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new ProvidallError("appel annulé"));
        }, { once: true });
    });
}
export function backoffMs(policy, attempt, error) {
    const pas = policy.backoffStepMs ?? BACKOFF_STEP_MS;
    const plafond = policy.maxBackoffMs ?? MAX_BACKOFF_MS;
    // Un `Retry-After` du fournisseur prime : il sait mieux que nous.
    if (error instanceof RateLimitError && error.retryAfterMs !== null) {
        return Math.min(Math.max(error.retryAfterMs, 0), plafond);
    }
    return Math.min(pas * attempt, plafond);
}
/**
 * Exécute `attempt(n)` en le retentant sur erreur transitoire.
 * Renvoie la valeur ET le nombre de tentatives, pour `Response.attempts`.
 */
export async function retry(policy, attempt, opts = {}) {
    let derniere;
    for (let n = 0; n <= policy.retries; n++) {
        if (n > 0) {
            const pause = backoffMs(policy, n, derniere);
            opts.logger?.warn(`[providall${opts.label ? `:${opts.label}` : ""}] ${derniere?.message ?? "erreur"} — relance ${n}/${policy.retries} dans ${pause}ms`);
            await sleep(pause, opts.signal);
        }
        try {
            return { value: await attempt(n + 1), attempts: n + 1 };
        }
        catch (err) {
            const erreur = toProvidallError(err);
            erreur.attempts = n + 1;
            if (!erreur.retryable)
                throw erreur;
            derniere = erreur;
        }
    }
    throw derniere ?? new ProvidallError("échec après retries");
}
function retryAfterMs(headers) {
    const brut = headers.get("retry-after");
    if (!brut)
        return null;
    const secondes = Number(brut);
    if (Number.isFinite(secondes))
        return secondes * 1000;
    const date = Date.parse(brut);
    return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : null;
}
/**
 * Extrait le message utile d'un corps d'erreur. Les fournisseurs enveloppent
 * différemment (`error.message`, `message`, `detail`) — on tente, sinon on
 * renvoie le brut tronqué.
 */
export function extractApiMessage(text) {
    if (!text)
        return "";
    try {
        const j = JSON.parse(text);
        const erreur = j["error"];
        const message = (typeof erreur === "object" && erreur !== null
            ? erreur["message"]
            : erreur) ??
            j["message"] ??
            j["detail"];
        if (typeof message === "string" && message)
            return message.slice(0, 400);
    }
    catch {
        // pas du JSON : on garde le texte brut
    }
    return text.slice(0, 400);
}
/**
 * POST JSON. Une réponse non-2xx devient une erreur typée ; réseau et timeout
 * deviennent `NetworkError` / `TimeoutError`, tous deux retryables.
 */
export async function postJson(url, headers, body, opts) {
    const doFetch = opts.fetch ?? globalThis.fetch;
    // Le timeout couvre aussi la lecture du flux, pas seulement les en-têtes :
    // un modèle à raisonnement peut réfléchir plusieurs minutes, et un timeout
    // trop court jette tout ce raisonnement pour recommencer de zéro au retry.
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res;
    try {
        res = await doFetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
            signal,
        });
    }
    catch (err) {
        throw toProvidallError(err, opts.context);
    }
    if (!res.ok) {
        const texte = await res.text().catch(() => "");
        throw fromHttp(res.status, extractApiMessage(texte) || `HTTP ${res.status}`, {
            ...opts.context,
            body: texte,
            retryAfterMs: retryAfterMs(res.headers),
            requestId: res.headers.get("request-id") ?? res.headers.get("x-request-id") ?? undefined,
        });
    }
    return res;
}
/**
 * Lit un flux SSE et rend chaque événement JSON.
 *
 * Trois pièges que ce parseur traite, et que les tests couvrent : un chunk
 * réseau peut couper un événement en deux, les séparateurs peuvent être CRLF,
 * et `[DONE]` n'est pas du JSON.
 */
export async function* readSse(res, context) {
    if (!res.body) {
        throw new ProvidallError("réponse sans corps de flux", { ...context, retryable: true });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let tampon = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            tampon += decoder.decode(value, { stream: true });
            tampon = tampon.replace(/\r\n/g, "\n");
            let coupure;
            while ((coupure = tampon.indexOf("\n\n")) !== -1) {
                const bloc = tampon.slice(0, coupure);
                tampon = tampon.slice(coupure + 2);
                const evenement = parseSseBlock(bloc);
                if (evenement)
                    yield evenement;
            }
        }
        const dernier = parseSseBlock(tampon);
        if (dernier)
            yield dernier;
    }
    catch (err) {
        if (err instanceof ProvidallError)
            throw err;
        const erreur = toProvidallError(err, context);
        erreur.message = `flux interrompu : ${erreur.message}`;
        throw erreur;
    }
    finally {
        await reader.cancel().catch(() => undefined);
    }
}
function parseSseBlock(bloc) {
    // Un événement peut porter plusieurs lignes `data:` à concaténer (spec SSE).
    const donnees = bloc
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
    if (!donnees || donnees === "[DONE]")
        return null;
    try {
        const parse = JSON.parse(donnees);
        return typeof parse === "object" && parse !== null ? parse : null;
    }
    catch {
        return null; // fragment non-JSON : ignoré
    }
}
