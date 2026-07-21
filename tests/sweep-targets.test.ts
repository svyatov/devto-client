import { describe, expect, it } from "bun:test";
import { deriveTemplate } from "../scripts/spec-templates.ts";
import {
  buildTargets,
  type Discovered,
  readTemplates,
  specOperations,
} from "../scripts/sweep-targets.ts";

/** A record where every discoverable is present, so only genuine gaps block an entry. */
const FULL: Required<Discovered> = {
  articleId: 1,
  username: "someuser",
  slug: "some-slug",
  userId: 2,
  userEmail: "someone@example.com",
  organization: "someorg",
  organizationId: 3,
  commentId: "abc123",
  tag: "javascript",
  pageId: 4,
  badgeId: 5,
  badgeAchievementId: 6,
  billboardId: 7,
  conceptId: 8,
  segmentId: 9,
  surveyId: 10,
  trendId: 11,
  recommendedArticlesListId: 12,
  requestRedirectId: 13,
  agentSessionId: 14,
  analyticsStart: "2026-01-01",
};

const key = (o: { template: string; method: string }): string => `${o.method} ${o.template}`;

/** Drop a discoverable. Plain `{...FULL, x: undefined}` is a type error under exactOptionalPropertyTypes. */
const without = (field: keyof Discovered): Discovered => {
  const { [field]: _dropped, ...rest } = FULL;
  return rest;
};

describe("sweep targets table", () => {
  const targets = buildTargets(FULL);

  it("covers every path-and-method pair in the spec exactly once", () => {
    const declared = specOperations().map(key).sort();
    const covered = targets.map(key).sort();
    expect(covered).toEqual(declared);
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("has no read entry without a matching GET operation in the spec", () => {
    const specGets = new Set(
      specOperations()
        .filter((o) => o.method === "GET")
        .map((o) => o.template),
    );
    expect(readTemplates().filter((t) => !specGets.has(t))).toEqual([]);
  });

  it("defines a concrete request for every GET the spec declares", () => {
    const undefined_ = targets.filter(
      (t) => t.kind === "skipped" && t.reason === "no sweep target defined for this operation",
    );
    expect(undefined_.map(key)).toEqual([]);
  });

  it("derives every targeted path back to its own template", () => {
    for (const t of targets) {
      if (t.kind !== "targeted") continue;
      expect(deriveTemplate(t.path, t.method ?? "GET")).toBe(t.template);
    }
  });

  it("gives every skipped entry a cause and a non-empty reason", () => {
    for (const t of targets) {
      if (t.kind !== "skipped") continue;
      expect(["blocked", "deferred"]).toContain(t.cause);
      expect(t.reason.length).toBeGreaterThan(0);
    }
  });

  it("defers all 55 write operations and targets all 75 reads on a full discovery record", () => {
    const deferred = targets.filter((t) => t.kind === "skipped" && t.cause === "deferred");
    expect(deferred.length).toBe(55);
    expect(deferred.every((t) => t.method !== "GET")).toBe(true);
    expect(targets.filter((t) => t.kind === "targeted").length).toBe(75);
  });

  it("blocks exactly the operations needing an absent discoverable, leaving the rest targeted", () => {
    const noSegment = buildTargets(without("segmentId"));
    const blocked = noSegment.filter((t) => t.kind === "skipped" && t.cause === "blocked");
    expect(blocked.map(key).sort()).toEqual([
      "GET /api/segments/{id}",
      "GET /api/segments/{id}/users",
    ]);
    for (const t of blocked) {
      if (t.kind === "skipped") expect(t.reason).toBe("discovery unavailable: segmentId");
    }
    // and the other 73 reads are untouched
    expect(noSegment.filter((t) => t.kind === "targeted").length).toBe(73);
  });

  it("blocks the username-and-slug read when either half is missing", () => {
    const noSlug = buildTargets(without("slug"));
    const entry = noSlug.find((t) => key(t) === "GET /api/articles/{username}/{slug}");
    expect(entry?.kind).toBe("skipped");
    if (entry?.kind === "skipped") expect(entry.reason).toBe("discovery unavailable: slug");
  });

  it("blocks every read on an empty discovery record without throwing", () => {
    const empty = buildTargets({});
    expect(empty.length).toBe(130);
    expect(empty.every((t) => t.kind === "skipped")).toBe(false); // parameterless reads still run
    const blocked = empty.filter((t) => t.kind === "skipped" && t.cause === "blocked");
    expect(blocked.length).toBeGreaterThan(0);
  });
});
