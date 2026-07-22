import { describe, expect, it } from "bun:test";
import { DevToClient } from "../src/client.ts";
import { DevToApiError, DevToTimeoutError, type ResponseMeta } from "../src/errors.ts";
import type { DevToEvent } from "../src/events.ts";
import { resolveConfig } from "../src/http.ts";
import type { Pacer } from "../src/pacing.ts";
import {
  abortableSleep,
  eventClient,
  json,
  mockFetch,
  res429,
  stallingBodyFetch,
  stallingFetch,
  tick,
} from "./http-helpers.ts";

/**
 * The observability seam (U2/U3). Every assertion below reads `onEvent`, the
 * public seam, rather than any internal: the point of the block is that a logger
 * built on it sees each attempt, each wait and each death exactly once.
 */
describe("event stream (U3)", () => {
  const of = <K extends DevToEvent["kind"]>(
    events: DevToEvent[],
    kind: K,
  ): Extract<DevToEvent, { kind: K }>[] =>
    events.filter((e): e is Extract<DevToEvent, { kind: K }> => e.kind === kind);

  /** A pacer that always holds for `ms`, standing in for a spent per-second budget. */
  const holdingPacer = (ms: number): Pacer => ({
    acquire: async () => {
      await new Promise((r) => setTimeout(r, ms));
    },
  });

  it("reports a cached 429 as request then response, with no retry (AE1)", async () => {
    const {
      client: c,
      events,
      kinds,
    } = eventClient({}, res429(undefined, { "x-cache": "HIT, MISS" }));
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToApiError);
    expect(kinds()).toEqual(["request", "response"]);
    expect(of(events, "response")[0]?.fromCache).toBe(true);
  });

  it("names the throttle wait and carries the header's figure into the retry event", async () => {
    const {
      client: c,
      events,
      kinds,
    } = eventClient({}, res429("1", { "x-cache": "MISS" }), json([]));
    await c.request("GET", "/api/articles");
    expect(kinds()).toEqual(["request", "response", "retry", "request", "response"]);
    const [retry] = of(events, "retry");
    expect(retry?.waitMs).toBe(1000);
    expect(retry?.reason).toBe("throttle");
    const [first, second] = of(events, "request");
    expect(second?.attempt).toBe(2);
    expect(second?.callId).toBe(first?.callId as number);
  });

  it("names a 5xx backoff a server wait, carrying the computed delay", async () => {
    const {
      client: c,
      events,
      delays,
    } = eventClient({}, new Response("", { status: 502 }), json([]));
    await c.request("GET", "/api/articles");
    const [retry] = of(events, "retry");
    expect(retry?.reason).toBe("server");
    expect(retry?.waitMs).toBe(delays[0] as number);
  });

  it("emits no retry for a 5xx on a non-idempotent method", async () => {
    const { client: c, kinds } = eventClient({}, new Response("", { status: 502 }));
    await expect(c.request("POST", "/api/articles")).rejects.toBeInstanceOf(DevToApiError);
    expect(kinds()).toEqual(["request", "response"]);
  });

  it("calls a terminal 404 a response, not a failure (AE6)", async () => {
    const { client: c, kinds } = eventClient({ retry: false }, json({ error: "nope" }, 404));
    await expect(c.request("GET", "/api/articles/1")).rejects.toBeInstanceOf(DevToApiError);
    expect(kinds()).toEqual(["request", "response"]);
  });

  it("reports a dropped socket as a failure carrying the cause (AE3)", async () => {
    const { client: c, events, kinds } = eventClient({}, new Error("ECONNRESET"));
    await expect(c.request("GET", "/api/articles")).rejects.toThrow(/failed/);
    expect(kinds()).toEqual(["request", "failure"]);
    const causes = of(events, "failure").map((e) => (e.error as Error).cause as Error);
    expect(causes[0]?.message).toBe("ECONNRESET");
  });

  it("emits response then failure when the response arrives but the body does not (AE7)", async () => {
    const events: DevToEvent[] = [];
    const c = new DevToClient({
      fetch: stallingBodyFetch,
      timeoutMs: 20,
      onEvent: (e) => events.push(e),
    });
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToTimeoutError);
    expect(events.map((e) => e.kind)).toEqual(["request", "response", "failure"]);
    expect(of(events, "response")[0]?.status).toBe(200);
  });

  it("emits response then failure for a 200 whose body is not JSON", async () => {
    const {
      client: c,
      events,
      kinds,
    } = eventClient(
      {},
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(SyntaxError);
    expect(kinds()).toEqual(["request", "response", "failure"]);
    expect(of(events, "failure")[0]?.error).toBeInstanceOf(SyntaxError);
  });

  it("reports a caller abort mid-fetch as a failure and no response", async () => {
    const events: DevToEvent[] = [];
    const controller = new AbortController();
    const c = new DevToClient({
      fetch: stallingFetch,
      timeoutMs: 10_000,
      onEvent: (e) => events.push(e),
    });
    const p = c.request("GET", "/api/articles", { signal: controller.signal });
    await tick();
    controller.abort(new Error("caller stopped it"));
    await expect(p).rejects.toThrow(/caller stopped it/);
    expect(events.map((e) => e.kind)).toEqual(["request", "failure"]);
    const reasons = of(events, "failure").map((e) => (e.error as Error).message);
    expect(reasons[0]).toContain("caller stopped it");
  });

  it("does not end a call on a retry event when the caller aborts the wait (AE4)", async () => {
    const events: DevToEvent[] = [];
    const controller = new AbortController();
    const { fetch } = mockFetch(res429("1"), json([]));
    const c = new DevToClient({
      fetch,
      sleep: abortableSleep,
      onEvent: (e) => events.push(e),
    });
    const p = c.request("GET", "/api/articles", { signal: controller.signal });
    await tick();
    controller.abort(new Error("caller stopped it"));
    await expect(p).rejects.toThrow(/caller stopped it/);
    expect(events.map((e) => e.kind)).toEqual(["request", "response", "retry", "failure"]);
  });

  it("puts no retry between the response and the failure for an overshooting Retry-After", async () => {
    const { client: c, events, kinds } = eventClient({ timeoutMs: 10_000 }, res429("45"));
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToTimeoutError);
    expect(kinds()).toEqual(["request", "response", "failure"]);
    expect(of(events, "failure")[0]?.error).toBeInstanceOf(DevToTimeoutError);
  });

  it("reports a pacing hold separately from network time (AE2)", async () => {
    const { client: c, events } = eventClient({ pace: holdingPacer(30) }, json([]));
    await c.request("GET", "/api/articles");
    const [response] = of(events, "response");
    expect(response?.pacedMs).toBeGreaterThanOrEqual(25);
    expect(response?.durationMs).toBeLessThan(response?.pacedMs as number);
  });

  it("reports zero, not NaN, when the hold itself is refused past the deadline", async () => {
    const refusing: Pacer = {
      acquire: () => Promise.reject(new DevToTimeoutError("pacing would hold this read", 5000)),
    };
    const { client: c, events, kinds } = eventClient({ pace: refusing }, json([]));
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToTimeoutError);
    expect(kinds()).toEqual(["request", "failure"]);
    expect(of(events, "failure")[0]?.durationMs).toBe(0);
  });

  it("reports the hold a caller aborted mid-wait, rather than zero", async () => {
    // the hold happened; dropping it because the wait ended badly reads on the
    // failure event as a call that died instantly
    const aborting: Pacer = {
      acquire: async () => {
        await new Promise((r) => setTimeout(r, 30));
        throw new DOMException("aborted", "AbortError");
      },
    };
    const { client: c, events } = eventClient({ pace: aborting }, json([]));
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DOMException);
    expect(of(events, "failure")[0]?.pacedMs).toBeGreaterThanOrEqual(25);
  });

  it("reports the pre-fetch deadline check as a failure of an attempt that fired", async () => {
    const { client: c, kinds } = eventClient({ timeoutMs: 0 }, json([]));
    await expect(c.request("GET", "/api/articles")).rejects.toBeInstanceOf(DevToTimeoutError);
    expect(kinds()).toEqual(["request", "failure"]);
  });

  it("counts the body read inside durationMs", async () => {
    const slowBodyFetch = (() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode("[]"));
                controller.close();
              }, 30);
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof globalThis.fetch;
    const events: DevToEvent[] = [];
    const c = new DevToClient({ fetch: slowBodyFetch, onEvent: (e) => events.push(e) });
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([]);
    expect(of(events, "response")[0]?.durationMs).toBeGreaterThanOrEqual(25);
  });

  it("emits a response for a 204 and still resolves undefined", async () => {
    const { client: c, events, kinds } = eventClient({}, new Response(null, { status: 204 }));
    await expect(c.request("DELETE", "/api/articles/1")).resolves.toBeUndefined();
    expect(kinds()).toEqual(["request", "response"]);
    expect(of(events, "response")[0]?.status).toBe(204);
  });

  it("shares one callId across attempts and increments the attempt number", async () => {
    const { client: c, events } = eventClient({}, res429("1"), res429("1"), json([]));
    await c.request("GET", "/api/articles");
    expect(new Set(events.map((e) => e.callId)).size).toBe(1);
    expect(of(events, "request").map((e) => e.attempt)).toEqual([1, 2, 3]);
  });

  it("gives concurrent calls distinct callIds even under one traceId", async () => {
    const { client: c, events } = eventClient({}, json([1]), json([2]));
    await Promise.all([
      c.request("GET", "/api/articles", { traceId: "walk-1" }),
      c.request("GET", "/api/tags", { traceId: "walk-1" }),
    ]);
    expect(new Set(events.map((e) => e.callId)).size).toBe(2);
    expect(events.every((e) => e.traceId === "walk-1")).toBe(true);
  });

  it("carries a supplied traceId verbatim without displacing the callId", async () => {
    const { client: c, events } = eventClient({}, res429("1"), json([]));
    await c.request("GET", "/api/articles", { traceId: "trace/../weird id" });
    expect(events.every((e) => e.traceId === "trace/../weird id")).toBe(true);
    expect(events.every((e) => typeof e.callId === "number")).toBe(true);
  });

  it("leaves traceId undefined when none was supplied, and still numbers the call", async () => {
    const { client: c, events } = eventClient({}, json([]));
    await c.request("GET", "/api/articles");
    expect(events.every((e) => e.traceId === undefined)).toBe(true);
    expect(events.every((e) => typeof e.callId === "number")).toBe(true);
  });

  it("carries method and url on every event", async () => {
    const { client: c, events } = eventClient({}, json([]));
    await c.request("GET", "/api/articles", { query: { page: 2 } });
    expect(events.every((e) => e.method === "GET")).toBe(true);
    expect(events.every((e) => e.url === "https://dev.to/api/articles?page=2")).toBe(true);
  });

  it("hands the raw response Headers to the seam", async () => {
    const { client: c, events } = eventClient({}, json([], 200, { "x-request-id": "req-abc" }));
    await c.request("GET", "/api/articles");
    expect(of(events, "response")[0]?.headers.get("x-request-id")).toBe("req-abc");
  });
});

