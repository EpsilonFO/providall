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
import type { JsonSchema, Schema, StandardIssue } from "./types.js";
/**
 * `additionalProperties: false` partout — exigé par les sorties structurées.
 *
 * Anthropic (`output_config.format`) et OpenAI (`response_format` strict)
 * refusent tous deux un objet qui ne le déclare pas.
 */
export declare function harden<T>(node: T): T;
/**
 * Premier objet JSON d'un texte de modèle. `null` si rien d'exploitable.
 *
 * Les fournisseurs sans mode JSON natif encadrent l'objet de phrases ou de
 * balises ```json. Trois tentatives, de la plus stricte à la plus tolérante.
 */
export declare function parseJsonLoose<T = unknown>(text: string): T | null;
/**
 * Erreurs de validation → liste que le MODÈLE peut exploiter pour se corriger.
 *
 * « Invalid input » seul ne permet à personne de se corriger : on ajoute le
 * chemin (port de `planner/llm.ts`).
 */
export declare function formatIssues(issues: readonly StandardIssue[]): string;
export type ValidationOutcome<T> = {
    data: T;
    issues?: undefined;
} | {
    data?: undefined;
    issues: string;
};
/** Valide via Standard Schema. Accepte un validateur synchrone ou asynchrone. */
export declare function validate<T>(schema: Schema<T>, value: unknown): Promise<ValidationOutcome<T>>;
/** Un objet respecte-t-il l'interface Standard Schema ? */
export declare function isSchema(value: unknown): value is Schema<unknown>;
/**
 * Bloc à coller au prompt système quand le fournisseur ne contraint pas.
 *
 * `response_format: json_object` garantit du JSON valide, PAS conforme. Sans
 * le schéma sous les yeux, le modèle omet des champs et invente des clés —
 * mesuré au premier appel réel de monumia.
 */
export declare function schemaInstruction(schema: JsonSchema): string;
//# sourceMappingURL=schema.d.ts.map