import { createDebugPrinter } from "./debug.ts";
import {
  type Contradiction,
  DevToApiError,
  DevToTimeoutError,
  type ErrorEnvelope,
  type ResponseMeta,
} from "./errors.ts";
import { type DevToEvent, type DevToRetryEvent, safeEmit } from "./events.ts";
import { createPacer, type Pacer } from "./pacing.ts";
import { abortReason, sleep } from "./timing.ts";
import { VERSION } from "./version.ts";

const ACCEPT_V1 = "application/vnd.forem.api-v1+json";
const USER_AGENT = `devto-client/${VERSION}`;
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
// Forem's write throttle counts PUT, POST and DELETE; PATCH rides along because
// over-counting a write costs one slot and under-counting costs a 429.
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// setTimeout stores its delay in a 32-bit int; anything larger (or non-finite)
// silently becomes 1ms, which would turn "wait a very long time" into "fail now"
const MAX_TIMER_MS = 2_147_483_647;
// module scope, not per client: the keyless-plus-authenticated pair everyone ends
// up with logs into one sink, and two calls numbered 1 correlate to nothing (KTD6)
let calls = 0;

/** Retry policy for transient failures: 429 responses (any method) and 5xx on idempotent methods. */
export interface RetryOptions {
  /** Total attempts including the first request. Default 3. */
  attempts?: number;
  /** First backoff step for 5xx, doubling with jitter per attempt. Default 500ms. */
  baseDelayMs?: number;
  /**
   * Flat wait for a 429 that carries no usable `Retry-After`. Default 5s: five
   * times Forem's one-second throttle window, which leaves the 30s default
   * deadline room for the wait plus a following attempt. Flat rather than
   * exponential because a fixed window has nothing to grow into.
   */
  throttleDelayMs?: number;
}

