import type { components } from "./generated/types.ts";

/**
 * The `{ error, status }` envelope rendered by Forem's v1 API controllers
 * (hand-rolled 400s such as semantic_search omit `status`). A 1:1 alias over
 * the generated component (KTD4), so a spec rename breaks here at compile time
 * rather than drifting from the hand-written shape it used to duplicate.
 */
export type ErrorEnvelope = components["schemas"]["ErrorEnvelope"];

/**
 * Which detector proved a response could not have been generated for the request
 * it is answering. dev.to's edge cache leaves out of its key both dimensions the
 * response depends on, the versioned `Accept` header and your credential, so a
 * stored response can answer a request it never saw.
 *
 * - `v0-under-v1`: the reply carries Forem's v0 deprecation marker although the
 *   client sent the versioned v1 Accept header. The one that fires on a fresh
 *   response too: a v0 body served by the origin is a worse bug, not a lesser one.
 * - `impossible-404`: a cached 404 from an operation an authenticated walk found
 *   never to 404 (`spec/never-404.json`). A genuine not-found is left alone.
 * - `credentialed-refusal`: a cached 401 or 403 answering a request that carried
 *   a credential the stored response was never shown. The weakest of the three,
 *   since a genuinely invalid key earns a refusal that then replays honestly.
 *
 * Advisory by construction: nothing is retried, thrown, or suppressed on it, so
 * a false positive costs a spurious flag rather than a failed call.
 */
export type Contradiction = "v0-under-v1" | "impossible-404" | "credentialed-refusal";

/** Transport-level facts read off a response's headers, never its body. */
export interface ResponseMeta {
  /** HTTP status of the response the metadata was read from. */
  status: number;
  /**
   * The bytes came from a CDN cache rather than the origin: `x-cache` reports
   * a HIT at either tier. A response with no `x-cache` at all (a self-hosted
   * Forem behind no CDN) reads false.
   */
  fromCache: boolean;
  /** The `age` header in seconds, when present and an integer. */
  age: number | undefined;
  /** Upstream `x-request-id`: the handle to quote when reporting a bad response. */
  requestId: string | undefined;
  /**
   * A stored response contradicts something this request asserted, naming which
   * detector proved it. See {@link Contradiction}. Undefined means no detector
   * fired, which is not a guarantee the response is sound.
   *
   * The key is optional only so that adding it stayed a minor release: code that
   * builds a `ResponseMeta` by hand predates it. Every response this client reads
   * sets it, so consumers can treat it as present.
   */
  contradiction?: Contradiction | undefined;
}

/**
 * The meaning of a failure, derived from its HTTP status so a `catch` block can
 * branch on intent instead of matching status integers. Reads the response, not
 * the spec: it stays correct for statuses the spec never declares (the
 * throttler's 429, a 403), because classification is a runtime fact.
 *
 * Compatibility (R9): this union can gain members in a minor release, so an
 * exhaustive `switch` needs a default arm. `unknown` is where every unmapped
 * status lands, so that arm always has something to catch.
 */
export type DevToErrorCategory =
  | "rate-limited"
  | "validation"
  | "not-found"
  | "conflict"
  | "unauthorized"
  | "forbidden"
  | "server"
  | "unknown";

/** Map a response status to its category (R4), exact-match with a 5xx band and an explicit fallback. */
function categorize(status: number): DevToErrorCategory {
  switch (status) {
    case 429:
      return "rate-limited";
    case 400:
    case 422:
      return "validation";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    default:
      return status >= 500 && status <= 599 ? "server" : "unknown";
  }
}

/**
 * Every non-2xx response surfaces as this single error class: HTTP status,
 * the parsed `{ error, status }` envelope when the body is one, and the raw
 * body text otherwise (Rack::Attack's 429 is plain text).
 */
export class DevToApiError extends Error {
  override readonly name: string = "DevToApiError";
  readonly status: number;
  /** The failure's meaning, derived from {@link status}. See {@link DevToErrorCategory}. */
  readonly category: DevToErrorCategory;
  readonly body: ErrorEnvelope | undefined;
  readonly rawBody: string;
  /** Upstream `x-request-id`, when the response carried one. */
  readonly requestId: string | undefined;
  /** The response was served from a CDN cache: retrying replays the same bytes. */
  readonly fromCache: boolean;
  /** Cache age in seconds, when the response reported one. */
  readonly age: number | undefined;
  /** The response was not generated for this request. See {@link Contradiction}. */
  readonly contradiction: Contradiction | undefined;

  /** `meta` is optional so existing three-argument construction keeps working. */
  constructor(
    status: number,
    body: ErrorEnvelope | undefined,
    rawBody: string,
    meta?: Omit<ResponseMeta, "status">,
  ) {
    super(
      body
        ? `${body.error} (HTTP ${status})`
        : rawBody
          ? `HTTP ${status}: ${rawBody}`
          : `HTTP ${status}`,
    );
    this.status = status;
    this.category = categorize(status);
    this.body = body;
    this.rawBody = rawBody;
    this.requestId = meta?.requestId;
    this.fromCache = meta?.fromCache ?? false;
    this.age = meta?.age;
    this.contradiction = meta?.contradiction;
  }
}

/**
 * A call ran out of its `timeoutMs` deadline. Separate from {@link DevToApiError}
 * because nothing came back from the server, and separate from a caller-initiated
 * abort, which still rejects with the caller's own reason, so `instanceof` tells
 * the two apart.
 */
export class DevToTimeoutError extends Error {
  override readonly name: string = "DevToTimeoutError";
  /**
   * The wait the client refused to take because it landed past the deadline:
   * a `Retry-After` or a pacing hold. Undefined when the deadline simply elapsed.
   */
  readonly declinedWaitMs: number | undefined;

  constructor(message: string, declinedWaitMs?: number) {
    super(message);
    this.declinedWaitMs = declinedWaitMs;
  }
}
