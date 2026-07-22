import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { DevToClient } from "../src/client.ts";
import { DevToApiError, DevToTimeoutError, type ResponseMeta } from "../src/errors.ts";
import { readTransportMeta, resolveConfig } from "../src/http.ts";
import { abortReason, sleep } from "../src/timing.ts";
import { VERSION } from "../src/version.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Sequential fetch mock that records every call. */
function mockFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("mockFetch: no responses left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const client = (
  opts: ConstructorParameters<typeof DevToClient>[0] = {},
  ...responses: (Response | Error)[]
) => {
  const { fetch, calls } = mockFetch(...responses);
  return { client: new DevToClient({ fetch, ...opts }), calls };
};

/**
 * Like {@link client}, but injects an instant sleep that records the backoff
 * delays the retry loop asks for. The loop advances without real waits, and
 * `delays` lets a test assert the computed schedule directly instead of driving
 * fake timers. The real timer-backed sleep is covered by its own unit tests below.
 */
const retryClient = (
  opts: ConstructorParameters<typeof DevToClient>[0] = {},
  ...responses: (Response | Error)[]
) => {
  const { fetch, calls } = mockFetch(...responses);
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { client: new DevToClient({ fetch, sleep, ...opts }), calls, delays };
};

/**
 * A sleep that only settles when its signal aborts, rejecting with the same
 * reason the real sleep would. Lets the abort-during-backoff tests drive the
 * retry loop deterministically without real timers; the real timer-backed
 * sleep's own abort handling is covered by the "sleep" unit tests below.
 */
const abortableSleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((_resolve, reject) => {
    const fail = (): void => reject(signal ? abortReason(signal) : new Error("aborted"));
    if (signal?.aborted) return fail();
    signal?.addEventListener("abort", fail, { once: true });
  });

const res429 = (retryAfter?: string, headers: Record<string, string> = {}): Response =>
  new Response("slow down", {
    status: 429,
    headers: retryAfter === undefined ? headers : { "retry-after": retryAfter, ...headers },
  });

/** Yields to the event loop so an abort lands mid-flight rather than before the call starts. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** A fetch that resolves nothing, ever: the hang this whole deadline exists to end. */
const stallingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as typeof globalThis.fetch;

/** Headers arrive; the body never does. Aborting the request signal must still kill it. */
const stallingBodyFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  )) as typeof globalThis.fetch;

describe("construction", () => {
  it("rejects an http:// baseUrl", () => {
    expect(() => new DevToClient({ baseUrl: "http://forem.local" })).toThrow(/https/);
  });

  it("permits http:// with allowInsecureHttp", () => {
    expect(
      () => new DevToClient({ baseUrl: "http://forem.local", allowInsecureHttp: true }),
    ).not.toThrow();
  });

  it("rejects a non-http(s) baseUrl outright", () => {
    expect(() => new DevToClient({ baseUrl: "ftp://dev.to", allowInsecureHttp: true })).toThrow();
    expect(() => new DevToClient({ baseUrl: "not a url" })).toThrow();
  });
});