describe("handler composition (U2)", () => {
  it("feeds debug and onEvent both, rather than one suppressing the other (R12)", async () => {
    const seen: DevToEvent[] = [];
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const { fetch } = mockFetch(json([]));
      const c = new DevToClient({ fetch, debug: true, onEvent: (e) => seen.push(e) });
      await c.request("GET", "/api/articles");
    } finally {
      console.error = original;
    }
    expect(seen.map((e) => e.kind)).toEqual(["request", "response"]);
    expect(lines).toHaveLength(2);
  });

  it("hands onEvent every kind a call produces", async () => {
    const seen: DevToEvent[] = [];
    const { fetch } = mockFetch(res429("1"), new Error("ECONNRESET"));
    const c = new DevToClient({
      fetch,
      sleep: () => Promise.resolve(),
      onEvent: (e) => seen.push(e),
    });
    await expect(c.request("GET", "/api/articles")).rejects.toThrow(/failed/);
    expect(new Set(seen.map((e) => e.kind))).toEqual(
      new Set(["request", "response", "retry", "failure"]),
    );
  });

  it("keeps the deprecated onResponse on exactly today's payload and cadence (R13)", async () => {
    const seen: ResponseMeta[] = [];
    const { fetch } = mockFetch(res429("1"), new Error("ECONNRESET"));
    const c = new DevToClient({
      fetch,
      sleep: () => Promise.resolve(),
      onResponse: (m) => seen.push(m),
    });
    await expect(c.request("GET", "/api/articles")).rejects.toThrow(/failed/);
    // one entry, not four: request, retry and failure events reach no shim
    expect(seen).toEqual([
      {
        status: 429,
        fromCache: false,
        age: undefined,
        requestId: undefined,
        contradiction: undefined,
      },
    ]);
  });

  it("fires onResponse and onEvent together on the same response", async () => {
    const metas: number[] = [];
    const kinds: string[] = [];
    const { fetch } = mockFetch(json([]));
    const c = new DevToClient({
      fetch,
      onResponse: (m) => metas.push(m.status),
      onEvent: (e) => kinds.push(e.kind),
    });
    await c.request("GET", "/api/articles");
    expect(metas).toEqual([200]);
    expect(kinds).toEqual(["request", "response"]);
  });

  it("lets a sibling handler receive an event a throwing handler refused", async () => {
    const seen: string[] = [];
    const { fetch } = mockFetch(json([{ id: 1 }]));
    const c = new DevToClient({
      fetch,
      onEvent: () => {
        throw new Error("logger blew up");
      },
      onResponse: (m) => seen.push(`observed ${m.status}`),
    });
    await expect(c.request("GET", "/api/articles")).resolves.toEqual([{ id: 1 }]);
    expect(seen).toEqual(["observed 200"]);
  });

  it("emits into nothing when no handler is configured", () => {
    const config = resolveConfig({});
    expect(() =>
      config.emit({
        kind: "request",
        callId: 1,
        traceId: undefined,
        method: "GET",
        url: "https://dev.to/api/articles",
        attempt: 1,
      }),
    ).not.toThrow();
  });
});

