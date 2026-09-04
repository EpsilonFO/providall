/**
 * Types du format pivot et des réponses.
 *
 * Le pivot interne est celui de chat-completions (messages + `tool_calls`) :
 * c'est le dialecte que huit fournisseurs sur dix parlent nativement, donc
 * c'est là que la traduction coûte le moins cher. L'adaptateur Anthropic est
 * le seul à faire un vrai travail de conversion.
 *
 * Convention de nommage (identique en Python) : tout ce qui voyage sur le fil
 * — `tool_calls`, `tool_call_id`, `image_url` — garde son nom snake_case dans
 * les deux langages. Le reste suit la convention du langage.
 */
export const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