describe("request building", () => {
  it("carries the versioned Accept header on every request", async () => {
    const { client: c, calls } = client({}, json([]));
    await c.request("GET", "/api/articles");
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe(
      "application/vnd.forem.api-v1+json",
    );
  });

  it("forces the versioned Accept header over caller-supplied headers", async () => {
    const { client: c, calls } = client({}, json([]));
    await c.request("GET", "/api/articles", { headers: { Accept: "application/json" } });
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe(
      "application/vnd.forem.api-v1+json",
    );
  });

  it("refuses redirects when an api-key is configured, follows them keyless", async () => {
    const a = client({ apiKey: "secret" }, json([]));
    await a.client.request("GET", "/api/articles/me");
    expect(a.calls[0]?.init.redirect).toBe("error");

    const b = client({}, json([]));
    await b.client.request("GET", "/api/articles");
    expect(b.calls[0]?.init.redirect).toBeUndefined();
  });

  it("refuses redirects for an api-key supplied through headers, not just apiKey", async () => {
    // the guard used to read `config.apiKey`, so this key travelled on a
    // followable redirect straight to whatever host the server named
    const a = client({ headers: { "api-key": "secret" } }, json([]));
    await a.client.request("GET", "/api/articles/me");
    expect(a.calls[0]?.init.redirect).toBe("error");

    const b = client({}, json([]));
    await b.client.request("GET", "/api/articles", { headers: { "API-Key": "secret" } });
    expect(b.calls[0]?.init.redirect).toBe("error");
  });

  it("attaches api-key when configured, omits it otherwise", async () => {
    const a = client({ apiKey: "secret" }, json([]));
    await a.client.request("GET", "/api/articles/me");
    expect(new Headers(a.calls[0]?.init.headers).get("api-key")).toBe("secret");

    const b = client({}, json([]));
    await b.client.request("GET", "/api/articles");
    expect(new Headers(b.calls[0]?.init.headers).get("api-key")).toBeNull();
  });

  it("defaults baseUrl to https://dev.to", async () => {
    const { client: c, calls } = client({}, json([]));
    await c.request("GET", "/api/articles");
    expect(calls[0]?.url).toBe("https://dev.to/api/articles");
  });

  it("respects baseUrl override and normalizes a trailing slash", async () => {
    const { client: c, calls } = client({ baseUrl: "https://forem.example/" }, json([]));
    await c.request("GET", "/api/articles");
    expect(calls[0]?.url).toBe("https://forem.example/api/articles");
  });

  it("strips a trailing slash run without backtracking", () => {
    expect(resolveConfig({ baseUrl: `https://forem.example${"/".repeat(50)}` }).baseUrl).toBe(
      "https://forem.example",
    );
    // a slash run followed by a non-slash matches nothing; the old `\/+$` retried
    // at every slash, so this took minutes instead of microseconds
    const evil = `https://forem.example/${"/".repeat(50_000)}x`;
    const started = performance.now();
    expect(resolveConfig({ baseUrl: evil }).baseUrl).toBe(evil);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("serializes query params, dropping undefined values", async () => {
    const { client: c, calls } = client({}, json([]));
    await c.request("GET", "/api/articles", { query: { page: 2, tag: "go", top: undefined } });
    expect(calls[0]?.url).toBe("https://dev.to/api/articles?page=2&tag=go");
  });

  it("JSON-encodes the body and sets content-type", async () => {
    const { client: c, calls } = client({}, json({}, 201));
    await c.request("POST", "/api/articles", { body: { article: { title: "hi" } } });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ article: { title: "hi" } }));
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
  });

  it("keeps a caller-supplied content-type", async () => {
    const { client: c, calls } = client({}, json({}, 201));
    await c.request("POST", "/api/articles", {
      body: "raw",
      headers: { "content-type": "text/plain" },
    });
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("text/plain");
  });

  it("returns undefined for 204 responses", async () => {
    const { client: c } = client({}, new Response(null, { status: 204 }));
    await expect(c.request("PUT", "/api/articles/1/unpublish")).resolves.toBeUndefined();
  });

  it("returns undefined for a 2xx with an empty body", async () => {
    const { client: c } = client({}, new Response("", { status: 200 }));
    await expect(c.request("DELETE", "/api/reactions")).resolves.toBeUndefined();
  });
});

describe("custom headers", () => {
  it("merges client-level default headers into every request", async () => {
    const { client: c, calls } = client({ headers: { "user-agent": "my-app/1.0" } }, json([]));
    await c.request("GET", "/api/articles");
    expect(new Headers(calls[0]?.init.headers).get("user-agent")).toBe("my-app/1.0");
  });

  it("lets a per-request header override a client-level default", async () => {
    const { client: c, calls } = client({ headers: { "x-trace": "default" } }, json([]));
    await c.request("GET", "/api/articles", { headers: { "x-trace": "override" } });
    expect(new Headers(calls[0]?.init.headers).get("x-trace")).toBe("override");
  });

  it("never lets a client-level header displace the versioned Accept", async () => {
    const { client: c, calls } = client({ headers: { accept: "application/json" } }, json([]));
    await c.request("GET", "/api/articles");
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe(
      "application/vnd.forem.api-v1+json",
    );
  });

  it("overrides a client-level header whose name is cased differently", async () => {
    // header names are case-insensitive on the wire but not to an object spread,
    // so both entries used to survive the merge and Headers comma-joined them
    const { client: c, calls } = client({ headers: { "X-Trace": "default" } }, json([]));
    await c.request("GET", "/api/articles", { headers: { "x-trace": "override" } });
    expect(new Headers(calls[0]?.init.headers).get("x-trace")).toBe("override");
  });
});