/** Options for constructing a {@link DevToClient}. */
export interface ClientOptions {
  /** Forem API key. Optional: public endpoints work keyless. */
  apiKey?: string;
  /** Defaults to https://dev.to; set for self-hosted Forem instances. */
  baseUrl?: string;
  /** The api-key must never transit cleartext; opt in explicitly for local instances. */
  allowInsecureHttp?: boolean;
  /** `false` disables retries entirely. */
  retry?: RetryOptions | false;
  /**
   * Deadline for a whole call: every attempt, every backoff wait, every pacing
   * hold, and the response body read, together. Default 30s. One call is one HTTP
   * request, so each page of an `All` iterator carries its own; bound a whole walk
   * with your own `signal` instead. Expiry rejects with `DevToTimeoutError`.
   */
  timeoutMs?: number;
  /**
   * Self-pacing against dev.to's per-second budgets, on by default. Pass a pacer
   * from `createPacer` to tune it, share one between clients to share a budget, or
   * pass `false` to disable it, which is the right setting for an admin key,
   * since those are throttle-exempt upstream and the client cannot detect them.
   */
  pace?: Pacer | false;
  /**
   * Called with every request attempt, response, retry wait and failure, each
   * correlated by a call id. See {@link DevToEvent}, and give your handler a
   * `default` arm: the union is open. Throwing from here cannot affect the call.
   */
  onEvent?: (e: DevToEvent) => void;
  /**
   * Print every event to `console.error` as one human-readable line. Composes
   * with {@link ClientOptions.onEvent}; setting one does not suppress the other.
   * The line format is diagnostic output and may change in any release.
   */
  debug?: boolean;
  /**
   * Called with transport metadata for every response, success or failure. This is
   * where cache status reaches a successful call: a `fromCache` 200 means a CDN
   * answered, which for an authenticated read may mean it answered with someone
   * else's bytes. Throwing from here cannot affect the call.
   *
   * @deprecated Use {@link ClientOptions.onEvent} and branch on the `response`
   * kind, which carries the same fields plus the method, the URL, the raw
   * `Headers` and elapsed time. Removed in 3.0. Note the timing: as of 2.1 this
   * fires at attempt end rather than before the body is read, so it no longer
   * runs ahead of a body read it might have wanted to preempt.
   */
  onResponse?: (meta: ResponseMeta) => void;
  /**
   * Default headers merged into every request. Set a `user-agent` to identify
   * your app, for instance. Per-request `headers` override these; the versioned
   * Accept header and the api-key always win. Prefer `apiKey` for your Forem key,
   * though one set here gets the same redirect-leak guard. Browsers ignore a
   * custom `user-agent`, so that setting only takes effect off the browser.
   */
  headers?: Record<string, string>;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests. Defaults to a timer-backed sleep a Retry-After can drive. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Per-request options for the low-level {@link DevToClient.request} escape hatch. */
export interface RequestOptions {
  /** Query parameters; `undefined` values are dropped, others are stringified. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Request body, JSON-serialized (sets `content-type: application/json` unless overridden). */
  body?: unknown;
  /** Abort signal; aborting rejects the call and cancels any pending retry backoff. */
  signal?: AbortSignal;
  /** Merged into the request; the versioned Accept header always wins. */
  headers?: Record<string, string>;
  /** Overrides the client's `timeoutMs` for this call. */
  timeoutMs?: number;
  /**
   * Your own correlation id, carried verbatim on every event this call emits and
   * never rewritten. It sits beside the generated `callId` rather than replacing
   * it, so a paginated walk sharing one `traceId` still tells its pages apart.
   */
  traceId?: string;
}

export interface ResolvedConfig {
  apiKey: string | undefined;
  baseUrl: string;
  retry: Required<RetryOptions> | null;
  timeoutMs: number;
  pace: Pacer | null;
  emit: (e: DevToEvent) => void;
  headers: Record<string, string> | undefined;
  fetch: typeof globalThis.fetch;
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

export function resolveConfig(options: ClientOptions): ResolvedConfig {
  // the lookbehind pins the match to the start of the trailing run; without it
  // `\/+$` restarts at every slash and goes quadratic on `"https://x" + "/".repeat(1e5) + "y"`
  const baseUrl = (options.baseUrl ?? "https://dev.to").replace(/(?<!\/)\/+$/, "");
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`baseUrl must be http(s), got ${parsed.protocol}`);
  }
  if (parsed.protocol === "http:" && options.allowInsecureHttp !== true) {
    throw new Error(
      "baseUrl must be https. The api-key would transit cleartext. Set allowInsecureHttp: true to override.",
    );
  }
  const resolvedSleep = options.sleep ?? sleep;
  // every observer the caller asked for, collapsed here so the attempt loop has
  // one call per event kind and no branching over which hooks exist (KTD7)
  const handlers: ((e: DevToEvent) => void)[] = [];
  if (options.debug === true) handlers.push(createDebugPrinter());
  if (options.onEvent) handlers.push(options.onEvent);
  const { onResponse } = options;
  if (onResponse) {
    // the deprecated shim, kept out of the loop entirely: it projects today's
    // ResponseMeta back out of the wider event and ignores every other kind.
    // Its return value is passed back up so an async observer's rejection still
    // reaches the guard rather than escaping as an unhandled one.
    handlers.push((e) => {
      if (e.kind !== "response") return undefined;
      return onResponse({
        status: e.status,
        fromCache: e.fromCache,
        age: e.age,
        requestId: e.requestId,
        contradiction: e.contradiction,
      });
    });
  }
  return {
    apiKey: options.apiKey,
    baseUrl,
    retry:
      options.retry === false
        ? null
        : {
            attempts: options.retry?.attempts ?? 3,
            baseDelayMs: options.retry?.baseDelayMs ?? 500,
            throttleDelayMs: options.retry?.throttleDelayMs ?? 5000,
          },
    timeoutMs: options.timeoutMs ?? 30_000,
    // a pacer we build here inherits the client's sleep so the test seam still
    // covers pacing waits; one handed in keeps its own, since it may serve two
    // clients that injected different sleeps (KTD4)
    pace: options.pace === false ? null : (options.pace ?? createPacer({ sleep: resolvedSleep })),
    // one hostile handler must not cost its siblings the event, so each is
    // dispatched through its own guard rather than the loop being wrapped
    emit: (e) => {
      for (const handler of handlers) safeEmit(handler, e);
    },
    headers: options.headers,
    fetch: options.fetch ?? globalThis.fetch,
    sleep: resolvedSleep,
  };
}

