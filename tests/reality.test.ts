import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { compose, type OverlayEntry } from "../scripts/compose-spec.ts";
import { deriveTemplate } from "../scripts/spec-templates.ts";
import type { components } from "../src/generated/types.ts";

/**
 * R17: recorded reality vs the composed spec. Each recorded fixture is
 * checked for key-completeness against the spec's declared property list:
 * the spec has no `required` lists, so generated properties are all optional
 * and type assignment alone cannot see a removed or renamed field.
 * Empty recordings are vacuous: reported, not counted as verified.
 */

interface Recorded {
  template: string;
  method: string;
  /** The concrete request path the recording hit (R8); the template is derived from it, not trusted. */
  path: string;
  payload: unknown;
}

type Schema = {
  $ref?: string;
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
};

const spec = compose(
  JSON.parse(readFileSync("spec/api_v1.json", "utf8")),
  JSON.parse(readFileSync("spec/overlay.json", "utf8")) as OverlayEntry[],
).spec as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema> };
};

function deref(schema: Schema): Schema {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1) ?? "";
    const target = spec.components.schemas[name];
    if (!target) throw new Error(`unresolvable $ref: ${schema.$ref}`);
    return deref(target);
  }
  return schema;
}

/** Property names the composed spec declares for a schema (allOf merged). */
function declaredKeys(schema: Schema): string[] {
  const resolved = deref(schema);
  if (resolved.allOf) return resolved.allOf.flatMap((s) => declaredKeys(s));
  return Object.keys(resolved.properties ?? {});
}

/**
 * Success schema for an operation, distinguishing three cases the old code
 * conflated into `null`: the template vanished upstream (`removed`), the op
 * exists but declares no JSON body (`none`, a legitimate 204), or a real
 * schema (`schema`).
 */
type SchemaLookup = { kind: "schema"; schema: Schema } | { kind: "none" } | { kind: "removed" };

function successSchema(template: string, method: string): SchemaLookup {
  if (!(template in spec.paths)) return { kind: "removed" };
  const op = spec.paths[template]?.[method.toLowerCase()] as
    | { responses?: Record<string, { content?: { "application/json"?: { schema?: Schema } } }> }
    | undefined;
  for (const code of ["200", "201"]) {
    const schema = op?.responses?.[code]?.content?.["application/json"]?.schema;
    if (schema) return { kind: "schema", schema };
  }
  return { kind: "none" };
}

function isVacuous(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.length === 0;
  if (payload !== null && typeof payload === "object") {
    return Object.keys(payload).length === 0;
  }
  return payload === null || payload === undefined;
}

/**
 * Keys the spec declares that the payload never carries. For arrays the keys
 * are unioned across elements: serializers omit conditional fields (e.g.
 * `organization` only when the article has one), so any element carrying the
 * key proves the server still sends it.
 */
function missingKeys(payload: unknown, schema: Schema): string[] {
  const resolved = deref(schema);
  const seen = carriedKeys(payload);
  if (resolved.type === "array" && resolved.items) {
    if (!Array.isArray(payload)) return ["<payload is not an array>"];
    return declaredKeys(resolved.items).filter((k) => !seen.has(k));
  }
  if (payload === null || typeof payload !== "object") return ["<payload is not an object>"];
  return declaredKeys(resolved).filter((k) => !seen.has(k));
}

/** Keys any element of the payload actually carries; a bare object counts as one element. */
function carriedKeys(payload: unknown): Set<string> {
  const elements = Array.isArray(payload) ? payload : [payload];
  return new Set(
    elements.flatMap((el) => (el !== null && typeof el === "object" ? Object.keys(el) : [])),
  );
}

/**
 * Keys the article serializer emits only when the data exists: org membership, a flare tag.
 * Not checked per endpoint: whether a given page of articles happens to contain one is a coin
 * flip, and that flakiness has filed a false drift alarm twice. The drift signal lives in the
 * "still sent somewhere" test below instead, which fails if the server drops a key everywhere.
 */
const CONDITIONAL_KEYS = ["organization", "flare_tag"];

const FIXTURES_DIR = process.env.FIXTURES_DIR ?? "tests/fixtures/recorded";
const files = existsSync(FIXTURES_DIR)
  ? readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"))
  : [];

/**
 * R9 test-time chain of custody: the label is derived from the stored path, never
 * trusted. A missing path or a mismatch fails loudly (AE3). A named function so the
 * wiring itself is unit-tested below, not just exercised on the (clean) committed fixtures.
 */
function assertStoredLabel(
  rec: { path?: unknown; method: string; template: string },
  specPaths: Record<string, Record<string, unknown>>,
  label = `${rec.method} ${rec.template}`,
): void {
  if (typeof rec.path !== "string" || rec.path === "") {
    throw new Error(`fixture ${label} has no recorded path, re-record it`);
  }
  const derived = deriveTemplate(rec.path, rec.method, specPaths);
  if (derived !== rec.template) {
    throw new Error(
      `template mismatch in ${label}: ${rec.method} ${rec.path} derives to ${derived}, not the labeled ${rec.template}`,
    );
  }
}