describe("user-agent", () => {
  it("sends devto-client/<version> by default", async () => {
    const { client: c, calls } = client({}, json([]));
    await c.request("GET", "/api/articles");
    expect(new Headers(calls[0]?.init.headers).get("user-agent")).toBe(`devto-client/${VERSION}`);
  });

  it("lets a client-level user-agent replace the default rather than append to it", async () => {
    const { client: c, calls } = client({ headers: { "user-agent": "my-app/1.0" } }, json([]));
    await c.request("GET", "/api/articles");
    expect(new Headers(calls[0]?.init.headers).get("user-agent")).toBe("my-app/1.0");
  });

  it("lets a per-request user-agent replace a client-level one", async () => {
    const { client: c, calls } = client({ headers: { "user-agent": "my-app/1.0" } }, json([]));
    await c.request("GET", "/api/articles", { headers: { "user-agent": "my-app/1.0 batch" } });
    expect(new Headers(calls[0]?.init.headers).get("user-agent")).toBe("my-app/1.0 batch");
  });

  it("matches a differently-cased caller header instead of sending both (AE5)", async () => {
    const { client: c, calls } = client({ headers: { "User-Agent": "my-app/1.0" } }, json([]));
    await c.request("GET", "/api/articles");
    expect(new Headers(calls[0]?.init.headers).get("user-agent")).toBe("my-app/1.0");
  });

  it("keeps accept and api-key winning over caller headers, unlike user-agent (AE5)", async () => {
    const { client: c, calls } = client(
      { apiKey: "secret", headers: { "user-agent": "my-app/1.0" } },
      json([]),
    );
    await c.request("GET", "/api/articles/me", {
      headers: { accept: "application/json", "api-key": "smuggled" },
    });
    const sent = new Headers(calls[0]?.init.headers);
    expect(sent.get("user-agent")).toBe("my-app/1.0"); // caller wins
    expect(sent.get("accept")).toBe("application/vnd.forem.api-v1+json"); // library wins
    expect(sent.get("api-key")).toBe("secret"); // library wins
  });

  it("agrees with package.json, guarding release-please extra-files drift", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe("errors", () => {
  it("maps a JSON {error, status} body onto DevToApiError", async () => {
    const { client: c } = client({ retry: false }, json({ error: "not found", status: 404 }, 404));
    const err = await c.request("GET", "/api/articles/999").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevToApiError);
    const apiErr = err as DevToApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.body).toEqual({ error: "not found", status: 404 });
    expect(apiErr.message).toContain("not found");
  });

  it("preserves a plain-text 429 body as raw text", async () => {
    const { client: c } = client({ retry: false }, new Response("Retry later\n", { status: 429 }));
    const err = (await c.request("GET", "/api/articles").catch((e: unknown) => e)) as DevToApiError;
    expect(err.status).toBe(429);
    expect(err.body).toBeUndefined();
    expect(err.rawBody).toBe("Retry later\n");
  });

  it("yields a coherent error for a hand-rolled 400 without a status field", async () => {
    const { client: c } = client({ retry: false }, json({ error: "q parameter is required" }, 400));
    const err = (await c
      .request("GET", "/api/articles/semantic_search")
      .catch((e: unknown) => e)) as DevToApiError;
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ error: "q parameter is required" });
    expect(err.message).toContain("q parameter is required");
  });

  it("treats a non-envelope JSON error body as raw text", async () => {
    const { client: c } = client({ retry: false }, json({ message: ["boom"] }, 422));
    const err = (await c
      .request("PUT", "/api/articles/1/unpublish")
      .catch((e: unknown) => e)) as DevToApiError;
    expect(err.status).toBe(422);
    expect(err.body).toBeUndefined();
    expect(err.rawBody).toBe(JSON.stringify({ message: ["boom"] }));
  });

  it("wraps a network-level rejection with the original as cause", async () => {
    const boom = new TypeError("fetch failed");
    const { client: c } = client({ retry: false }, boom);
    const err = (await c.request("GET", "/api/articles").catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(DevToApiError);
    expect(err.cause).toBe(boom);
    expect(err.message).toContain("GET https://dev.to/api/articles");
  });
});