/** Integer-seconds Retry-After only; HTTP-dates and garbage fall back to the backoff schedule. */
function parseRetryAfter(header: string | null): number | null {
  return header !== null && /^\d+$/.test(header) ? Number(header) * 1000 : null;
}

/** Exponential with downward jitter. Unbounded. The call deadline is the ceiling. */
function backoffDelay(attempt: number, retry: Required<RetryOptions>): number {
  return retry.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
}

/**
 * Which contradiction a response proves, strongest evidence first (KTD5). The
 * cache flag is the whole proof for the two stored-response detectors: a hit was
 * generated before this request existed, so it cannot have evaluated anything
 * this request asserted. `age` is deliberately not consulted, since it is absent
 * whenever the header is missing or non-integer, which would drop real cases.
 */
function detectContradiction(
  res: Response,
  fromCache: boolean,
  credentialed: boolean,
  never404: boolean,
): Contradiction | undefined {
  // warn-code 299 is Forem's v0 deprecation marker, emitted from the v0 code
  // path. The client hard-codes the v1 Accept header below, so its presence is a
  // contradiction whether the edge or the origin produced it: a v0 body served
  // fresh is the worse bug, and the flag must not hide it behind a cache check.
  // Matched per list element rather than as a prefix: `Warning` is a comma-joined
  // list, and an intermediary emitting its own warning first would otherwise hide
  // Forem's behind it.
  if (/(?:^|,\s*)299\b/.test(res.headers.get("warning") ?? "")) return "v0-under-v1";
  if (!fromCache) return undefined;
  if (res.status === 404 && never404) return "impossible-404";
  // 401 and 403 both, the pair the rest of the project already treats alike as a
  // refusal: a cached 403 replay is the same defect as a cached 401.
  if (credentialed && (res.status === 401 || res.status === 403)) return "credentialed-refusal";
  return undefined;
}

/**
 * Headers only. This cannot fold into {@link toApiError}: the retry decision needs
 * the cache flag *before* the error is built, and building the error consumes the
 * body, after which the headers are still readable but the response is spent.
 *
 * The two request-side facts arrive as parameters (KTD7) because the single call
 * site already holds both: whether the assembled headers carried a credential,
 * and whether the operation is one the never-404 walk admitted. They default to
 * off, which is what the low-level escape hatch gets for the second (R8).
 */
export function readTransportMeta(
  res: Response,
  credentialed = false,
  never404 = false,
): ResponseMeta {
  const age = res.headers.get("age");
  // dev.to reports two tiers ("HIT, MISS", "MISS, HIT"); either one hitting
  // means the bytes skipped the origin. No header at all means no CDN (KTD6).
  const fromCache = res.headers.get("x-cache")?.toUpperCase().includes("HIT") ?? false;
  return {
    status: res.status,
    fromCache,
    age: age !== null && /^\d+$/.test(age) ? Number(age) : undefined,
    requestId: res.headers.get("x-request-id") ?? undefined,
    contradiction: detectContradiction(res, fromCache, credentialed, never404),
  };
}

async function toApiError(res: Response, meta: ResponseMeta): Promise<DevToApiError> {
  const rawBody = await res.text();
  let envelope: ErrorEnvelope | undefined;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as ErrorEnvelope).error === "string"
    ) {
      envelope = parsed as ErrorEnvelope;
    }
  } catch {
    // not JSON: rawBody carries it
  }
  return new DevToApiError(res.status, envelope, rawBody, meta);
}

/**
 * `never404` is a trailing parameter rather than a field on `RequestOptions`
 * (KTD4): that type is public, and a caller could only guess at a claim the
 * generated set exists to establish. `bindOps` resolves it once per operation
 * and passes it here; `DevToClient.request` does not, which is what keeps the
 * impossible-404 detector off the escape hatch (R8).
 */
