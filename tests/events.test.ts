import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createDebugPrinter } from "../src/debug.ts";
import { type DevToEvent, safeEmit } from "../src/events.ts";

const base = {
  callId: 7,
  traceId: undefined,
  method: "GET",
  url: "https://dev.to/api/articles?page=2",
  attempt: 1,
};

const request = (over: Partial<DevToEvent> = {}): DevToEvent =>
  ({ kind: "request", ...base, ...over }) as DevToEvent;

const response = (over: Record<string, unknown> = {}): DevToEvent =>
  ({
    kind: "response",
    ...base,
    status: 200,
    fromCache: false,
    age: undefined,
    requestId: undefined,
    contradiction: undefined,
    headers: new Headers(),
    durationMs: 12,
    pacedMs: 0,
    ...over,
  }) as DevToEvent;

/** Collects `console.error` output for the duration of `body`. */
async function captureErrors(body: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.error = original;
  }
  return lines;
}

describe("safeEmit (U1)", () => {
  it("swallows a handler that throws on every event (AE5)", () => {
    expect(() =>
      safeEmit(() => {
        throw new Error("handler blew up");
      }, request()),
    ).not.toThrow();
  });

  it("attaches to a rejected promise so no unhandled rejection is raised", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      rejections.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() =>
        safeEmit(async () => await Promise.reject(new Error("async blew up")), request()),
      ).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("returns without awaiting a handler that resolves later", () => {
    let settled = false;
    safeEmit(async () => {
      await new Promise((r) => setTimeout(r, 5));
      settled = true;
    }, request());
    // still false: the call moved on rather than waiting for the observer
    expect(settled).toBe(false);
  });

  it("treats an undefined handler as a no-op", () => {
    expect(() => safeEmit(undefined, request())).not.toThrow();
  });

  it("carries no runtime import, so nothing can cycle through it (KTD9)", () => {
    const source = readFileSync("src/events.ts", "utf8");
    const runtime = [...source.matchAll(/^import (?!type )/gm)];
    expect(runtime).toEqual([]);
  });
});

describe("debug printer (U4)", () => {
  it("imports only the event types, so it uses no internal API (R11)", () => {
    const source = readFileSync("src/debug.ts", "utf8");
    const imports = [...source.matchAll(/^import .*? from "(.*?)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./events.ts"]);
  });

  it("prints one line per event kind, each carrying the call id", async () => {
    const events: DevToEvent[] = [
      request(),
      response(),
      { kind: "retry", ...base, waitMs: 1000, reason: "throttle" },
      { kind: "failure", ...base, error: new Error("socket hung up"), durationMs: 3, pacedMs: 0 },
    ];
    for (const event of events) {
      const lines = await captureErrors(() => {
        createDebugPrinter()(event);
      });
      expect(lines, event.kind).toHaveLength(1);
      expect(lines[0], event.kind).toContain("#7");
    }
  });

  it("renders neither header name nor header value (R16)", async () => {
    const headers = new Headers({ "set-cookie": "session=hunter2" });
    const lines = await captureErrors(() => {
      createDebugPrinter()(response({ headers }));
    });
    expect(lines[0]).not.toContain("set-cookie");
    expect(lines[0]).not.toContain("hunter2");
  });

  it("escapes control characters in a caller-supplied traceId (R16)", async () => {
    const lines = await captureErrors(() => {
      createDebugPrinter()(request({ traceId: "abc\ndevto <- 200 forged" }));
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).toContain("abc?devto");
  });

  it("renders a call id alone when no traceId was supplied", async () => {
    const lines = await captureErrors(() => {
      createDebugPrinter()(request());
    });
    expect(lines[0]).toContain("#7 attempt 1");
    expect(lines[0]).not.toContain("undefined");
  });

  it("renders a non-Error failure reason without dumping the raw value", async () => {
    const lines = await captureErrors(() => {
      createDebugPrinter()({
        kind: "failure",
        ...base,
        error: { secret: "shhh" },
        durationMs: 1,
        pacedMs: 0,
      });
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[object Object]");
    expect(lines[0]).not.toContain("shhh");
  });

  it("shows a pacing hold only when there was one", async () => {
    const held = await captureErrors(() => {
      createDebugPrinter()(response({ pacedMs: 900 }));
    });
    expect(held[0]).toContain("paced 900ms");
    const unheld = await captureErrors(() => {
      createDebugPrinter()(response());
    });
    expect(unheld[0]).not.toContain("paced");
  });

  it("renders an unrecognized kind through the default branch (R15)", async () => {
    const lines = await captureErrors(() => {
      createDebugPrinter()({ kind: "dns", ...base } as unknown as DevToEvent);
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("dns");
    expect(lines[0]).toContain("#7");
  });
});