describe("trace id on the ergonomic surface (U5)", () => {
  it("carries a traceId through a namespace method, not only client.request", async () => {
    const { client: c, events } = eventClient({}, json([{ id: 1 }]));
    await c.articles.list(undefined, { traceId: "job-42" });
    expect(events).not.toHaveLength(0);
    expect(events.every((e) => e.traceId === "job-42")).toBe(true);
  });

  it("carries it across every attempt of a retried namespace call", async () => {
    const { client: c, events } = eventClient({}, res429("1"), json([{ id: 1 }]));
    await c.articles.list(undefined, { traceId: "job-42" });
    expect(events.filter((e) => e.kind === "request")).toHaveLength(2);
    expect(events.every((e) => e.traceId === "job-42")).toBe(true);
  });

  it("groups an All walk under one traceId while each page keeps its own callId", async () => {
    const { client: c, events } = eventClient({}, json([{ id: 1 }]), json([]));
    for await (const _ of c.articles.listAll({ per_page: 1 }, { traceId: "walk-9" })) {
      // drain
    }
    expect(events.every((e) => e.traceId === "walk-9")).toBe(true);
    expect(new Set(events.map((e) => e.callId)).size).toBe(2);
  });

  it("still numbers each page of an untraced walk distinctly", async () => {
    const { client: c, events } = eventClient({}, json([{ id: 1 }]), json([]));
    for await (const _ of c.articles.listAll({ per_page: 1 })) {
      // drain
    }
    expect(events.every((e) => e.traceId === undefined)).toBe(true);
    expect(new Set(events.map((e) => e.callId)).size).toBe(2);
  });
});
