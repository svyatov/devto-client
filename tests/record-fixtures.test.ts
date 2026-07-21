import { describe, expect, it, vi } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUserTierRecorded,
  buildRecorderConfig,
  parseArgs,
  type ReadSpec,
  type Recorded,
  type Rf,
  recordReads,
  recordWriteCycle,
  resolveTarget,
  scrub,
  selectReads,
} from "../scripts/record-fixtures.ts";
import { DevToApiError } from "../src/errors.ts";
import { resolveConfig } from "../src/http.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "rec-"));

describe("assertUserTierRecorded", () => {
  const rec = (template: string): Recorded => ({
    template,
    method: "GET",
    recordedAt: "2026-01-01T00:00:00Z",
    path: "/x",
    payload: {},
  });
  const spec = (template: string): ReadSpec => ({ template, path: "/x" });

  it("passes when no user reads were selected", () => {
    expect(() => assertUserTierRecorded([], [])).not.toThrow();
  });

  it("passes when at least one selected user read was recorded", () => {
    expect(() =>
      assertUserTierRecorded(
        [rec("/api/users/me")],
        [spec("/api/users/me"), spec("/api/readinglist")],
      ),
    ).not.toThrow();
  });

  it("throws when a key was provided but every selected user read was skipped", () => {
    // public reads recorded fine, but the whole user tier 401'd — stale-fixture trap
    expect(() =>
      assertUserTierRecorded([rec("/api/tags")], [spec("/api/users/me"), spec("/api/readinglist")]),
    ).toThrow(/every user-scope read was skipped/);
  });
});

describe("scrub", () => {
  it("replaces emails and IPs anywhere in the payload", () => {
    const scrubbed = scrub({
      user: { email: "real.person+tag@corp.io" },
      log: ["seen from 192.168.1.100"],
    });
    expect(scrubbed).toEqual({
      user: { email: "scrubbed@example.com" },
      log: ["seen from 0.0.0.0"],
    });
  });

  it("replaces draft content fields when scrubContent is set", () => {
    const scrubbed = scrub(
      [
        {
          title: "my secret draft",
          body_markdown: "private notes",
          slug: "my-secret-draft-temp-slug-1a2b3c",
          published: false,
          id: 7,
        },
      ],
      true,
    ) as Record<string, unknown>[];
    expect(scrubbed[0]?.title).toBe("synthetic title placeholder");
    expect(scrubbed[0]?.body_markdown).toBe("synthetic body_markdown placeholder");
    expect(scrubbed[0]?.slug).toBe("synthetic slug placeholder");
    expect(scrubbed[0]?.id).toBe(7);
  });

  it("leaves content fields alone without the flag", () => {
    expect(scrub({ title: "public post" })).toEqual({ title: "public post" });
  });
});

describe("recordReads", () => {
  it("records accessible endpoints and skips 401s instead of failing", async () => {
    const rf = vi.fn(async (_m: string, path: string) => {
      if (path === "/api/readinglist") throw new DevToApiError(401, { error: "unauthorized" }, "");
      return [{ id: 1 }];
    }) as unknown as Rf;
    const { recorded, skipped } = await recordReads(
      rf,
      [
        { template: "/api/articles", path: "/api/articles" },
        { template: "/api/readinglist", path: "/api/readinglist" },
      ],
      tmp(),
      0,
    );
    expect(recorded.map((r) => r.template)).toEqual(["/api/articles"]);
    expect(skipped).toEqual(["GET /api/readinglist (401)"]);
  });

  it("propagates unexpected errors", async () => {
    const rf = vi.fn(async () => {
      throw new DevToApiError(500, undefined, "boom");
    }) as unknown as Rf;
    await expect(
      recordReads(rf, [{ template: "/api/articles", path: "/api/articles" }], tmp(), 0),
    ).rejects.toThrow(/boom/);
  });

  it("stamps the concrete path and full envelope on each recording", async () => {
    const rf = vi.fn(async () => [{ id: 1 }]) as unknown as Rf;
    const { recorded } = await recordReads(
      rf,
      [{ template: "/api/articles", path: "/api/articles" }],
      tmp(),
      0,
    );
    expect(Object.keys(recorded[0] ?? {}).sort()).toEqual([
      "method",
      "path",
      "payload",
      "recordedAt",
      "template",
    ]);
    expect(recorded[0]?.path).toBe("/api/articles");
  });

  it("rejects a mislabeled spec at record time, before any request", async () => {
    const rf = vi.fn(async () => ({})) as unknown as Rf;
    await expect(
      // /api/users/me derives to itself (literal beats param), not /api/users/{id}
      recordReads(rf, [{ template: "/api/users/{id}", path: "/api/users/me" }], tmp(), 0),
    ).rejects.toThrow(/derives to \/api\/users\/me, not \/api\/users\/\{id\}/);
    expect(rf).not.toHaveBeenCalled();
  });

  it("persists fixtures 1..N before a crash on N+1 (incremental writes)", async () => {
    const dir = tmp();
    let n = 0;
    const rf = vi.fn(async () => {
      if (++n === 3) throw new DevToApiError(500, undefined, "boom");
      return [{ id: n }];
    }) as unknown as Rf;
    await expect(
      recordReads(
        rf,
        [
          { template: "/api/tags", path: "/api/tags" },
          { template: "/api/videos", path: "/api/videos" },
          { template: "/api/trends", path: "/api/trends" },
        ],
        dir,
        0,
      ),
    ).rejects.toThrow(/boom/);
    expect(readdirSync(dir).sort()).toEqual(["get_api-tags.json", "get_api-videos.json"]);
  });
});

