import { afterEach, describe, expect, it, vi } from "vitest";
import { DevToClient } from "../src/client.ts";
import { DevToApiError } from "../src/errors.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Sequential fetch mock that records every call. */
function mockFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("mockFetch: no responses left");
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const client = (
  opts: ConstructorParameters<typeof DevToClient>[0] = {},
  ...responses: (Response | Error)[]
) => {
  const { fetch, calls } = mockFetch(...responses);
  return { client: new DevToClient({ fetch, ...opts }), calls };
};

afterEach(() => {
  vi.useRealTimers();
});

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

describe("retry", () => {
  it("waits for Retry-After then retries a 429 to success (AE2)", async () => {
    vi.useFakeTimers();
    const { client: c, calls } = client(
      {},
      new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      json([{ id: 1 }]),
    );
    const p = c.request("GET", "/api/articles");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual([{ id: 1 }]);
    expect(calls).toHaveLength(2);
  });

  it("retries a 429 POST too — the request was never processed", async () => {
    vi.useFakeTimers();
    const { client: c, calls } = client(
      {},
      new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      json({}, 201),
    );
    const p = c.request("POST", "/api/articles", { body: {} });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({});
    expect(calls).toHaveLength(2);
  });

  it("surfaces the typed 429 immediately when retries are disabled", async () => {
    const { client: c, calls } = client(
      { retry: false },
      new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
    );
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToApiError);
    expect(calls).toHaveLength(1);
  });

  it("surfaces the typed 429 instead of sleeping past the max-delay cap", async () => {
    const { client: c, calls } = client(
      { retry: { maxDelayMs: 5000 } },
      new Response("", { status: 429, headers: { "retry-after": "3600" } }),
    );
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToApiError);
    expect(calls).toHaveLength(1);
  });

  it("falls back to the backoff schedule on a 429 without a parseable Retry-After", async () => {
    vi.useFakeTimers();
    const { client: c, calls } = client(
      {},
      new Response("", { status: 429 }),
      new Response("", {
        status: 429,
        headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
      }),
      json([]),
    );
    const p = c.request("GET", "/api/articles");
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("rejects promptly with the abort reason when aborted mid-backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { client: c, calls } = client(
      {},
      new Response("", { status: 429, headers: { "retry-after": "10" } }),
    );
    const p = c.request("GET", "/api/articles", { signal: controller.signal });
    const rejection = expect(p).rejects.toThrow(/stop/);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new Error("stop"));
    await rejection;
    expect(calls).toHaveLength(1);
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

  it("completes the backoff normally when a signal is attached but never aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { client: c, calls } = client(
      {},
      new Response("", { status: 429, headers: { "retry-after": "1" } }),
      json([]),
    );
    const p = c.request("GET", "/api/articles", { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("normalizes a non-Error abort reason", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { client: c } = client(
      {},
      new Response("", { status: 429, headers: { "retry-after": "10" } }),
    );
    const p = c.request("GET", "/api/articles", { signal: controller.signal });
    const rejection = expect(p).rejects.toThrow(/because/);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort("because");
    await rejection;
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
    vi.useFakeTimers();
    const { client: c, calls } = client({}, new Response("", { status: 502 }), json([]));
    const p = c.request("GET", "/api/articles");
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("does not retry 5xx for POST — double-publish risk", async () => {
    const { client: c, calls } = client({}, new Response("", { status: 502 }));
    await expect(c.request("POST", "/api/articles", { body: {} })).rejects.toBeInstanceOf(
      DevToApiError,
    );
    expect(calls).toHaveLength(1);
  });

  it("exhausts the retry budget then throws", async () => {
    vi.useFakeTimers();
    const { client: c, calls } = client(
      { retry: { attempts: 3 } },
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    );
    const p = c.request("GET", "/api/articles");
    const rejection = expect(p).rejects.toBeInstanceOf(DevToApiError);
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(calls).toHaveLength(3);
  });

  it("does not retry non-retryable 4xx", async () => {
    const { client: c, calls } = client({}, json({ error: "unauthorized", status: 401 }, 401));
    await expect(c.request("GET", "/api/articles/me")).rejects.toBeInstanceOf(DevToApiError);
    expect(calls).toHaveLength(1);
  });
});
