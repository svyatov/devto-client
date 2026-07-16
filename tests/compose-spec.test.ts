import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compose, type OverlayEntry } from "../scripts/compose-spec.ts";

const base = () => ({
  paths: {
    "/api/things": {
      get: {
        parameters: [
          { name: "page", in: "query" },
          { name: "per_page", in: "query" },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: { schemas: {} },
});

const entry = (over: Partial<OverlayEntry>): OverlayEntry => ({
  target: "/components/schemas/Thing",
  expect: null,
  reason: "missing schema",
  patch: { type: "object" },
  ...over,
});

describe("compose", () => {
  it("applies a patch to the right pointer", () => {
    const { spec } = compose(base(), [entry({})]);
    expect((spec as ReturnType<typeof base>).components.schemas).toEqual({
      Thing: { type: "object" },
    });
  });

  it("replaces an existing node when expect matches", () => {
    const { spec } = compose(base(), [
      entry({
        target: "/paths/~1api~1things/get/responses/200",
        expect: { description: "ok" },
        patch: { description: "ok", content: {} },
      }),
    ]);
    const composed = spec as ReturnType<typeof base>;
    expect(composed.paths["/api/things"].get.responses["200"]).toEqual({
      description: "ok",
      content: {},
    });
  });

  it("removes a node when patch is null", () => {
    const { spec } = compose(base(), [
      entry({
        target: "/paths/~1api~1things/get/parameters/1",
        expect: { name: "per_page" },
        patch: null,
      }),
    ]);
    expect((spec as ReturnType<typeof base>).paths["/api/things"].get.parameters).toEqual([
      { name: "page", in: "query" },
    ]);
  });

  it("fails on a dangling target", () => {
    expect(() =>
      compose(base(), [entry({ target: "/paths/~1api~1missing/get/responses" })]),
    ).toThrow(/dangling target/);
  });

  it("fails when expect no longer matches the target node", () => {
    // simulated upstream reorder: index 0 is now per_page, not page
    expect(() =>
      compose(base(), [
        entry({
          target: "/paths/~1api~1things/get/parameters/0",
          expect: { name: "per_page" },
          patch: null,
        }),
      ]),
    ).toThrow(/expect mismatch/);
  });

  it("fails when expect is null but the node already exists", () => {
    expect(() =>
      compose(base(), [entry({ target: "/paths/~1api~1things/get/responses/200" })]),
    ).toThrow(/already exists/);
  });

  it("reports a no-op entry as deletable", () => {
    const { deletable } = compose(base(), [
      entry({
        target: "/paths/~1api~1things/get/responses/200",
        expect: { description: "ok" },
        patch: { description: "ok" },
      }),
    ]);
    expect(deletable).toEqual(["/paths/~1api~1things/get/responses/200"]);
  });

  it("fails on an empty reason", () => {
    expect(() => compose(base(), [entry({ reason: " " })])).toThrow(/reason/);
  });
});

describe("composed real spec", () => {
  const snapshot = JSON.parse(readFileSync("spec/api_v1.json", "utf8"));
  const overlay = JSON.parse(readFileSync("spec/overlay.json", "utf8"));
  const { spec } = compose(snapshot, overlay);
  const paths = (
    spec as {
      paths: Record<string, Record<string, { parameters?: { name?: string; $ref?: string }[] }>>;
    }
  ).paths;

  it("has no duplicate page param on GET /api/comments", () => {
    const params = paths["/api/comments"]?.get?.parameters ?? [];
    const pageish = params.filter(
      (p) => p.name === "page" || p.$ref === "#/components/parameters/pageParam",
    );
    expect(pageish).toHaveLength(1);
  });

  it("every overlay entry has a non-empty reason", () => {
    for (const e of overlay as OverlayEntry[]) {
      expect(e.reason.trim()).not.toBe("");
    }
  });

  it("reports no deletable entries against the current snapshot", () => {
    expect(compose(snapshot, overlay).deletable).toEqual([]);
  });
});
