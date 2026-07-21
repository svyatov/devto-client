import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { compose, type OverlayEntry, validateProvenance } from "../scripts/compose-spec.ts";
import { governedOps, isCorroborated, recordedPayload } from "../scripts/overlay-provenance.ts";
import { opKey } from "../scripts/sweep-local.ts";
import { specOperations } from "../scripts/sweep-targets.ts";

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
  provenance: { instrument: "spec-structure", corroborated: false },
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
    expect(composed.paths["/api/things"].get.responses["200"] as unknown).toEqual({
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

  it("fails when the final key is missing from a valid parent", () => {
    expect(() =>
      compose(base(), [
        entry({ target: "/paths/~1api~1things/get/missing", expect: { anything: true } }),
      ]),
    ).toThrow(/dangling target \(missing "missing"\)/);
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

describe("provenance", () => {
  const withProvenance = (provenance: unknown): OverlayEntry =>
    ({ ...entry({}), provenance }) as OverlayEntry;

  it("composes an entry carrying a well-formed field unchanged", () => {
    const { spec } = compose(base(), [
      withProvenance({ instrument: "local-forem", forem: "ae359ff41b2a", corroborated: false }),
    ]);
    expect((spec as ReturnType<typeof base>).components.schemas).toEqual({
      Thing: { type: "object" },
    });
  });

  it("composes an entry with no provenance at all, so the field is genuinely optional", () => {
    const { provenance: _dropped, ...bare } = entry({});
    expect(() => compose(base(), [bare])).not.toThrow();
  });

  // the array-guard prevention rule: a verification mechanism whose failure mode
  // is silence needs a test proving it can come back dirty
  it.each([
    ["not an object", "must be an object", "local-forem"],
    ["a bad instrument", "instrument must be one of", { instrument: "vibes", corroborated: false }],
    [
      "a non-boolean corroborated",
      "corroborated must be a boolean",
      { instrument: "devto-fixture", corroborated: "yes" },
    ],
    [
      "a non-string forem",
      "forem must be a string",
      { instrument: "devto-fixture", corroborated: false, forem: 12 },
    ],
    [
      "a local claim with no Forem commit",
      "must name the Forem commit",
      { instrument: "local-forem", corroborated: false },
    ],
  ])("fails composition on %s, naming the entry", (_label, message, provenance) => {
    expect(() => compose(base(), [withProvenance(provenance)])).toThrow(
      new RegExp(`/components/schemas/Thing: provenance.*${message.replaceAll(" ", "\\s")}`),
    );
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

  // a hand-edited entry cannot drift past the shape check, since composition runs
  // the same validator over every entry the real Overlay carries
  it("every entry in the Overlay carries a valid provenance field or none", () => {
    for (const e of overlay as OverlayEntry[]) {
      expect(() => validateProvenance(e)).not.toThrow();
    }
  });

  it("gives every entry claiming observation a provenance field", () => {
    const claiming = (overlay as OverlayEntry[]).filter((e) =>
      e.reason.startsWith("reality correction:"),
    );
    expect(claiming).toHaveLength(25);
    expect(claiming.filter((e) => e.provenance === undefined)).toEqual([]);
  });

  it("derives corroboration from an actual shape comparison, not from fixture existence", () => {
    for (const e of overlay as OverlayEntry[]) {
      if (e.provenance === undefined) continue;
      // a local observation admits no corroboration at all: dev.to cannot be asked
      // what a Forem commit renders, so the comparison does not apply to these
      if (e.provenance.instrument === "local-forem") {
        expect({ target: e.target, corroborated: e.provenance.corroborated }).toEqual({
          target: e.target,
          corroborated: false,
        });
        continue;
      }
      expect({ target: e.target, corroborated: e.provenance.corroborated }).toEqual({
        target: e.target,
        corroborated: isCorroborated(e),
      });
    }
  });

  // AE2: the write half's only corroboration. Two of the 55 writes have a
  // recorded dev.to response, and the run's local observations agree with both.
  it("corroborates exactly the two writes that have a recorded dev.to fixture", () => {
    const writes = specOperations().filter((o) => o.method !== "GET");
    const corroborated = writes.filter((o) => recordedPayload(o) !== undefined).map(opKey);
    expect(corroborated).toEqual(["POST /api/articles", "PUT /api/articles/{id}"]);
  });

  // the triage rule for uncorroborated observations: a local-only claim may add a
  // key the spec omits, never remove or retype one it declares
  it("applies no local-only correction that removes or retypes a declared key", () => {
    for (const e of overlay as OverlayEntry[]) {
      if (e.provenance?.instrument !== "local-forem") continue;
      // `expect: null` asserts the node is absent today, so the entry can only add.
      // The two path entries carry a real `expect` because they replace a schema
      // upstream declared malformed, which types out as `unknown` either way.
      const additive = e.expect === null;
      const structuralRepair = e.target.startsWith("/paths/") && e.patch !== null;
      expect({ target: e.target, ok: additive || structuralRepair }).toEqual({
        target: e.target,
        ok: true,
      });
      expect(e.patch).not.toBeNull();
    }
  });

  it("claims corroboration for no entry whose operations have no recorded fixture", () => {
    for (const e of overlay as OverlayEntry[]) {
      if (e.provenance?.corroborated !== true) continue;
      const withFixture = governedOps(e.target).filter((op) => recordedPayload(op) !== undefined);
      expect({ target: e.target, fixtures: withFixture.length > 0 }).toEqual({
        target: e.target,
        fixtures: true,
      });
    }
  });

  // pinned so a later hand edit that shifts the evidence mix is visible in review
  it("pins the count of entries carrying each instrument", () => {
    const mix: Record<string, number> = {};
    for (const e of overlay as OverlayEntry[]) {
      if (e.provenance === undefined) continue;
      const key = `${e.provenance.instrument}/${e.provenance.corroborated}`;
      mix[key] = (mix[key] ?? 0) + 1;
    }
    expect(mix).toEqual({
      "devto-fixture/true": 17,
      "devto-fixture/false": 3,
      "forem-source/false": 2,
      "spec-structure/true": 1,
      "spec-structure/false": 2,
      // pass two's own corrections: 32 billboard fields plus the two billboard
      // write responses whose "writes are deferred" caveat the run retired
      "local-forem/false": 34,
    });
  });
});