describe("sleep", () => {
  it("resolves after the delay without a signal", async () => {
    await expect(sleep(1, undefined)).resolves.toBeUndefined();
  });

  it("resolves after the delay with a signal that never aborts", async () => {
    const controller = new AbortController();
    await expect(sleep(1, controller.signal)).resolves.toBeUndefined();
  });

  it("rejects with an Error abort reason when the signal aborts first", async () => {
    const controller = new AbortController();
    const p = sleep(10_000, controller.signal);
    controller.abort(new Error("boom"));
    await expect(p).rejects.toThrow(/boom/);
  });

  it("normalizes a non-Error abort reason into an Error", async () => {
    const controller = new AbortController();
    const p = sleep(10_000, controller.signal);
    controller.abort("because");
    await expect(p).rejects.toThrow(/because/);
  });
});

describe("retry", () => {
  it("waits for Retry-After then retries a 429 to success", async () => {
    const { client: c, calls, delays } = retryClient({}, res429("1"), json([{ id: 1 }]));
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([{ id: 1 }]);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([1000]); // honored the 1-second Retry-After
  });

  it("retries a 429 POST too, the request was never processed", async () => {
    // pace: false isolates the retry wait: a second write inside a second would
    // otherwise draw a pacing hold too, which the pacing suite covers on its own
    const { client: c, calls, delays } = retryClient({ pace: false }, res429("1"), json({}, 201));
    await expect(c.request("POST", "/api/articles", { body: {} })).resolves.toEqual({});
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([1000]);
  });

  it("surfaces the typed 429 immediately when retries are disabled", async () => {
    const { client: c, calls } = client({ retry: false }, res429("1"));
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToApiError);
    expect(calls).toHaveLength(1);
  });

  it("falls back to the throttle schedule on a 429 without a parseable Retry-After", async () => {
    const {
      client: c,
      calls,
      delays,
    } = retryClient({}, res429(), res429("Wed, 21 Oct 2026 07:28:00 GMT"), json([]));
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
    // Both fell back to the flat throttle wait: a fixed server window has
    // nothing for an exponential schedule to grow into.
    expect(delays).toEqual([5000, 5000]);
  });

  it("surfaces the abort reason out of the retry loop, skipping the retry", async () => {
    const controller = new AbortController();
    const { client: c, calls } = client({ sleep: abortableSleep }, res429("10"));
    const p = c.request("GET", "/api/articles", { signal: controller.signal });
    await tick(); // let the first attempt land and the backoff start
    controller.abort(new Error("stop"));
    await expect(p).rejects.toThrow(/stop/);
    expect(calls).toHaveLength(1); // no second attempt after the abort
  });

  it("rejects without calling fetch when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    const { client: c, calls } = client({}, json([]));
    await expect(c.request("GET", "/api/articles", { signal: controller.signal })).rejects.toThrow(
      /pre-aborted/,
    );
    expect(calls).toHaveLength(0);
  });

  it("completes a real backoff and retries when a signal is attached but never aborts", async () => {
    // No injected sleep here: this drives the production timer-backed sleep
    // inside the retry loop with a non-aborting signal (baseDelayMs: 1 keeps it
    // to a sub-millisecond real wait), covering the loop+sleep composition the
    // injected-sleep tests above deliberately bypass.
    const controller = new AbortController();
    const { client: c, calls } = client(
      { retry: { baseDelayMs: 1 } },
      new Response("", { status: 502 }),
      json([]),
    );
    await expect(c.request("GET", "/api/articles", { signal: controller.signal })).resolves.toEqual(
      [],
    );
    expect(calls).toHaveLength(2);
  });

  it("surfaces the abort reason when fetch itself rejects on abort", async () => {
    const controller = new AbortController();
    const { fetch } = mockFetch();
    const abortingFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      controller.abort(new Error("mid-flight abort"));
      return fetch(url, init);
    }) as typeof globalThis.fetch;
    const c = new DevToClient({ fetch: abortingFetch });
    await expect(c.request("GET", "/api/articles", { signal: controller.signal })).rejects.toThrow(
      /mid-flight abort/,
    );
  });

  it("retries 5xx for GET", async () => {
    const {
      client: c,
      calls,
      delays,
    } = retryClient({}, new Response("", { status: 502 }), json([]));
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1); // one backoff before the retry
  });

  it("classifies a lowercase method the same as an uppercase one", async () => {
    // the escape hatch takes the method verbatim, and both the retry set and the
    // pacing set hold canonical names
    const { client: c, calls } = retryClient({}, new Response("", { status: 502 }), json([]));
    await expect(c.request("get", "/api/articles")).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("does not retry 5xx for POST: double-publish risk", async () => {
    const { client: c, calls } = client({}, new Response("", { status: 502 }));
    await expect(c.request("POST", "/api/articles", { body: {} })).rejects.toBeInstanceOf(
      DevToApiError,
    );
    expect(calls).toHaveLength(1);
  });

  it("exhausts the retry budget then throws", async () => {
    const {
      client: c,
      calls,
      delays,
    } = retryClient(
      { retry: { attempts: 3 } },
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    );
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToApiError);
    expect(calls).toHaveLength(3);
    expect(delays).toHaveLength(2); // slept between the three attempts
  });

  it("does not retry non-retryable 4xx", async () => {
    const { client: c, calls } = client({}, json({ error: "unauthorized", status: 401 }, 401));
    await expect(c.request("GET", "/api/articles/me")).rejects.toBeInstanceOf(DevToApiError);
    expect(calls).toHaveLength(1);
  });
});