describe("selectReads", () => {
  const all = [
    { template: "/api/tags", path: "/api/tags" },
    { template: "/api/videos", path: "/api/videos" },
  ];

  it("returns exactly the selected template", () => {
    expect(selectReads(all, ["/api/tags"])).toEqual([{ template: "/api/tags", path: "/api/tags" }]);
  });

  it("throws and records nothing when a selector matches nothing", () => {
    expect(() => selectReads(all, ["/api/taggs"])).toThrow(/matched no recordable endpoint/);
  });
});

describe("parseArgs", () => {
  it("collects repeatable --only selectors and a positional out dir", () => {
    expect(parseArgs(["--only", "/api/tags", "--only", "write-cycle"])).toEqual({
      only: ["/api/tags", "write-cycle"],
      outDir: "tests/fixtures/recorded",
    });
    expect(parseArgs(["/custom/dir"]).outDir).toBe("/custom/dir");
  });
});

describe("resolveTarget", () => {
  it("defaults to dev.to, DEVTO_API_KEY, and 3s pacing with no new vars (AE4)", () => {
    expect(resolveTarget({ DEVTO_API_KEY: "dk" })).toEqual({
      apiKey: "dk",
      baseUrl: "https://dev.to",
      allowInsecureHttp: false,
      pauseMs: 3000,
    });
  });

  it("prefers FOREM_API_KEY over DEVTO_API_KEY on the default host", () => {
    expect(resolveTarget({ FOREM_API_KEY: "fk", DEVTO_API_KEY: "dk" }).apiKey).toBe("fk");
  });

  it("hard-errors when a non-default host lacks FOREM_API_KEY", () => {
    expect(() =>
      resolveTarget({ FOREM_BASE_URL: "https://forem.example", DEVTO_API_KEY: "dk" }),
    ).toThrow(/never sent to a non-default host/);
  });

  it("allows insecure http only on a loopback host", () => {
    const local = resolveTarget({ FOREM_BASE_URL: "http://localhost:3000", FOREM_API_KEY: "fk" });
    expect(local.allowInsecureHttp).toBe(true);
    const remote = resolveTarget({
      FOREM_BASE_URL: "http://evil.example:3000",
      FOREM_API_KEY: "fk",
    });
    expect(remote.allowInsecureHttp).toBe(false);
    // https enforcement lives in resolveConfig — a non-loopback http URL is rejected there
    expect(() => resolveConfig({ baseUrl: remote.baseUrl })).toThrow(/must be https/);
  });

  it("reads the pacing override from FIXTURE_PAUSE_MS", () => {
    expect(resolveTarget({ DEVTO_API_KEY: "dk", FIXTURE_PAUSE_MS: "0" }).pauseMs).toBe(0);
  });
});

