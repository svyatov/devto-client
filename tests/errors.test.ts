import { describe, expect, it } from "bun:test";
import { DevToApiError, type DevToErrorCategory, type ErrorEnvelope } from "../src/errors.ts";
import type { components } from "../src/generated/types.ts";

describe("DevToApiError", () => {
  it("uses the envelope error as the message", () => {
    const err = new DevToApiError(
      404,
      { error: "not found", status: 404 },
      '{"error":"not found","status":404}',
    );
    expect(err.message).toBe("not found (HTTP 404)");
    expect(err.name).toBe("DevToApiError");
    expect(err.status).toBe(404);
  });

  it("falls back to raw body text when there is no envelope", () => {
    const err = new DevToApiError(429, undefined, "Retry later");
    expect(err.message).toBe("HTTP 429: Retry later");
    expect(err.body).toBeUndefined();
    expect(err.rawBody).toBe("Retry later");
  });

  it("handles an empty body", () => {
    const err = new DevToApiError(500, undefined, "");
    expect(err.message).toBe("HTTP 500");
  });
});

describe("ErrorEnvelope alias (U2)", () => {
  // R8: assignable both ways against the previous hand-written shape.
  it("accepts an envelope with only error, and one with a numeric status", () => {
    const onlyError: ErrorEnvelope = { error: "boom" };
    const withStatus: ErrorEnvelope = { error: "boom", status: 422 };
    expect(onlyError.error).toBe("boom");
    expect(withStatus.status).toBe(422);
  });

  // A rename of the generated component makes this indexed access `never`,
  // breaking the assignment at compile time rather than drifting silently.
  it("is a 1:1 alias over the generated component", () => {
    type Same = ErrorEnvelope extends components["schemas"]["ErrorEnvelope"]
      ? components["schemas"]["ErrorEnvelope"] extends ErrorEnvelope
        ? true
        : false
      : false;
    const same: Same = true;
    expect(same).toBe(true);
  });

  // The construction site in src/http.ts passes a parsed envelope with no assertion.
  it("accepts a parsed envelope as the DevToApiError body without a cast", () => {
    const body: ErrorEnvelope = { error: "bad request", status: 400 };
    const err = new DevToApiError(400, body, JSON.stringify(body));
    expect(err.body).toEqual(body);
  });
});

describe("DevToApiError.category (U3)", () => {
  // AE1: envelope failure classifies from the status, envelope stays reachable.
  it("maps an unprocessable envelope failure to validation, keeping the body", () => {
    const body = { error: "invalid", status: 422 };
    const err = new DevToApiError(422, body, JSON.stringify(body));
    expect(err.category).toBe("validation");
    expect(err.body).toEqual(body);
  });

  // AE2: non-envelope failure classifies from the status, raw text stays reachable.
  it("maps a plain-text throttler failure to rate-limited, keeping the raw text", () => {
    const err = new DevToApiError(429, undefined, "Retry later");
    expect(err.category).toBe("rate-limited");
    expect(err.rawBody).toBe("Retry later");
  });

  // AE3, R5: a status the spec declares nowhere still classifies.
  it("maps a forbidden status the spec never declares to forbidden", () => {
    expect(new DevToApiError(403, undefined, "").category).toBe("forbidden");
  });

  // AE5, R6: an unmapped status resolves to the explicit fallback, not undefined.
  it("maps a status outside every range to unknown", () => {
    const err = new DevToApiError(418, undefined, "");
    expect(err.category).toBe("unknown");
    expect(err.category).not.toBeUndefined();
  });

  it.each([
    [400, "validation"],
    [422, "validation"],
    [404, "not-found"],
    [409, "conflict"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate-limited"],
  ] as const)("maps status %i to %s", (status, category) => {
    expect(new DevToApiError(status, undefined, "").category).toBe(category);
  });

  // The server band is a range, not a single lower bound.
  it.each([500, 502, 503, 599])("maps server-band status %i to server", (status) => {
    expect(new DevToApiError(status, undefined, "").category).toBe("server");
  });

  // AE4, partially: a cached unauthorized response classifies with the cache signal
  // set. The no-retry half lives in the transport (src/http.ts) and its own tests.
  it("maps a cached unauthorized response to unauthorized with the cache signal", () => {
    const err = new DevToApiError(401, undefined, "", {
      fromCache: true,
      age: 5,
      requestId: "r",
      contradiction: undefined,
    });
    expect(err.category).toBe("unauthorized");
    expect(err.fromCache).toBe(true);
  });

  // R9: the union is nameable in a caller's own signature and a defaulted switch typechecks.
  it("exposes the category union for an exhaustive switch with a default arm", () => {
    const label = (c: DevToErrorCategory): string => {
      switch (c) {
        case "rate-limited":
          return "back off";
        case "validation":
        case "not-found":
        case "conflict":
        case "unauthorized":
        case "forbidden":
        case "server":
          return c;
        default:
          return "unknown";
      }
    };
    expect(label(new DevToApiError(409, undefined, "").category)).toBe("conflict");
  });
});
