/** Deux adaptateurs, un par protocole. En ajouter un = ajouter une entrée ici. */
import type { Adapter } from "./adapter.js";
export declare const ADAPTERS: Map<string, Adapter>;
export declare function adapterFor(protocol: string): Adapter;
export type { Adapter, BuiltRequest, Request, StreamState } from "./adapter.js";
//# sourceMappingURL=index.d.ts.map