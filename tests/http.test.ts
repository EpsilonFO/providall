/** Timeout, retry, parseur SSE. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APIError,
  AuthError,
  BadRequestError,
  NotFoundError,
  ProvidallError,
  RateLimitError,
  ServerError,
  TimeoutError,
  fromHttp,
  toProvidallError,
} from "../src/errors.js";
import { backoffMs, extractApiMessage, joinUrl, postJson, readSse, retry } from "../src/http.js";
import { errorRes, jsonRes, sseRes } from "../src/testing.js";

const CTX = { provider: "p", model: "m" };

describe("fromHttp", () => {
  it.each([
    [400, BadRequestError, false],
    [401, AuthError, false],
    [403, AuthError, false],
    [404, NotFoundError, false],
    [408, APIError, true],
    [409, APIError, true],
    [422, BadRequestError, false],
    [429, RateLimitError, true],
    [500, ServerError, true],
    [503, ServerError, true],
    [529, ServerError, true], // `overloaded_error` d'Anthropic
  ])("%i", (status, classe, retryable) => {
    const erreur = fromHttp(status, "msg", CTX);
    expect(erreur).toBeInstanceOf(classe);
    expect(erreur.retryable).toBe(retryable);
    expect(erreur.status).toBe(status);
  });

  it("un 404 oriente vers l'identifiant de modèle", () => {
    // C'est presque toujours ça, pas une URL fausse.
    expect(fromHttp(404, "not found", CTX).message).toContain("identifiant de modèle");
  });
});

describe("toProvidallError", () => {
  it("timeout d'AbortSignal.timeout", () => {
    const abandon = Object.assign(new Error("le temps"), { name: "TimeoutError" });
    const erreur = toProvidallError(abandon, CTX);
    expect(erreur).toBeInstanceOf(TimeoutError);
    expect(erreur.retryable).toBe(true);
  });

  it("un abandon volontaire n'est PAS retryable", () => {
    // Sinon un `signal` annulé par l'appelant relancerait trois fois.
    const abandon = Object.assign(new Error("annulé"), { name: "AbortError" });
    expect(toProvidallError(abandon, CTX).retryable).toBe(false);
  });

  it("erreur réseau", () => {
    expect(toProvidallError(new TypeError("fetch failed"), CTX).retryable).toBe(true);
  });

  it("une erreur providall traverse intacte", () => {
    const origine = new BadRequestError("déjà typée");
    expect(toProvidallError(origine)).toBe(origine);
  });
});

describe("extractApiMessage", () => {
  it.each([
    ['{"error":{"message":"unsupported_parameter"}}', "unsupported_parameter"],
    ['{"message":"court"}', "court"],
    ['{"detail":"détail"}', "détail"],
    ["pas du json", "pas du json"],
  ])("%s", (corps, attendu) => {
    expect(extractApiMessage(corps)).toBe(attendu);
  });
});

describe("retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retente sur transitoire, rend le nombre de tentatives", async () => {
    let n = 0;
    const promesse = retry({ retries: 2 }, async () => {
      if (++n < 3) throw new ServerError("503", { status: 503 });
      return "enfin";
    });
    await vi.runAllTimersAsync();
    expect(await promesse).toEqual({ value: "enfin", attempts: 3 });
  });

  it("ne retente pas sur définitif", async () => {
    let n = 0;
    const promesse = retry({ retries: 2 }, async () => {
      n++;
      throw new BadRequestError("400", { status: 400 });
    });
    await expect(promesse).rejects.toBeInstanceOf(BadRequestError);
    expect(n).toBe(1);
  });

  it("abandonne après les retries, en gardant la dernière erreur", async () => {
    const promesse = retry({ retries: 1 }, async () => {
      throw new ServerError("503", { status: 503 });
    });
    const attendu = expect(promesse).rejects.toMatchObject({ attempts: 2, status: 503 });
    await vi.runAllTimersAsync();
    await attendu;
  });

  it("backoff linéaire, `Retry-After` prioritaire", () => {
    expect(backoffMs({ retries: 2 }, 1)).toBe(2000);
    expect(backoffMs({ retries: 2 }, 2)).toBe(4000);
    expect(backoffMs({ retries: 2 }, 1, new RateLimitError("429", { retryAfterMs: 7000 }))).toBe(
      7000,
    );
    // Un fournisseur qui demanderait dix minutes ne bloque pas l'appel.
    expect(
      backoffMs({ retries: 2 }, 1, new RateLimitError("429", { retryAfterMs: 999_999 })),
    ).toBe(30_000);
  });
});

describe("postJson", () => {
  it("relaie le corps, les en-têtes et le Content-Type", async () => {
    const appels: { url: string; init: RequestInit }[] = [];
    const faux = async (url: string, init: RequestInit) => {
      appels.push({ url, init });
      return jsonRes({ ok: true });
    };
    await postJson("https://x/v1/messages", { "x-api-key": "k" }, { a: 1 }, {
      fetch: faux,
      timeoutMs: 1000,
      context: CTX,
    });
    expect(appels[0]!.url).toBe("https://x/v1/messages");
    expect((appels[0]!.init.headers as any)["Content-Type"]).toBe("application/json");
    expect((appels[0]!.init.headers as any)["x-api-key"]).toBe("k");
    expect(JSON.parse(String(appels[0]!.init.body))).toEqual({ a: 1 });
  });

  it("un non-2xx devient une erreur typée avec le message de l'API", async () => {
    const faux = async () => errorRes(429, "trop de requêtes", { "retry-after": "3" });
    const promesse = postJson("https://x", {}, {}, { fetch: faux, timeoutMs: 1000, context: CTX });
    await expect(promesse).rejects.toMatchObject({
      name: "RateLimitError",
      status: 429,
      retryAfterMs: 3000,
      message: "trop de requêtes",
    });
  });
});

describe("readSse", () => {
  async function collecter(res: Response) {
    const vus: unknown[] = [];
    for await (const e of readSse(res, CTX)) vus.push(e);
    return vus;
  }

  it("événements simples", async () => {
    expect(await collecter(sseRes([{ a: 1 }, { b: 2 }]))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("un événement coupé en deux par le réseau est réassemblé", async () => {
    // Le cas qui casse tous les parseurs naïfs.
    expect(await collecter(sseRes([{ texte: "coupé en morceaux" }], { chunkSize: 3 }))).toEqual([
      { texte: "coupé en morceaux" },
    ]);
  });

  it("séparateurs CRLF", async () => {
    expect(await collecter(sseRes([{ a: 1 }], { crlf: true }))).toEqual([{ a: 1 }]);
  });

  it("[DONE] et fragments non-JSON sont ignorés", async () => {
    const corps = 'data: {"a":1}\n\ndata: [DONE]\n\ndata: pas du json\n\n';
    const res = new Response(corps, { headers: { "Content-Type": "text/event-stream" } });
    expect(await collecter(res)).toEqual([{ a: 1 }]);
  });

  it("un dernier événement sans séparateur final passe quand même", async () => {
    const res = new Response('data: {"a":1}');
    expect(await collecter(res)).toEqual([{ a: 1 }]);
  });

  it("une réponse sans corps est une erreur retryable", async () => {
    const res = new Response(null, { status: 200 });
    await expect(collecter(res)).rejects.toMatchObject({ retryable: true });
  });
});

describe("joinUrl", () => {
  it.each([
    ["https://x/v1", "/messages", "https://x/v1/messages"],
    ["https://x/v1/", "messages", "https://x/v1/messages"],
    ["https://x/v1//", "//messages", "https://x/v1/messages"],
  ])("%s + %s", (base, chemin, attendu) => {
    expect(joinUrl(base, chemin)).toBe(attendu);
  });
});

describe("ProvidallError", () => {
  it("le nom de la classe est le nom de l'erreur", () => {
    // Sans ça, `err.name` vaudrait « Error » partout et les logs seraient muets.
    expect(new ServerError("x").name).toBe("ServerError");
    expect(new ProvidallError("x").name).toBe("ProvidallError");
  });
});