describe("recordWriteCycle", () => {
  it("skips the privilege-gated unpublish on 401 and still toggles the reaction back", async () => {
    const calls: string[] = [];
    const rf = vi.fn(async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (path.endsWith("/unpublish")) throw new DevToApiError(401, { error: "unauthorized" }, "");
      if (method === "POST" && path === "/api/articles") return { id: 42 };
      return {};
    }) as unknown as Rf;
    const recorded = await recordWriteCycle(rf, 7, tmp());
    expect(calls.filter((c) => c.includes("toggle"))).toHaveLength(2);
    expect(recorded.map((r) => r.template)).not.toContain("/api/articles/{id}/unpublish");
  });

  it("skips the reaction toggle when the key lacks the privilege (401)", async () => {
    const rf = vi.fn(async (method: string, path: string) => {
      if (path === "/api/reactions/toggle")
        throw new DevToApiError(401, { error: "unauthorized" }, "");
      if (method === "POST" && path === "/api/articles") return { id: 42 };
      return {};
    }) as unknown as Rf;
    const recorded = await recordWriteCycle(rf, 7, tmp());
    expect(recorded.map((r) => r.template)).not.toContain("/api/reactions/toggle");
  });

  it("propagates a non-privilege error from the reaction toggle", async () => {
    const rf = vi.fn(async (method: string, path: string) => {
      if (path === "/api/reactions/toggle") throw new DevToApiError(500, undefined, "boom");
      if (method === "POST" && path === "/api/articles") return { id: 42 };
      return {};
    }) as unknown as Rf;
    await expect(recordWriteCycle(rf, 7, tmp())).rejects.toThrow(/boom/);
  });

  it("warns instead of throwing when only the reversal toggle fails", async () => {
    let toggles = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rf = vi.fn(async (method: string, path: string) => {
      if (path === "/api/reactions/toggle" && ++toggles === 2)
        throw new DevToApiError(500, undefined, "boom");
      if (method === "POST" && path === "/api/articles") return { id: 42 };
      return {};
    }) as unknown as Rf;
    const recorded = await recordWriteCycle(rf, 7, tmp());
    expect(recorded.map((r) => r.template)).toContain("/api/reactions/toggle");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("REVERSAL FAILED"));
    warn.mockRestore();
  });

  it("runs create → update → unpublish → toggle in order, stamping each concrete path", async () => {
    const dir = tmp();
    const calls: [string, string, unknown][] = [];
    const rf = vi.fn(
      async (method: string, path: string, opts?: { body?: unknown; query?: unknown }) => {
        calls.push([method, path, opts?.body ?? opts?.query]);
        if (method === "POST" && path === "/api/articles") return { id: 42, published: false };
        if (path === "/api/reactions/toggle") return { result: "create", category: "like" };
        return {};
      },
    ) as unknown as Rf;

    const recorded = await recordWriteCycle(rf, 7, dir);

    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      "POST /api/articles",
      "PUT /api/articles/42",
      "PUT /api/articles/42/unpublish",
      "POST /api/reactions/toggle",
      "POST /api/reactions/toggle", // the reversal — no residue
    ]);
    const createBody = calls[0]?.[2] as { article: { published: boolean; title: string } };
    expect(createBody.article.published).toBe(false);
    expect(createBody.article.title).toContain("fixture");
    expect(recorded.map((r) => `${r.method} ${r.template}`)).toEqual([
      "POST /api/articles",
      "PUT /api/articles/{id}",
      "PUT /api/articles/{id}/unpublish",
      "POST /api/reactions/toggle",
    ]);
    // every envelope carries the concrete path it was recorded from (R8)
    expect(recorded.map((r) => r.path)).toEqual([
      "/api/articles",
      "/api/articles/42",
      "/api/articles/42/unpublish",
      "/api/reactions/toggle",
    ]);
    // and each was persisted to disk as it landed (KTD4)
    expect(readdirSync(dir)).toHaveLength(4);
  });
});

describe("buildRecorderConfig (U5)", () => {
  const cfg = (): ReturnType<typeof buildRecorderConfig> =>
    buildRecorderConfig({ DEVTO_API_KEY: "k" } as NodeJS.ProcessEnv);

  it("carries an explicit pacer slower than the library default", async () => {
    const waits: number[] = [];
    const pace = cfg().pace;
    expect(pace).not.toBeNull();
    const deadlineAt = Date.now() + 120_000;
    await pace?.acquire("read", { deadlineAt, signal: undefined });
    const started = Date.now();
    await pace?.acquire("read", { deadlineAt, signal: undefined });
    waits.push(Date.now() - started);
    // the default 3/s would hold this for ~334ms; the recorder's 1/s holds ~1s
    expect(waits[0]).toBeGreaterThan(500);
  }, 5000);

  it("resolves a deadline that makes its own retry schedule reachable", () => {
    const { retry, timeoutMs } = cfg();
    expect(retry).not.toBeNull();
    if (!retry) throw new Error("retry disabled");
    expect(timeoutMs).toBeGreaterThan(retry.attempts * retry.throttleDelayMs);
  });
});