describe("transport metadata (U1)", () => {
  it("reads x-cache, age and x-request-id off the headers", () => {
    const meta = readTransportMeta(
      new Response("", {
        status: 429,
        headers: { "x-cache": "HIT, MISS", age: "104", "x-request-id": "req-abc" },
      }),
    );
    expect(meta).toEqual({
      status: 429,
      fromCache: true,
      age: 104,
      requestId: "req-abc",
      contradiction: undefined,
    });
  });

  it("treats a HIT at either tier as cache-served (KTD6)", () => {
    const at = (xCache: string): boolean =>
      readTransportMeta(new Response("", { headers: { "x-cache": xCache } })).fromCache;
    expect(at("HIT, MISS")).toBe(true);
    expect(at("MISS, HIT")).toBe(true);
    expect(at("MISS, MISS")).toBe(false);
  });

  it("reads fromCache false when there is no x-cache header at all", () => {
    // a self-hosted Forem behind no CDN, degrades to today's behavior
    expect(readTransportMeta(new Response("")).fromCache).toBe(false);
  });

  it("yields undefined rather than NaN for a missing or non-numeric age", () => {
    expect(readTransportMeta(new Response("")).age).toBeUndefined();
    expect(readTransportMeta(new Response("", { headers: { age: "soon" } })).age).toBeUndefined();
    expect(readTransportMeta(new Response("", { headers: { age: "0" } })).age).toBe(0);
  });

  it("throws a cached 429 on the first attempt, carrying all three fields (AE1)", async () => {
    const { client: c, calls } = client(
      {},
      res429(undefined, { "x-cache": "HIT, MISS", age: "104", "x-request-id": "req-abc" }),
    );
    const err = (await c.request("GET", "/api/articles").catch((e: unknown) => e)) as DevToApiError;
    expect(err).toBeInstanceOf(DevToApiError);
    expect(calls).toHaveLength(1); // no second attempt: the replay cannot be won
    expect(err.fromCache).toBe(true);
    expect(err.age).toBe(104);
    expect(err.requestId).toBe("req-abc");
  });

  it("retries an origin 429 exactly as it does today", async () => {
    const { client: c, calls } = retryClient(
      {},
      res429("1", { "x-cache": "MISS, MISS" }),
      json([{ id: 1 }]),
    );
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([{ id: 1 }]);
    expect(calls).toHaveLength(2);
  });

  it("retries a 429 with no x-cache header", async () => {
    const { client: c, calls } = retryClient({}, res429("1"), json([]));
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a MISS, HIT 429 either", async () => {
    const { client: c, calls } = client({}, res429("1", { "x-cache": "MISS, HIT" }));
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToApiError);
    expect(calls).toHaveLength(1);
  });

  it("still retries a cached 500 on an idempotent GET: R3 covers 429 only", async () => {
    const { client: c, calls } = retryClient(
      {},
      new Response("", { status: 500, headers: { "x-cache": "HIT, MISS" } }),
      json([]),
    );
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([]);
    expect(calls).toHaveLength(2); // a short-TTL cached 5xx can recover
  });

  it("reports a cached 200 to the observer and still returns the body (AE7)", async () => {
    const seen: ResponseMeta[] = [];
    const { client: c } = client(
      { onResponse: (m) => seen.push(m) },
      json([{ id: 1 }], 200, { "x-cache": "MISS, HIT", age: "33", "x-request-id": "req-xyz" }),
    );
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([{ id: 1 }]);
    expect(seen).toEqual([
      { status: 200, fromCache: true, age: 33, requestId: "req-xyz", contradiction: undefined },
    ]);
  });

  it("fires the observer on failed calls too, before the error is thrown", async () => {
    const order: string[] = [];
    const { client: c } = client(
      { retry: false, onResponse: (m) => order.push(`observed ${m.status}`) },
      json({ error: "nope", status: 404 }, 404),
    );
    await c.request("GET", "/api/articles/1").catch(() => order.push("threw"));
    expect(order).toEqual(["observed 404", "threw"]);
  });

  it("fires the observer once per attempt across a retry", async () => {
    const seen: number[] = [];
    const { client: c } = retryClient(
      { onResponse: (m) => seen.push(m.status) },
      res429("1"),
      json([]),
    );
    await c.request("GET", "/api/articles");
    expect(seen).toEqual([429, 200]);
  });

  it("survives a throwing observer without corrupting the result", async () => {
    const { client: c } = client(
      {
        onResponse: () => {
          throw new Error("observer blew up");
        },
      },
      json([{ id: 7 }]),
    );
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([{ id: 7 }]);
  });

  it("survives an async observer that rejects", async () => {
    // a rejected promise from the observer is invisible to a synchronous catch,
    // and an unhandled rejection ends the process on Node's default
    const rejections: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      rejections.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { client: c } = client(
        { onResponse: async () => await Promise.reject(new Error("observer blew up")) },
        json([{ id: 7 }]),
      );
      await expect(c.request("GET", "/api/articles")).resolves.toEqual([{ id: 7 }]);
      await new Promise((r) => setTimeout(r, 10)); // let any rejection surface
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

/**
 * The contradiction detectors (U2/U3). Every case is decided from a stubbed
 * `Response`'s headers: no test below reads a body to reach a verdict, which is
 * what keeps detection ahead of the retry decision (R7).
 */
describe("contradiction detection (U2)", () => {
  /** Forem's v0 deprecation marker, verbatim from a dev.to response. */
  const V0_WARNING =
    "299 - This endpoint is part of the V0 (beta) API. To start using the V1 endpoints add the `Accept` header and set it to `application/vnd.forem.api-v1+json`.";
  const HIT = { "x-cache": "MISS, HIT" };
  const res = (status: number, headers: Record<string, string>): Response =>
    new Response("{}", { status, headers });
  const flagOn = (status: number, headers: Record<string, string>, ...args: boolean[]) =>
    readTransportMeta(res(status, headers), ...(args as [boolean?, boolean?])).contradiction;

  it("flags the v0 marker cached or fresh, and ignores an unrelated warning", () => {
    expect(flagOn(200, { warning: V0_WARNING, ...HIT })).toBe("v0-under-v1");
    // fresh matters most: a v0 body from the origin is the worse bug, not a lesser one
    expect(flagOn(200, { warning: V0_WARNING, "x-cache": "MISS, MISS" })).toBe("v0-under-v1");
    expect(flagOn(200, { warning: '199 - "miscellaneous warning"', ...HIT })).toBeUndefined();
  });

  it("flags a cached 404 only for an operation in the never-404 set", () => {
    expect(flagOn(404, HIT, false, true)).toBe("impossible-404");
    expect(flagOn(404, HIT, false, false)).toBeUndefined();
    // the genuine not-found the R4 narrowing exists for: credentialed, cached, not in the set
    expect(flagOn(404, HIT, true, false)).toBeUndefined();
  });

  it("flags a cached refusal only when the request carried a credential", () => {
    expect(flagOn(401, HIT, true)).toBe("credentialed-refusal");
    expect(flagOn(403, HIT, true)).toBe("credentialed-refusal");
    expect(flagOn(401, HIT, false)).toBeUndefined();
    // the real privilege gates on /api/badges and /api/surveys: origin-served, so quiet
    expect(flagOn(401, { "x-cache": "MISS, MISS" }, true)).toBeUndefined();
    expect(flagOn(401, {}, true)).toBeUndefined();
  });

  it("reports the strongest evidence when more than one detector could fire", () => {
    expect(flagOn(401, { warning: V0_WARNING, ...HIT }, true)).toBe("v0-under-v1");
    expect(flagOn(404, HIT, true, true)).toBe("impossible-404");
  });

  it("reaches an observer on a 200 and a caught error on a 401, with the same value", async () => {
    const seen: (string | undefined)[] = [];
    const { client: c } = client(
      { apiKey: "k", onResponse: (m) => seen.push(m.contradiction) },
      json([{ id: 1 }], 200, { warning: V0_WARNING }),
      json({ error: "unauthorized" }, 401, HIT),
    );
    await c.request("GET", "/api/articles");
    const err = (await c.request("GET", "/api/users/me").catch((e: unknown) => e)) as DevToApiError;
    expect(seen).toEqual(["v0-under-v1", "credentialed-refusal"]);
    expect(err.contradiction).toBe("credentialed-refusal");
  });

  it("counts a key supplied through per-request headers as a credential", async () => {
    const { client: c } = client({}, json({ error: "unauthorized" }, 401, HIT));
    const err = (await c
      .request("GET", "/api/users/me", { headers: { "api-key": "k" } })
      .catch((e: unknown) => e)) as DevToApiError;
    expect(err.contradiction).toBe("credentialed-refusal");
  });

  it("changes nothing else: same value, same error, same request count (R6)", async () => {
    const { client: c, calls } = client(
      { apiKey: "k" },
      json([{ id: 1 }], 200, { warning: V0_WARNING, ...HIT }),
    );
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([{ id: 1 }]);
    expect(calls).toHaveLength(1);

    // a flagged 429 is still not retried, and a flagged 401 still throws
    const { client: d, calls: dCalls } = retryClient({ apiKey: "k" }, res429("1", HIT));
    await expect(d.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToApiError);
    expect(dCalls).toHaveLength(1);
  });
});

describe("the escape-hatch boundary (U3)", () => {
  const HIT = { "x-cache": "MISS, HIT" };
  const notFound = (): Response => json({ error: "not found" }, 404, HIT);
  const thrown = async (call: Promise<unknown>): Promise<DevToApiError> =>
    (await call.catch((e: unknown) => e)) as DevToApiError;

  it("surfaces impossible-404 for a namespace method whose op is in the set", async () => {
    const { client: c } = client({ apiKey: "k" }, notFound());
    expect((await thrown(c.tags.list())).contradiction).toBe("impossible-404");
  });

  it("stays quiet for a namespace method whose op is not in the set", async () => {
    // /api/comments declares a 404 upstream, so it is never a candidate
    const { client: c } = client({ apiKey: "k" }, notFound());
    expect((await thrown(c.comments.list({ a_id: "1" }))).contradiction).toBeUndefined();
  });

  it("withholds detector two from client.request, and keeps detector three there", async () => {
    const { client: c } = client({ apiKey: "k" }, notFound(), json({ error: "no" }, 401, HIT));
    expect((await thrown(c.request("GET", "/api/tags"))).contradiction).toBeUndefined();
    expect((await thrown(c.request("GET", "/api/tags"))).contradiction).toBe(
      "credentialed-refusal",
    );
  });

  it("carries the same resolution into an iterator's pages", async () => {
    const { client: c } = client({ apiKey: "k" }, json([{ id: 1 }], 200), notFound());
    const iterator = c.tags.listAll();
    await iterator.next();
    const err = (await iterator.next().catch((e: unknown) => e)) as DevToApiError;
    expect(err.contradiction).toBe("impossible-404");
  });
});

describe("call deadline (U2)", () => {
  it("rejects a never-settling fetch instead of hanging forever", async () => {
    const c = new DevToClient({ fetch: stallingFetch, timeoutMs: 20 });
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToTimeoutError);
  });

  it("rejects when headers arrive but the body never completes", async () => {
    // the controller stays armed past fetch's resolution (KTD1): tearing it down
    // when fetch settles would leave this stream unbounded
    const c = new DevToClient({ fetch: stallingBodyFetch, timeoutMs: 20 });
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToTimeoutError);
  });

  it("treats a timeout past the 32-bit timer ceiling as no deadline, not an instant one", async () => {
    // setTimeout coerces an out-of-range or non-finite delay to 1ms, which would
    // turn the most patient setting available into the least patient one
    const slowFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(json([{ id: 1 }])), 30);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      })) as unknown as typeof globalThis.fetch;
    const c = new DevToClient({ fetch: slowFetch, timeoutMs: 3_000_000_000, pace: false });
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([{ id: 1 }]);
  });

  it("surfaces the caller's reason when they abort a stalled body read", async () => {
    const controller = new AbortController();
    const c = new DevToClient({ fetch: stallingBodyFetch, timeoutMs: 10_000 });
    const p = c.request("GET", "/api/articles", { signal: controller.signal });
    await tick(); // let the request reach the stalled body before aborting
    controller.abort(new Error("caller stopped it"));
    await expect(p).rejects.toThrow(/caller stopped it/);
  });

  it("keeps a caller abort distinguishable from a deadline expiry", async () => {
    const controller = new AbortController();
    const c = new DevToClient({ fetch: stallingFetch, timeoutMs: 10_000 });
    const p = c.request("GET", "/api/articles", { signal: controller.signal });
    await tick(); // mid-flight, not before the request left
    controller.abort(new Error("caller stopped it"));
    const err = (await p.catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(DevToTimeoutError);
    expect(err.message).toContain("caller stopped it");
  });

  it("lets a per-request timeoutMs override the client default", async () => {
    const c = new DevToClient({ fetch: stallingFetch, timeoutMs: 10_000 });
    await expect(c.request("GET", "/api/articles", { timeoutMs: 20 })).rejects.toBeInstanceOf(
      DevToTimeoutError,
    );
  });

  it("throws without a further fetch once the budget is spent", async () => {
    // a real 60ms backoff against a 50ms deadline: the second attempt never happens
    const slowSleep = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
    const { client: c, calls } = client({ timeoutMs: 50, sleep: slowSleep }, res429("0"), json([]));
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToTimeoutError);
    expect(calls).toHaveLength(1);
  });

  it("shares one budget across attempts rather than resetting per attempt", async () => {
    const slowSleep = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
    const { client: c, calls } = client(
      { timeoutMs: 50, retry: { attempts: 5 }, sleep: slowSleep },
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    );
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToTimeoutError);
    expect(calls.length).toBeLessThan(5); // the budget ran out before the attempts did
  });

  it("holds the redirect-leak guard on every attempt, not just the first", async () => {
    // init is now rebuilt per attempt (KTD1), so asserting calls[0] no longer generalizes
    const { client: c, calls } = retryClient({ apiKey: "secret" }, res429("1"), json([]));
    await c.request("GET", "/api/articles/me");
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.init.redirect).toBe("error");
  });

  it("leaves no armed timer behind a successful call", async () => {
    const { fetch } = mockFetch(json([1]), json([2]));
    const c = new DevToClient({ fetch, timeoutMs: 30 });
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([1]);
    await new Promise((r) => setTimeout(r, 50)); // outlive the first call's deadline
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([2]);
  });
});

