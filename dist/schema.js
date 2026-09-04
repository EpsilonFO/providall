/**
 * Schémas : durcissement, extraction JSON tolérante, validation Standard Schema.
 *
 * Aucun import de zod. L'interface Standard Schema (`~standard`) permet de
 * valider avec zod 4, valibot ou arktype sans qu'aucun des trois ne soit une
 * dépendance — c'est ce qui garde ce package à zéro dépendance runtime.
 *
 * Le JSON Schema à ENVOYER au fournisseur ne peut pas, lui, être dérivé de
 * Standard Schema (l'interface ne l'expose pas). L'appelant le passe donc
 * explicitement — `jsonSchema: z.toJSONSchema(MonSchema)` — et sans lui la lib
 * retombe sur schéma-dans-le-prompt + validation + réparation, qui marche.
 */
/**
 * `additionalProperties: false` partout — exigé par les sorties structurées.
 *
 * Anthropic (`output_config.format`) et OpenAI (`response_format` strict)
 * refusent tous deux un objet qui ne le déclare pas.
 */
export function harden(node) {
    if (Array.isArray(node)) {
        for (const valeur of node)
            harden(valeur);
        return node;
    }
    if (typeof node === "object" && node !== null) {
        const n = node;
        if (n["type"] === "object" || "properties" in n) {
            if (!("additionalProperties" in n))
                n["additionalProperties"] = false;
        }
        for (const valeur of Object.values(n))
            harden(valeur);
    }
    return node;
}
/**
 * Premier objet JSON d'un texte de modèle. `null` si rien d'exploitable.
 *
 * Les fournisseurs sans mode JSON natif encadrent l'objet de phrases ou de
 * balises ```json. Trois tentatives, de la plus stricte à la plus tolérante.
 */
export function parseJsonLoose(text) {
    if (!text?.trim())
        return null;
    const brut = text.trim();
    try {
        return JSON.parse(brut);
    }
    catch {
        /* on continue */
    }
    // Bloc de code balisé : ```json … ``` ou ``` … ```
    const debut = brut.indexOf("```");
    if (debut !== -1) {
        const fin = brut.indexOf("```", debut + 3);
        if (fin > debut) {
            let interieur = brut.slice(debut + 3, fin);
            const saut = interieur.indexOf("\n");
            if (saut !== -1)
                interieur = interieur.slice(saut + 1);
            try {
                return JSON.parse(interieur.trim());
            }
            catch {
                /* on continue */
            }
        }
    }
    // Plus grand bloc accoladé (ou crocheté, pour une racine de type liste).
    for (const [ouvrant, fermant] of [
        ["{", "}"],
        ["[", "]"],
    ]) {
        const i = brut.indexOf(ouvrant);
        const j = brut.lastIndexOf(fermant);
        if (i !== -1 && j > i) {
            try {
                return JSON.parse(brut.slice(i, j + 1));
            }
            catch {
                /* on continue */
            }
        }
    }
    return null;
}
/**
 * Erreurs de validation → liste que le MODÈLE peut exploiter pour se corriger.
 *
 * « Invalid input » seul ne permet à personne de se corriger : on ajoute le
 * chemin (port de `planner/llm.ts`).
 */
export function formatIssues(issues) {
    return issues
        .map((issue) => {
        const chemin = (issue.path ?? [])
            .map((segment) => typeof segment === "object" && segment !== null && "key" in segment
            ? String(segment.key)
            : String(segment))
            .join(".");
        return `- ${chemin || "(racine)"} : ${issue.message}`;
    })
        .join("\n");
}
/** Valide via Standard Schema. Accepte un validateur synchrone ou asynchrone. */
export async function validate(schema, value) {
    const resultat = await schema["~standard"].validate(value);
    if (resultat.issues)
        return { issues: formatIssues(resultat.issues) };
    return { data: resultat.value };
}
/** Un objet respecte-t-il l'interface Standard Schema ? */
export function isSchema(value) {
    return (typeof value === "object" &&
        value !== null &&
        "~standard" in value &&
        typeof value["~standard"] === "object");
}
/**
 * Bloc à coller au prompt système quand le fournisseur ne contraint pas.
 *
 * `response_format: json_object` garantit du JSON valide, PAS conforme. Sans
 * le schéma sous les yeux, le modèle omet des champs et invente des clés —
 * mesuré au premier appel réel de monumia.
 */
export function schemaInstruction(schema) {
    return ("Ta réponse doit être un objet JSON validant ce schéma, sans clé " +
        "supplémentaire et sans texte autour :\n" +
        JSON.stringify(schema, null, 1));
}
