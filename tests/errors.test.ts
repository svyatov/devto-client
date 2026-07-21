import { describe, expect, it } from "bun:test";
import { DevToApiError } from "../src/errors.ts";

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
