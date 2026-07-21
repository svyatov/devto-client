import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureFileName } from "../scripts/record-fixtures.ts";
import {
  assertSweepSafe,
  CAPTURE_DIR,
  type Capture,
  classifyPayload,
  discover,
  type Finding,
  renderReport,
  sweep,
} from "../scripts/sweep-local.ts";
import { buildTargets, type SweepTarget, specOperations } from "../scripts/sweep-targets.ts";
import { DevToApiError } from "../src/errors.ts";

const scratch = mkdtempSync(join(tmpdir(), "sweep-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("KTD6 refusals fire before any request", () => {
  it("refuses a non-loopback FOREM_BASE_URL", () => {
    expect(() => assertSweepSafe({ FOREM_BASE_URL: "https://dev.to" }, CAPTURE_DIR)).toThrow(
      /non-loopback/,
    );
  });

  it("refuses an unset FOREM_BASE_URL, which would otherwise resolve to dev.to", () => {
    expect(() => assertSweepSafe({ DEVTO_API_KEY: "real-key" }, CAPTURE_DIR)).toThrow(
      /FOREM_BASE_URL is required/,
    );
  });

  it("refuses a hostname merely containing localhost", () => {
    expect(() =>
      assertSweepSafe({ FOREM_BASE_URL: "http://localhost.example.com" }, CAPTURE_DIR),
    ).toThrow(/non-loopback/);
  });

  it("accepts real loopback forms", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(() => assertSweepSafe({ FOREM_BASE_URL: url }, CAPTURE_DIR)).not.toThrow();
    }
  });

  it("refuses an out-dir outside the capture directory", () => {
    const env = { FOREM_BASE_URL: "http://localhost:3000" };
    expect(() => assertSweepSafe(env, "tests/fixtures/recorded")).toThrow(/refusing to write/);
    // the traversal a plain prefix test would wave through, straight into the Recorded tier
    expect(() => assertSweepSafe(env, `${CAPTURE_DIR}/../../tests/fixtures/recorded`)).toThrow(
      /refusing to write/,
    );
    expect(() => assertSweepSafe(env, `${CAPTURE_DIR}/run-1`)).not.toThrow();
  });
});

describe("classification", () => {
  // /api/tags declares an array of objects with id/name/bg_color_hex/text_color_hex
  const tag = {
    id: 1,
    name: "javascript",
    bg_color_hex: "#000",
    text_color_hex: "#fff",
    short_summary: "a tag",
  };

  it("classifies an undeclared key as disagreed and names it", () => {
    const f = classifyPayload("/api/tags", "GET", [{ ...tag, subforem_id: 3 }]);
    expect(f.kind).toBe("disagreed");
    if (f.kind === "disagreed") expect(f.extra).toEqual(["subforem_id"]);
  });

  it("classifies a missing declared key as inconclusive with element and hit counts", () => {
    const { bg_color_hex: _dropped, ...thin } = tag;
    const f = classifyPayload("/api/tags", "GET", [thin, thin]);
    expect(f.kind).toBe("inconclusive");
    if (f.kind === "inconclusive") {
      expect(f.missing).toEqual(["bg_color_hex"]);
      expect(f.elements).toBe(2);
      expect(f.hits.bg_color_hex).toBe(0);
    }
  });

  it("classifies a fully matching payload as matched", () => {
    expect(classifyPayload("/api/tags", "GET", [tag]).kind).toBe("matched");
  });

  it("classifies an empty payload as vacuous, not matched or inconclusive", () => {
    expect(classifyPayload("/api/tags", "GET", []).kind).toBe("vacuous");
    expect(classifyPayload("/api/users/me", "GET", {}).kind).toBe("vacuous");
  });
});

/** Drives the real sweep loop over a stubbed request function. */
const run = (
  targets: SweepTarget[],
  rf: (m: string, p: string) => Promise<unknown>,
): Promise<{ findings: Finding[]; captures: string[] }> =>
  sweep((m, p) => rf(m, p), targets, scratch, "ae359ff41b2a");

const targeted = (template: string, path: string): SweepTarget => ({
  kind: "targeted",
  template,
  method: "GET",
  path,
});