export async function request<T>(
  config: ResolvedConfig,
  method: string,
  path: string,
  opts: RequestOptions = {},
  never404 = false,
): Promise<T> {
  if (opts.signal?.aborted) throw abortReason(opts.signal);

  const url = new URL(config.baseUrl + path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  // `set` per entry rather than one spread of both objects: a spread compares keys
  // case-sensitively, so a per-request `x-foo` would survive alongside a
  // client-level `X-Foo` and Headers would comma-join the two instead of letting
  // the per-request value win
  const headers = new Headers();
  for (const source of [config.headers, opts.headers]) {
    for (const [key, value] of Object.entries(source ?? {})) headers.set(key, value);
  }
  // weakest precedence, unlike accept and api-key below: a caller who names the
  // library in their own user-agent replaces ours rather than collecting both.
  // `has` rather than an object-spread default so `User-Agent` matches too.
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  headers.set("accept", ACCEPT_V1);
  if (config.apiKey !== undefined) headers.set("api-key", config.apiKey);

  // Asked of the assembled headers, not `config.apiKey`, so a key a caller
  // supplied through `headers` counts as a credential too. Both the redirect
  // guard and the contradiction detector below read this one answer.
  const credentialed = headers.has("api-key");

  const init: RequestInit = { method, headers };
  // fetch strips Authorization on cross-origin redirects but forwards custom
  // headers like api-key. Refuse redirects outright rather than leak the key.
  if (credentialed) init.redirect = "error";
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  const { retry } = config;
  const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
  const deadlineAt = Date.now() + timeoutMs;
  const expired = (): DevToTimeoutError =>
    new DevToTimeoutError(`${method} ${url} exceeded its ${timeoutMs}ms deadline`);
  // the escape hatch takes whatever method string a caller types, and both sets
  // below hold canonical names, so classify off one normalized copy
  const verb = method.toUpperCase();
  const paceKind = WRITES.has(verb) ? "write" : "read";
  // drawn once per call, after the pre-flight abort above: a call that never
  // reached an attempt has nothing to report, so it spends no id (KTD8)
  const callId = ++calls;
  const target = url.toString();

  for (let attempt = 1; ; attempt++) {
    const at = { callId, traceId: opts.traceId, method, url: target, attempt };
    config.emit({ kind: "request", ...at });

    let wait: number;
    let why: DevToRetryEvent["reason"];
    // hoisted to attempt scope so the cleanup below can run for a throw raised
    // before either was set, which is what widening the `try` costs (KTD1)
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    // set the moment headers arrive; its presence is what says a response event
    // is owed, independently of whether the attempt also failed (KTD2)
    let seen: { meta: ResponseMeta; headers: Headers } | undefined;
    // the error this attempt built from its own response: throwing it is a
    // rejection, not a transport failure, so the `catch` must not report it
    let apiError: DevToApiError | undefined;
    let pacedMs = 0;
    let durationMs = 0;
    let startedAt: number | undefined;

    try {
      try {
        // pacing draws on the same budget as everything else, so a hold that would
        // wake past the deadline fails the call instead of sleeping through it.
        // Timed here rather than through the `Pacer` interface, so a caller-supplied
        // pacer reports its holds too (KTD3).
        const heldFrom = Date.now();
        try {
          await config.pace?.acquire(paceKind, { deadlineAt, signal: opts.signal });
        } finally {
          // a hold the caller aborted still held the call: reporting zero there
          // would read as an instant death on the failure event
          pacedMs = Date.now() - heldFrom;
        }
        // network time starts after the hold and stays unset until then, so a
        // refused hold reports a zero duration rather than counting itself (KTD4)
        startedAt = Date.now();

        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw expired();

        // KTD1: one controller per attempt, armed until the body is consumed. Composing
        // `AbortSignal.any([opts.signal, AbortSignal.timeout(...)])` instead would pile
        // one composite per page onto a caller signal reused across a listAll walk:
        // the documented Node leak. The finally below is what keeps that from happening.
        const controller = new AbortController();
        const deadline = expired();
        timer = setTimeout(() => controller.abort(deadline), Math.min(remaining, MAX_TIMER_MS));
        onAbort = (): void => {
          if (opts.signal) controller.abort(abortReason(opts.signal));
        };
        // a listener added to an already-aborted signal never fires, and the caller
        // may have aborted while we were paced or backing off: check, then subscribe
        if (opts.signal?.aborted) throw abortReason(opts.signal);
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        let res: Response;
        try {
          res = await config.fetch(target, { ...init, signal: controller.signal });
        } catch (cause) {
          if (opts.signal?.aborted) throw abortReason(opts.signal);
          if (cause === deadline) throw deadline;
          throw new Error(`${method} ${url} failed`, { cause });
        }

        const meta = readTransportMeta(res, credentialed, never404);
        seen = { meta, headers: res.headers };

        if (res.ok) {
          if (res.status === 204) return undefined as T;
          const text = await res.text();
          return (text === "" ? undefined : JSON.parse(text)) as T;
        }

        // a cached 429 replays the same stored bytes on every attempt: it cannot be
        // won, and each try spends rate budget on the way (R3). 5xx is excluded: a
        // short-TTL cached 500 can still recover on a later attempt.
        const retriesLeft = retry !== null && attempt < retry.attempts;
        if (retriesLeft && res.status === 429 && !meta.fromCache) {
          why = "throttle";
          const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
          if (retryAfterMs === null) {
            wait = clampToBudget(retry.throttleDelayMs, deadlineAt);
          } else if (Date.now() + retryAfterMs > deadlineAt) {
            // the server named a time; obeying a shortened version of it is
            // meaningless, so an overshoot fails now and says what it declined
            throw new DevToTimeoutError(
              `${method} ${url} was asked to wait ${retryAfterMs}ms, past its ${timeoutMs}ms deadline`,
              retryAfterMs,
            );
          } else {
            wait = retryAfterMs;
          }
        } else if (retriesLeft && res.status >= 500 && IDEMPOTENT.has(verb)) {
          why = "server";
          wait = clampToBudget(backoffDelay(attempt, retry), deadlineAt);
        } else {
          apiError = await toApiError(res, meta);
          throw apiError;
        }
        // only the retry paths reach here. Release the socket before the wait: an
        // unread body pins its connection, and the waits have no ceiling any more.
        void res.body?.cancel().catch(() => {});
      } finally {
        if (startedAt !== undefined) durationMs = Date.now() - startedAt;
        // an inner `finally` rather than the outer one: it has to run before the
        // `catch` below, or a body that died mid-read would report failure first
        if (seen) {
          config.emit({
            kind: "response",
            ...at,
            ...seen.meta,
            headers: seen.headers,
            durationMs,
            pacedMs,
          });
        }
      }
    } catch (err) {
      if (err !== apiError)
        config.emit({ kind: "failure", ...at, error: err, durationMs, pacedMs });
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) opts.signal?.removeEventListener("abort", onAbort);
    }

    config.emit({ kind: "retry", ...at, waitMs: wait, reason: why });
    try {
      await config.sleep(wait, opts.signal);
    } catch (err) {
      // KTD8: a call that dies in the wait has already emitted events, so ending
      // on a `retry` nothing ever answered would leave a logger hanging
      config.emit({ kind: "failure", ...at, error: err, durationMs, pacedMs });
      throw err;
    }
  }
}

/**
 * A wait we chose ourselves is trimmed to the budget rather than refused (R18):
 * refusing it would make raising `attempts` silently useless now that no
 * per-wait ceiling exists. The attempt after a fully-consumed budget fails on
 * the deadline check, which is the honest outcome.
 */
function clampToBudget(waitMs: number, deadlineAt: number): number {
  return Math.max(0, Math.min(waitMs, deadlineAt - Date.now()));
}
