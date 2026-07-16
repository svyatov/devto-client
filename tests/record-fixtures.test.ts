import { describe, expect, it, vi } from "vitest";
import { type Rf, recordReads, recordWriteCycle, scrub } from "../scripts/record-fixtures.ts";
import { DevToApiError } from "../src/errors.ts";

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
      recordReads(rf, [{ template: "/api/articles", path: "/api/articles" }], 0),
    ).rejects.toThrow(/boom/);
  });
});

describe("recordWriteCycle", () => {
  it("creates a draft, updates, unpublishes, and toggles the reaction back off", async () => {
    const calls: [string, string, unknown][] = [];
    const rf = vi.fn(
      async (method: string, path: string, opts?: { body?: unknown; query?: unknown }) => {
        calls.push([method, path, opts?.body ?? opts?.query]);
        if (method === "POST" && path === "/api/articles") return { id: 42, published: false };
        if (path === "/api/reactions/toggle") return { result: "create", category: "like" };
        return {};
      },
    ) as unknown as Rf;

    const recorded = await recordWriteCycle(rf, 7);

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
  });
});