describe("recorded fixtures vs composed spec", () => {
  it("has committed fixtures to verify", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  const vacuous: string[] = [];
  const seenConditional = new Set<string>();

  for (const file of files) {
    const rec = JSON.parse(readFileSync(`${FIXTURES_DIR}/${file}`, "utf8")) as Recorded;

    it(`${rec.method} ${rec.template} is verified from its stored path`, () => {
      assertStoredLabel(rec, spec.paths, file);

      const lookup = successSchema(rec.template, rec.method);
      if (lookup.kind === "removed") {
        throw new Error(`template no longer exists in the spec: ${rec.template}`);
      }
      if (isVacuous(rec.payload)) {
        vacuous.push(`${rec.method} ${rec.template}`);
        return; // vacuous, reported below, not counted as verified
      }
      if (lookup.kind === "none") {
        // op exists but declares no JSON body: a legitimate 204
        expect(rec.payload).toBeNull();
        return;
      }
      const carried = carriedKeys(rec.payload);
      for (const k of CONDITIONAL_KEYS) if (carried.has(k)) seenConditional.add(k);

      const missing = missingKeys(rec.payload, lookup.schema).filter(
        (k) => !CONDITIONAL_KEYS.includes(k),
      );
      expect(missing).toEqual([]);
    });
  }

  it("reports vacuous recordings as unverified rather than passing them", () => {
    for (const v of vacuous) {
      console.warn(`vacuous recording (unverified): ${v}`);
    }
    // vacuous entries must be the exception, not the recorded tier
    expect(vacuous.length).toBeLessThan(Math.max(1, files.length / 2));
  });

  // The alarm the per-endpoint allowlist used to raise, minus the coin flip: skipping a
  // conditional key everywhere would hide the server dropping it everywhere, so prove at
  // least one fixture still carries each one.
  it("proves each conditional key is still sent somewhere", () => {
    expect(CONDITIONAL_KEYS.filter((k) => !seenConditional.has(k))).toEqual([]);
  });
});

describe("mechanism meta-tests", () => {
  it("a fixture missing a spec-declared key fails the completeness check", () => {
    const schema: Schema = { type: "object", properties: { id: {}, title: {} } };
    expect(missingKeys({ id: 1 }, schema)).toEqual(["title"]);
  });

  it("array payloads union keys across elements", () => {
    const schema: Schema = {
      type: "array",
      items: { type: "object", properties: { id: {}, organization: {} } },
    };
    expect(missingKeys([{ id: 1 }, { id: 2, organization: {} }], schema)).toEqual([]);
    expect(missingKeys([{ id: 1 }], schema)).toEqual(["organization"]);
  });

  it("classifies empty recordings as vacuous", () => {
    expect(isVacuous([])).toBe(true);
    expect(isVacuous({})).toBe(true);
    expect(isVacuous(null)).toBe(true);
    expect(isVacuous([{ id: 1 }])).toBe(false);
  });

  it("a deliberately corrupted fixture fails the compile-time type test", () => {
    // @ts-expect-error: type_of must be a string, not a number
    const corrupted: components["schemas"]["ArticleIndex"] = { type_of: 42 };
    void corrupted;
    expect(true).toBe(true);
  });

  // Skipping the conditional keys everywhere is only safe while every schema declaring them is
  // an article serializer, where they really are conditional. A fifth name here means some other
  // response grew an `organization` that the skip would silently stop checking.
  it("only the article serializers declare the conditional keys", () => {
    const owners = Object.entries(spec.components.schemas)
      .filter(([, s]) => CONDITIONAL_KEYS.some((k) => s.properties?.[k]))
      .map(([name]) => name);
    expect(owners).toEqual(["ArticleIndex", "ArticleShow", "MyArticle", "ReadingListArticle"]);
  });

  it("resolves $refs through the composed spec", () => {
    expect(declaredKeys({ $ref: "#/components/schemas/ArticleIndex" })).toContain("title");
    expect(() => declaredKeys({ $ref: "#/components/schemas/Nope" })).toThrow(/unresolvable/);
  });

  it("AE3: a mislabeled fixture (path derives to a different template) is rejected", () => {
    // path /api/users/me labeled as /api/users/{id}: literal beats param (KTD2)
    expect(() =>
      assertStoredLabel(
        { method: "GET", template: "/api/users/{id}", path: "/api/users/me" },
        spec.paths,
      ),
    ).toThrow(/template mismatch/);
    // the correctly-labeled fixture passes
    expect(() =>
      assertStoredLabel(
        { method: "GET", template: "/api/users/me", path: "/api/users/me" },
        spec.paths,
      ),
    ).not.toThrow();
  });

  it("a fixture with no stored path is rejected", () => {
    expect(() =>
      assertStoredLabel({ method: "GET", template: "/api/tags", path: "" }, spec.paths),
    ).toThrow(/no recorded path/);
  });

  it("flags a template that has vanished from the spec as removed, not schema-less", () => {
    expect(successSchema("/api/deleted_upstream", "get")).toEqual({ kind: "removed" });
    // a real schema-less op (unpublish → 204) is distinct
    expect(successSchema("/api/articles/{id}/unpublish", "put").kind).toBe("none");
  });
});
