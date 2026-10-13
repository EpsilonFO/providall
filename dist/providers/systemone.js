/**
 * Adaptateur System One — modèles de décision (Jev, de TypeSafe).
 *
 * Pas un troisième dialecte de chat : un autre contrat. On envoie un `state`
 * et des questions typées (`noul`, `choice`, `score`), on reçoit des
 * probabilités, jamais de texte. D'où un adaptateur à part, hors de `ADAPTERS`,
 * que seul `decide()` atteint.
 *
 * Un seul format pour deux portes : TypeSafe (`api.typesafe.ai/v1/systemone`)
 * et OpenRouter (`openrouter.ai/api/v1/systemone`), qui reprend le format à
 * l'identique et ajoute `id`, `provider` et `usage.cost`. Comme les deux autres
 * adaptateurs, `build` et `parse` sont purs.
 */
import { EmptyResponseError } from "../errors.js";
import { emptyUsage, num, obj, str } from "./adapter.js";
/**
 * `…/v1` (convention providall, comme les autres fournisseurs) ou racine nue
 * (convention des SDK TypeSafe : `TYPESAFE_BASE_URL=https://openrouter.ai/api`
 * dans la doc d'OpenRouter) : les deux mènent à `…/v1/systemone`.
 */
export function systemOneUrl(base) {
    const nette = base.replace(/\/+$/, "");
    return /\/v\d+$/.test(nette) ? `${nette}/systemone` : `${nette}/v1/systemone`;
}
export function build(req) {
    const headers = {};
    if (req.apiKey)
        headers["Authorization"] = `Bearer ${req.apiKey}`;
    return {
        url: systemOneUrl(req.baseUrl),
        headers,
        body: {
            model: req.spec.modelId,
            state: req.state,
            questions: req.questions,
            ...(req.extraBody ?? {}),
        },
    };
}
/**
 * Réponse native → `Decision`. Le coût, la latence et le nombre de tentatives
 * sont posés ensuite par `decide()`, comme pour `complete()`.
 *
 * Chaque question posée doit revenir, avec le bon type : une réponse partielle
 * est traitée en réponse vide inexpliquée (rejouable), pas rendue trouée à un
 * appelant qui brancherait dessus.
 */
export function parse(raw, req, requestId = null) {
    const corps = obj(raw);
    const reponses = obj(corps["answers"]);
    const ctx = { provider: req.spec.provider, model: req.spec.alias };
    const manquantes = Object.entries(req.questions)
        .filter(([cle, q]) => obj(reponses[cle])["type"] !== q.type)
        .map(([cle]) => cle);
    if (manquantes.length) {
        throw new EmptyResponseError(`réponse System One incomplète : ${manquantes.join(", ")} absente(s) ou mal typée(s)`, ctx);
    }
    const u = obj(corps["usage"]);
    const usage = emptyUsage();
    usage.inputTokens = num(u["input_tokens"]);
    usage.outputTokens = num(u["output_tokens"]);
    const facture = u["cost"];
    return {
        answers: Object.fromEntries(Object.keys(req.questions).map((cle) => [cle, reponses[cle]])),
        usage,
        costUsd: typeof facture === "number" && Number.isFinite(facture) ? facture : null,
        latencyMs: 0,
        model: req.spec.modelId,
        servedModel: str(corps["model"], req.spec.modelId),
        alias: req.spec.alias.includes(":") ? null : req.spec.alias,
        provider: req.spec.provider,
        attempts: 1,
        requestId: requestId ?? (str(corps["id"]) || null),
        raw,
    };
}
