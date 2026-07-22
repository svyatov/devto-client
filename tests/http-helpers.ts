/**
 * Fetch mocks and client factories shared by the request-loop tests and the
 * event-seam tests. Not a test file: `bun test` only collects `*.test.ts`.
 */
import { DevToClient } from "../src/client.ts";
import type { DevToEvent } from "../src/events.ts";
import { abortReason } from "../src/timing.ts";

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Sequential fetch mock that records every call. */
export function mockFetch(...responses: (Response | Error)[]) {
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

export const client = (
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
export const retryClient = (
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

/** Like {@link retryClient}, but collects the event stream the call emits. */
export const eventClient = (
  opts: ConstructorParameters<typeof DevToClient>[0] = {},
  ...responses: (Response | Error)[]
) => {
  const events: DevToEvent[] = [];
  const made = retryClient({ onEvent: (e) => events.push(e), ...opts }, ...responses);
  return { ...made, events, kinds: (): string[] => events.map((e) => e.kind) };
};

/**
 * A sleep that only settles when its signal aborts, rejecting with the same
 * reason the real sleep would. Lets the abort-during-backoff tests drive the
 * retry loop deterministically without real timers; the real timer-backed
 * sleep's own abort handling is covered by the "sleep" unit tests below.
 */
export const abortableSleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((_resolve, reject) => {
    const fail = (): void => reject(signal ? abortReason(signal) : new Error("aborted"));
    if (signal?.aborted) return fail();
    signal?.addEventListener("abort", fail, { once: true });
  });

export const res429 = (retryAfter?: string, headers: Record<string, string> = {}): Response =>
  new Response("slow down", {
    status: 429,
    headers: retryAfter === undefined ? headers : { "retry-after": retryAfter, ...headers },
  });

/** Yields to the event loop so an abort lands mid-flight rather than before the call starts. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** A fetch that resolves nothing, ever: the hang this whole deadline exists to end. */
export const stallingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  })) as typeof globalThis.fetch;

/** Headers arrive; the body never does. Aborting the request signal must still kill it. */
export const stallingBodyFetch = ((_url: string | URL | Request, init?: RequestInit) =>
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
