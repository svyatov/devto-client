/** The `{ error, status }` envelope rendered by Forem's v1 API controllers. */
export interface ErrorEnvelope {
  error: string;
  /** Hand-rolled 400s (e.g. semantic_search) omit this. */
  status?: number;
}

/** Transport-level facts read off a response's headers, never its body. */
export interface ResponseMeta {
  /** HTTP status of the response the metadata was read from. */
  status: number;
  /**
   * The bytes came from a CDN cache rather than the origin — `x-cache` reports
   * a HIT at either tier. A response with no `x-cache` at all (a self-hosted
   * Forem behind no CDN) reads false.
   */
  fromCache: boolean;
  /** The `age` header in seconds, when present and an integer. */
  age: number | undefined;
  /** Upstream `x-request-id` — the handle to quote when reporting a bad response. */
  requestId: string | undefined;
}

/**
 * Every non-2xx response surfaces as this single error class: HTTP status,
 * the parsed `{ error, status }` envelope when the body is one, and the raw
 * body text otherwise (Rack::Attack's 429 is plain text).
 */
export class DevToApiError extends Error {
  override readonly name: string = "DevToApiError";
  readonly status: number;
  readonly body: ErrorEnvelope | undefined;
  readonly rawBody: string;
  /** Upstream `x-request-id`, when the response carried one. */
  readonly requestId: string | undefined;
  /** The response was served from a CDN cache — retrying replays the same bytes. */
  readonly fromCache: boolean;
  /** Cache age in seconds, when the response reported one. */
  readonly age: number | undefined;

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
    this.body = body;
    this.rawBody = rawBody;
    this.requestId = meta?.requestId;
    this.fromCache = meta?.fromCache ?? false;
    this.age = meta?.age;
  }
}

/**
 * A call ran out of its `timeoutMs` deadline. Separate from {@link DevToApiError}
 * because nothing came back from the server, and separate from a caller-initiated
 * abort — which still rejects with the caller's own reason — so `instanceof` tells
 * the two apart.
 */
export class DevToTimeoutError extends Error {
  override readonly name: string = "DevToTimeoutError";
  /**
   * The wait the client refused to take because it landed past the deadline —
   * a `Retry-After` or a pacing hold. Undefined when the deadline simply elapsed.
   */
  readonly declinedWaitMs: number | undefined;

  constructor(message: string, declinedWaitMs?: number) {
    super(message);
    this.declinedWaitMs = declinedWaitMs;
  }
}