describe("the sweep loop", () => {
  it("classifies an error status as unexercised/blocked carrying the status, and keeps going", async () => {
    const calls: string[] = [];
    const { findings } = await run(
      [targeted("/api/tags", "/api/tags"), targeted("/api/instance", "/api/instance")],
      async (_m, p) => {
        calls.push(p);
        if (p === "/api/tags") throw new DevToApiError(401, { error: "unauthorized" }, "");
        return { domain: "x" };
      },
    );
    expect(calls).toEqual(["/api/tags", "/api/instance"]);
    const first = findings[0];
    expect(first?.kind).toBe("unexercised");
    if (first?.kind === "unexercised") {
      expect(first.cause).toBe("blocked");
      expect(first.reason).toContain("401");
    }
    expect(findings[1]?.kind).not.toBe("unexercised");
  });

  it("catches a plain Error from request() the same way as an API error", async () => {
    const { findings } = await run([targeted("/api/tags", "/api/tags")], async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
    });
    const f = findings[0];
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") {
      expect(f.cause).toBe("blocked");
      expect(f.reason).toContain("ECONNREFUSED");
    }
  });

  it("reports a skipped entry with its cause and reason without issuing a request", async () => {
    let called = false;
    const { findings } = await run(
      [
        {
          kind: "skipped",
          template: "/api/segments/{id}",
          method: "GET",
          cause: "blocked",
          reason: "discovery unavailable: segmentId",
        },
      ],
      async () => {
        called = true;
        return null;
      },
    );
    expect(called).toBe(false);
    const f = findings[0];
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") {
      expect(f.cause).toBe("blocked");
      expect(f.reason).toBe("discovery unavailable: segmentId");
    }
  });

  it("classifies a path that derives to a different template as unexercised, naming the derived one", async () => {
    const { findings } = await run([targeted("/api/users/{id}", "/api/users/me")], async () => ({
      id: 1,
    }));
    const f = findings[0];
    expect(f?.kind).toBe("unexercised");
    if (f?.kind === "unexercised") expect(f.reason).toContain("/api/users/me");
  });

  it("writes a capture with its source stamp and email addresses scrubbed", async () => {
    const { captures } = await run([targeted("/api/users/me", "/api/users/me")], async () => ({
      id: 1,
      username: "admin",
      email: "admin@forem.local",
    }));
    const name = fixtureFileName({ template: "/api/users/me", method: "GET" });
    expect(captures).toEqual([name]);
    const written = JSON.parse(readFileSync(join(scratch, name), "utf8")) as Capture;
    expect(written.source).toBe("local-forem@ae359ff41b2a");
    expect(JSON.stringify(written.payload)).not.toContain("admin@forem.local");
    expect(JSON.stringify(written.payload)).toContain("scrubbed@example.com");
    expect(written.path).toBe("/api/users/me");
  });

  it("classifies every operation exactly once against an unreachable port", async () => {
    const targets = buildTargets({});
    const { findings } = await run(targets, async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    });
    expect(findings.length).toBe(specOperations().length);
    const keys = findings.map((f) => `${f.method} ${f.template}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(findings.every((f) => f.kind === "unexercised")).toBe(true);
    const deferred = findings.filter((f) => f.kind === "unexercised" && f.cause === "deferred");
    expect(deferred.length).toBe(55);
  });
});

describe("discovery", () => {
  const routes: Record<string, unknown> = {
    "/api/articles": [
      { id: 7, path: "/acme/org-post", organization: { username: "acme" }, user: { user_id: 1 } },
      { id: 9, path: "/alice/my-post", user: { user_id: 42 } },
    ],
    "/api/users/me": { id: 1, email: "admin@forem.local" },
    "/api/comments": [{ id_code: "abc" }],
    "/api/tags": [{ name: "javascript" }],
    "/api/pages": [{ id: 3 }],
    "/api/badges": [],
  };
  const stub = (
    over: Record<string, unknown> = {},
  ): ((m: string, p: string) => Promise<unknown>) => {
    const table = { ...routes, ...over };
    return async (_m, p) => {
      if (!(p in table)) throw new DevToApiError(404, { error: "not found" }, "");
      return table[p];
    };
  };

  it("prefers a non-org article so the derived username is a user, not an organization", async () => {
    const d = await discover(stub());
    expect(d.articleId).toBe(9);
    expect(d.username).toBe("alice");
    expect(d.slug).toBe("my-post");
    expect(d.userId).toBe(42);
    // the org still gets discovered, just not as the {username} source
    expect(d.organization).toBe("acme");
  });

  it("leaves a field unset when its index is empty or the endpoint fails, rather than guessing", async () => {
    const d = await discover(stub());
    expect(d.pageId).toBe(3);
    expect(d.badgeId).toBeUndefined(); // empty index
    expect(d.conceptId).toBeUndefined(); // 404
    expect(d.analyticsStart).toBe("2020-01-01"); // fixed window, not discovered
  });

  it("skips a numeric organization username, which would derive to {id} and mislabel", async () => {
    const numeric = [{ id: 7, path: "/123/p", organization: { username: "123" } }];
    expect((await discover(stub({ "/api/articles": numeric }))).organization).toBeUndefined();
  });

  it("survives a Forem that answers nothing, leaving every field unset", async () => {
    const d = await discover(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
    });
    expect(d).toEqual({ analyticsStart: "2020-01-01" });
  });
});

describe("the report", () => {
  it("names the template, method, observed keys and a disposition slot per disagreement", () => {
    const md = renderReport(
      [
        { kind: "disagreed", template: "/api/tags", method: "GET", extra: ["subforem_id"] },
        {
          kind: "inconclusive",
          template: "/api/articles",
          method: "GET",
          missing: ["organization"],
          elements: 4,
          hits: { organization: 0 },
        },
        {
          kind: "unexercised",
          template: "/api/follows",
          method: "POST",
          cause: "deferred",
          reason: "write operation; pass one is reads only (KTD4)",
        },
      ],
      "ae359ff41b2a",
      "http://localhost:3000",
    );
    expect(md).toContain("ae359ff41b2a");
    expect(md).toContain("`GET /api/tags`");
    expect(md).toContain("subforem_id");
    expect(md).toContain("disposition");
    expect(md).toContain("organization 0/4");
    expect(md).toContain("`POST /api/follows`");
  });
});
