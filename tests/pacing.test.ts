import { describe, expect, it } from "bun:test";
import { DevToClient } from "../src/client.ts";
import { DevToTimeoutError } from "../src/errors.ts";
import { createPacer } from "../src/pacing.ts";
import { abortReason } from "../src/timing.ts";

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A fetch that answers everything with `body` and counts the calls. */
function countingFetch(body: unknown = []) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return json(body);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** An instant sleep that records what it was asked to wait for. */
function recordingSleep() {
  const waits: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    waits.push(ms);
    return Promise.resolve();
  };
  return { sleep, waits };
}

/** Never settles until its signal aborts — lets a pacing hold be interrupted deterministically. */
const abortableSleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((_resolve, reject) => {
    const fail = (): void => reject(signal ? abortReason(signal) : new Error("aborted"));
    if (signal?.aborted) return fail();
    signal?.addEventListener("abort", fail, { once: true });
  });

const get = async (c: DevToClient, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await c.request("GET", "/api/articles");
};

describe("pacing", () => {
  it("lets a script inside the budget run without waiting at all", async () => {
    const { fetch } = countingFetch();
    const { sleep, waits } = recordingSleep();
    await get(new DevToClient({ fetch, sleep }), 3); // capacity is the per-second allowance
    expect(waits).toEqual([]);
  });

  it("holds the fourth read for a refill interval", async () => {
    const { fetch } = countingFetch();
    const { sleep, waits } = recordingSleep();
    await get(new DevToClient({ fetch, sleep }), 4);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeCloseTo(334, -1); // one token at 3/s
  });

  it("lands a default-paced wait in the client's own sleep seam", async () => {
    // proves the implicitly-constructed pacer inherits ClientOptions.sleep (KTD4)
    const { fetch } = countingFetch();
    const { sleep, waits } = recordingSleep();
    await get(new DevToClient({ fetch, sleep }), 4);
    expect(waits).toHaveLength(1);
  });

  it("waits through an external pacer's own sleep, leaving the client's untouched", async () => {
    const { fetch } = countingFetch();
    const client = recordingSleep();
    const pacer = recordingSleep();
    await get(
      new DevToClient({ fetch, sleep: client.sleep, pace: createPacer({ sleep: pacer.sleep }) }),
      4,
    );
    expect(pacer.waits).toHaveLength(1);
    expect(client.waits).toEqual([]);
  });

  it("draws writes from a separate budget, so a POST does not delay a read", async () => {
    const { fetch } = countingFetch({});
    const { sleep, waits } = recordingSleep();
    const c = new DevToClient({ fetch, sleep });
    await c.request("POST", "/api/articles", { body: {} });
    await get(c, 3); // the full read allowance is still there
    expect(waits).toEqual([]);
  });

  it("holds a second write for the 1/s write budget", async () => {
    const { fetch } = countingFetch({});
    const { sleep, waits } = recordingSleep();
    const c = new DevToClient({ fetch, sleep });
    await c.request("POST", "/api/articles", { body: {} });
    await c.request("POST", "/api/articles", { body: {} });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeCloseTo(1000, -2);
  });

  it("records no waits at all with pace: false", async () => {
    const { fetch, calls } = countingFetch();
    const { sleep, waits } = recordingSleep();
    await get(new DevToClient({ fetch, sleep, pace: false }), 10);
    expect(waits).toEqual([]);
    expect(calls).toHaveLength(10);
  });

  it("shares one budget between two clients given the same pacer", async () => {
    const { fetch } = countingFetch();
    const { sleep, waits } = recordingSleep();
    const pace = createPacer({ sleep });
    await get(new DevToClient({ fetch, pace }), 2);
    await get(new DevToClient({ fetch, pace }), 2);
    expect(waits).toHaveLength(1); // the fourth read across both clients
  });

  it("keeps independent pacers free of cross-talk", async () => {
    const { fetch } = countingFetch();
    const a = recordingSleep();
    const b = recordingSleep();
    await get(new DevToClient({ fetch, pace: createPacer({ sleep: a.sleep }) }), 3);
    await get(new DevToClient({ fetch, pace: createPacer({ sleep: b.sleep }) }), 3);
    expect(a.waits).toEqual([]);
    expect(b.waits).toEqual([]);
  });

  it("fails a pacing hold that would land past the deadline (AE4)", async () => {
    const { fetch, calls } = countingFetch();
    const { sleep } = recordingSleep();
    const c = new DevToClient({
      fetch,
      sleep,
      timeoutMs: 100,
      pace: createPacer({ readsPerSecond: 1 }),
    });
    await c.request("GET", "/api/articles");
    const err = (await c
      .request("GET", "/api/articles")
      .catch((e: unknown) => e)) as DevToTimeoutError;
    expect(err).toBeInstanceOf(DevToTimeoutError);
    expect(err.declinedWaitMs).toBeCloseTo(1000, -2);
    expect(calls).toHaveLength(1); // the second request never went out
  });

  it("rejects with the caller's reason when aborted during a pacing hold", async () => {
    const { fetch, calls } = countingFetch();
    const c = new DevToClient({
      fetch,
      pace: createPacer({ readsPerSecond: 1, sleep: abortableSleep }),
    });
    await c.request("GET", "/api/articles");
    const controller = new AbortController();
    const p = c.request("GET", "/api/articles", { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(new Error("caller stopped it"));
    await expect(p).rejects.toThrow(/caller stopped it/);
    expect(calls).toHaveLength(1);
  });

  it("cuts a hold short on the pacer's own default sleep, with no seam injected", async () => {
    // a hold that ignored the signal would still reject, just a full second later,
    // so promptness is the only thing that tells the two apart
    const { fetch } = countingFetch();
    const c = new DevToClient({ fetch, pace: createPacer({ readsPerSecond: 1 }) });
    await c.request("GET", "/api/articles");
    const controller = new AbortController();
    const started = Date.now();
    const p = c.request("GET", "/api/articles", { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort(new Error("caller stopped it"));
    await expect(p).rejects.toThrow(/caller stopped it/);
    expect(Date.now() - started).toBeLessThan(500); // the hold was 1000ms
  });

  it("hands the slot back when an abort interrupts the hold", async () => {
    // the token was never spent on a request, and a shared pacer that kept it
    // would shrink its budget a little on every cancellation
    const waits: number[] = [];
    const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
      waits.push(ms);
      return signal?.aborted ? Promise.reject(abortReason(signal)) : Promise.resolve();
    };
    const pace = createPacer({ readsPerSecond: 1, sleep });
    const far = { deadlineAt: Date.now() + 60_000, signal: undefined };

    await pace.acquire("read", far); // the free starting token
    const aborted = new AbortController();
    aborted.abort(new Error("stop"));
    await expect(
      pace.acquire("read", { deadlineAt: far.deadlineAt, signal: aborted.signal }),
    ).rejects.toThrow(/stop/);
    await pace.acquire("read", far);

    // one interval, not two: the refused hold gave its slot back
    expect(waits.at(-1)).toBeLessThan(1500);
  });

  it("gives a sub-1/s bucket a whole token to start with", async () => {
    // capacity used to equal the rate, so at 0.5/s the bucket never held one
    // whole token and even the very first call had to wait for a refill
    const { fetch } = countingFetch();
    const { sleep, waits } = recordingSleep();
    // the sleep goes to the pacer, not the client: an externally built pacer
    // carries its own seam, so a client-level sleep would never see this wait
    const c = new DevToClient({ fetch, pace: createPacer({ readsPerSecond: 0.5, sleep }) });
    await c.request("GET", "/api/articles");
    expect(waits).toEqual([]);
  });

  it("paces every page of an All iterator without pagination.ts knowing (R10)", async () => {
    const pages: Record<string, unknown[]> = {
      "1": [{ id: 1 }],
      "2": [{ id: 2 }],
      "3": [{ id: 3 }],
      "4": [{ id: 4 }],
      "5": [{ id: 5 }],
    };
    const fetch = (async (url: string | URL | Request) => {
      const page = new URL(String(url)).searchParams.get("page") ?? "1";
      return json(pages[page] ?? []);
    }) as typeof globalThis.fetch;
    const { sleep, waits } = recordingSleep();
    const c = new DevToClient({ fetch, sleep });

    const seen: unknown[] = [];
    for await (const item of c.articles.listAll()) seen.push(item);
    expect(seen).toHaveLength(5);
    expect(waits).toHaveLength(3); // six requests, three of them past the budget
  });

  it("fails the overflow of a concurrent burst rather than queueing it forever", async () => {
    // the deadline clock starts at call entry, so more than deadline x rate
    // in flight means the tail exhausts its budget waiting for a slot
    const { fetch, calls } = countingFetch();
    const c = new DevToClient({ fetch, timeoutMs: 500, pace: createPacer({ readsPerSecond: 1 }) });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => c.request("GET", "/api/articles")),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect(r.reason).toBeInstanceOf(DevToTimeoutError);
    }
    expect(calls).toHaveLength(1);
  });
});