describe("retry patience (U3)", () => {
  it("sleeps a 45-second Retry-After when the budget allows it (AE2)", async () => {
    const { client: c, calls, delays } = retryClient({ timeoutMs: 90_000 }, res429("45"), json([]));
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([]);
    expect(delays).toEqual([45_000]); // the removed per-wait ceiling used to throw here
    expect(calls).toHaveLength(2);
  });

  it("fails fast on a Retry-After past the deadline, naming the declined wait (AE3)", async () => {
    const { client: c, calls } = client({ timeoutMs: 10_000 }, res429("45"));
    const err = (await c
      .request("GET", "/api/articles")
      .catch((e: unknown) => e)) as DevToTimeoutError;
    expect(err).toBeInstanceOf(DevToTimeoutError);
    expect(err.declinedWaitMs).toBe(45_000);
    expect(calls).toHaveLength(1);
  });

  it("fits a full throttle wait plus a following attempt in the stock deadline (AE6)", async () => {
    const { client: c, calls, delays } = retryClient({}, res429(), json([]));
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([]);
    expect(delays).toEqual([5000]); // full, unclamped: R5's 30s default has room
    expect(calls).toHaveLength(2);
  });

  it("clamps an oversized self-generated wait to the budget and still retries (R18)", async () => {
    const {
      client: c,
      calls,
      delays,
    } = retryClient(
      { timeoutMs: 30_000, retry: { baseDelayMs: 100_000 } },
      new Response("", { status: 502 }),
      json([]),
    );
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([]);
    expect(calls).toHaveLength(2); // clamped, not refused: raising attempts still works
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[0]).toBeLessThanOrEqual(30_000);
  });

  it("keeps 5xx on the baseDelayMs schedule, separate from the throttle wait", async () => {
    const { client: c, delays } = retryClient(
      {},
      new Response("", { status: 502 }),
      new Response("", { status: 502 }),
      json([]),
    );
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([]);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeLessThanOrEqual(500); // base 500, jitter in [0.5, 1)
    expect(delays[1]).toBeLessThanOrEqual(1000);
    expect(delays[1]).toBeGreaterThan(delays[0] as number);
  });
});
