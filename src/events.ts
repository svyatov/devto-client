/**
 * The observability seam: one event per request attempt, retry wait and failure,
 * all correlated by a call id. Type-only imports keep this a leaf module, so
 * anything may depend on it without risking a cycle (KTD9).
 */
import type { ResponseMeta } from "./errors.ts";

/** The correlation fields every event carries, whatever its kind. */
export interface DevToEventBase {
  /**
   * Names exactly one HTTP request. Drawn from a process-wide counter, so two
   * clients logging into the same sink never both report call 1.
   */
  callId: number;
  /** Whatever the caller passed as `traceId`, verbatim; undefined when none was. */
  traceId: string | undefined;
  method: string;
  /** Fully resolved request URL, query string included. */
  url: string;
  /** 1 for the first try, incrementing per retry within the same `callId`. */
  attempt: number;
}

/** An attempt is about to reach the network. Fires before any pacing hold. */
export interface DevToRequestEvent extends DevToEventBase {
  kind: "request";
}

/**
 * An attempt received a response. Fires at attempt end, so `durationMs` includes
 * the body read on a terminal attempt (a retried one cancels its body, leaving
 * the figure headers-only).
 *
 * `headers` is the server's raw `Headers`, uncurated and unredacted. Off the
 * browser that includes `set-cookie`; log the object wholesale and you write
 * whatever the server set.
 */
export interface DevToResponseEvent extends DevToEventBase, ResponseMeta {
  kind: "response";
  headers: Headers;
  /** Network and body time for this attempt, excluding any pacing hold. */
  durationMs: number;
  /** Time this attempt spent held by the pacer before reaching the network. */
  pacedMs: number;
}

/** The client decided to retry and is about to wait. */
export interface DevToRetryEvent extends DevToEventBase {
  kind: "retry";
  /** The wait about to be taken, after any clamp to the remaining deadline. */
  waitMs: number;
  /** `throttle` for a 429, `server` for a 5xx on an idempotent method. */
  reason: "throttle" | "server";
}

/**
 * The bytes did not arrive: a network error, a deadline expiry, or a caller
 * abort, including one that lands between attempts. A response that merely
 * carried an error status is not a failure; it emits {@link DevToResponseEvent}.
 */
export interface DevToFailureEvent extends DevToEventBase {
  kind: "failure";
  /** The thrown value: a `DevToTimeoutError`, the caller's abort reason, or a wrapped network error. */
  error: unknown;
  durationMs: number;
  pacedMs: number;
}

/**
 * Everything the client reports through `onEvent`.
 *
 * Open union: a later minor release may add a kind. Branch with a `default` arm
 * rather than an exhaustive `switch` over the four members here, or a handler
 * that compiles today stops compiling on an upgrade that changed nothing else.
 */
export type DevToEvent =
  | DevToRequestEvent
  | DevToResponseEvent
  | DevToRetryEvent
  | DevToFailureEvent;

/**
 * Hand an event to a handler that cannot be trusted with it. A synchronous throw
 * is swallowed; an async handler's rejection is attached to, because an unhandled
 * one takes down the process on Node's default. The promise is never awaited: an
 * observer does not get to pace the call it observes. An absent handler is a
 * no-op, so callers never guard the call site.
 */
export function safeEmit(handler: ((e: DevToEvent) => void) | undefined, event: DevToEvent): void {
  if (!handler) return;
  try {
    const settled: unknown = handler(event);
    if (settled instanceof Promise) void settled.catch(() => {});
  } catch {
    // an observer's failure is the observer's problem, not the call's
  }
}
