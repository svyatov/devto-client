import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compose, type OverlayEntry } from "../scripts/compose-spec.ts";
import { deriveTemplate } from "../scripts/spec-templates.ts";

// Compose in-memory from the committed source files — spec/composed.json is
// gitignored and absent on a fresh checkout / in CI.
const specPaths = (
  compose(
    JSON.parse(readFileSync("spec/api_v1.json", "utf8")),
    JSON.parse(readFileSync("spec/overlay.json", "utf8")) as OverlayEntry[],
  ).spec as { paths: Record<string, Record<string, unknown>> }
).paths;

const isParam = (seg: string): boolean => seg.startsWith("{") && seg.endsWith("}");

describe("deriveTemplate", () => {
  it("literal segment beats a param segment", () => {
    expect(deriveTemplate("/api/articles/search", "GET")).toBe("/api/articles/search");
    expect(deriveTemplate("/api/articles/latest", "GET")).toBe("/api/articles/latest");
    expect(deriveTemplate("/api/users/me", "GET")).toBe("/api/users/me");
  });

  it("breaks the organizations param-vs-param tie by method then numeric segment", () => {
    expect(deriveTemplate("/api/organizations/acme", "GET")).toBe("/api/organizations/{username}");
    expect(deriveTemplate("/api/organizations/123", "GET")).toBe("/api/organizations/{id}");
    expect(deriveTemplate("/api/organizations/acme", "PUT")).toBe("/api/organizations/{id}");
  });

  it("ignores the query string", () => {
    expect(deriveTemplate("/api/articles?page=2", "GET")).toBe("/api/articles");
  });

  it("throws naming the path when nothing matches", () => {
    expect(() => deriveTemplate("/api/nope", "GET")).toThrow(/\/api\/nope/);
  });

  it("throws when a param-vs-param tie survives method and numeric fit", () => {
    // Two same-literal-count templates, both serving GET, both non-idish params
    // against a numeric segment — nothing breaks the tie, so it must fail loudly.
    const ambiguous = { "/api/x/{foo}": { get: {} }, "/api/x/{bar}": { get: {} } };
    expect(() => deriveTemplate("/api/x/123", "GET", ambiguous)).toThrow(/ambiguous/);
  });

  it("round-trips every non-colliding template filled with dummy params", () => {
    const orgTie = new Set(["/api/organizations/{username}", "/api/organizations/{id}"]);
    for (const template of Object.keys(specPaths)) {
      if (orgTie.has(template)) continue; // exercised by the dedicated tie-break scenario
      const path = template
        .split("/")
        .map((seg) => (isParam(seg) ? (/id/i.test(seg) ? "123" : "abc") : seg))
        .join("/");
      // GET is always a safe probe method: the round-trip only needs the path to
      // resolve back to its own template, and literal/fit rules are method-agnostic here.
      expect(deriveTemplate(path, "GET")).toBe(template);
    }
  });
});
