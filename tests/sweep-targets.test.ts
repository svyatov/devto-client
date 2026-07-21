import { describe, expect, it } from "bun:test";
import { deriveTemplate } from "../scripts/spec-templates.ts";
import { CAUSES } from "../scripts/sweep-local.ts";
import {
  buildTargets,
  type Discovered,
  paramPlacement,
  readTemplates,
  specOperations,
  writeOperations,
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
  targetUserId: 15,
  mergeUserId: 16,
  runId: "test",
  imageUrl: "https://example.com/image.png",
  // everything here was discovered, so nothing carries the ledger's 404 rule
  ledgerFields: [],
  created: {
    agentSession: 20,
    article: 21,
    badge: 22,
    badgeAchievement: 23,
    billboard: 24,
    concept: 25,
    organization: 26,
    page: 27,
    recommendedArticlesList: 28,
    requestRedirect: 29,
    segment: 30,
    userIdentity: 31,
  },
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
      expect(CAUSES).toContain(t.cause);
      expect(t.reason.length).toBeGreaterThan(0);
    }
  });

  // Pass one's completeness proof, rewritten to pass two's totals: 129 of the 130
  // resolve to a concrete request, and the one holdout is the feedback-message
  // update, whose identifier no operation in the spec lists or creates.
  it("targets 129 of 130 operations and defers none on a full discovery record", () => {
    expect(
      targets.filter((t) => t.kind === "skipped" && t.cause === "prerequisite-failed"),
    ).toEqual([]);
    expect(targets.filter((t) => t.kind === "targeted").length).toBe(129);
    const skipped = targets.filter((t) => t.kind === "skipped");
    expect(skipped.map(key)).toEqual(["PATCH /api/feedback_messages/{id}"]);
  });

  it("defines a recipe for every non-GET operation in the spec, and none the spec lacks", () => {
    const declared = specOperations()
      .filter((o) => o.method !== "GET")
      .map(key)
      .sort();
    expect(writeOperations().sort()).toEqual(declared);
    expect(declared.length).toBe(55);
  });

  it("produces two distinct entries for a template carrying two verbs", () => {
    const badge = targets.filter((t) => t.template === "/api/badges/{id}" && t.method !== "GET");
    expect(badge.map((t) => t.method).sort()).toEqual(["DELETE", "PATCH"]);
    expect(badge.every((t) => t.kind === "targeted")).toBe(true);
    // and the two carry different requests, which a template-keyed table could not express
    const patch = badge.find((t) => t.method === "PATCH");
    const del = badge.find((t) => t.method === "DELETE");
    expect(patch?.kind === "targeted" && patch.body).toBeDefined();
    expect(del?.kind === "targeted" && del.body).toBeUndefined();
  });

  it("places every write's params where the generated routing table says, and never contradicts it", () => {
    for (const t of targets) {
      if (t.kind !== "targeted" || t.method === "GET") continue;
      const placement = paramPlacement(t.template, t.method);
      if (placement === "query") {
        expect({ op: key(t), body: t.body }).toEqual({ op: key(t), body: undefined });
      } else if (placement === "body") {
        expect({ op: key(t), query: t.query }).toEqual({ op: key(t), query: undefined });
      } else {
        // the generator omits operations taking no params object: those recipes may
        // declare their own placement, and none of them declares one here
        expect({ op: key(t), query: t.query, body: t.body }).toEqual({
          op: key(t),
          query: undefined,
          body: undefined,
        });
      }
    }
  });

  it("names the missing prerequisite rather than throwing when a created identifier is absent", () => {
    const { created: _dropped, ...noCreates } = FULL;
    const built = buildTargets(noCreates);
    const update = built.find((t) => key(t) === "PUT /api/articles/{id}");
    expect(update?.kind).toBe("skipped");
    if (update?.kind === "skipped") {
      expect(update.cause).toBe("prerequisite-failed");
      expect(update.reason).toBe("not created by this run: article");
    }
    // the creates themselves need nothing from the ledger and stay targeted
    expect(built.find((t) => key(t) === "POST /api/articles")?.kind).toBe("targeted");
  });

  it("blocks exactly the operations needing an absent discoverable, leaving the rest targeted", () => {
    const noSegment = buildTargets(without("segmentId"));
    const blocked = noSegment.filter((t) => t.kind === "skipped" && t.cause === "blocked");
    expect(blocked.map(key).sort()).toEqual([
      "GET /api/segments/{id}",
      "GET /api/segments/{id}/users",
      "PATCH /api/feedback_messages/{id}", // blocked on every record; see the totals test
    ]);
    for (const t of blocked) {
      if (t.kind === "skipped" && t.template.startsWith("/api/segments")) {
        expect(t.reason).toBe("discovery unavailable: segmentId");
      }
    }
    // and every other operation is untouched
    expect(noSegment.filter((t) => t.kind === "targeted").length).toBe(127);
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
