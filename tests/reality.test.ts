import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compose, type OverlayEntry } from "../scripts/compose-spec.ts";
import type { components } from "../src/generated/types.ts";

/**
 * R17: recorded reality vs the composed spec. Each recorded fixture is
 * checked for key-completeness against the spec's declared property list —
 * the spec has no `required` lists, so generated properties are all optional
 * and type assignment alone cannot see a removed or renamed field.
 * Empty recordings are vacuous: reported, not counted as verified.
 */

interface Recorded {
  template: string;
  method: string;
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

function successSchema(template: string, method: string): Schema | null {
  const op = spec.paths[template]?.[method.toLowerCase()] as
    | { responses?: Record<string, { content?: { "application/json"?: { schema?: Schema } } }> }
    | undefined;
  for (const code of ["200", "201"]) {
    const schema = op?.responses?.[code]?.content?.["application/json"]?.schema;
    if (schema) return schema;
  }
  return null;
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
 * are unioned across elements — serializers omit conditional fields (e.g.
 * `organization` only when the article has one), so any element carrying the
 * key proves the server still sends it.
 */
function missingKeys(payload: unknown, schema: Schema): string[] {
  const resolved = deref(schema);
  if (resolved.type === "array" && resolved.items) {
    if (!Array.isArray(payload)) return ["<payload is not an array>"];
    const seen = new Set(payload.flatMap((el) => Object.keys(el as Record<string, unknown>)));
    return declaredKeys(resolved.items).filter((k) => !seen.has(k));
  }
  if (payload === null || typeof payload !== "object") return ["<payload is not an object>"];
  const keys = new Set(Object.keys(payload));
  return declaredKeys(resolved).filter((k) => !keys.has(k));
}

/** Spec-declared keys that serializers legitimately omit when no data exists. */
const CONDITIONAL_KEYS: Record<string, string[]> = {
  // emitted only when the article belongs to an org / has a flare tag
  "/api/articles/{id}": ["organization", "flare_tag"],
  "/api/articles/{username}/{slug}": ["organization", "flare_tag"],
  "/api/articles": ["organization", "flare_tag"],
};

const FIXTURES_DIR = process.env.FIXTURES_DIR ?? "tests/fixtures/recorded";
const files = existsSync(FIXTURES_DIR)
  ? readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"))
  : [];

describe("recorded fixtures vs composed spec", () => {
  it("has committed fixtures to verify", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  const vacuous: string[] = [];

  for (const file of files) {
    const rec = JSON.parse(readFileSync(`${FIXTURES_DIR}/${file}`, "utf8")) as Recorded;
    const schema = successSchema(rec.template, rec.method);

    it(`${rec.method} ${rec.template} carries every spec-declared key`, () => {
      if (isVacuous(rec.payload)) {
        vacuous.push(`${rec.method} ${rec.template}`);
        return; // vacuous — reported below, not counted as verified
      }
      if (schema === null) {
        // 204 or schema-less success: nothing to key-check
        expect(rec.payload).toBeNull();
        return;
      }
      const allowed = CONDITIONAL_KEYS[rec.template] ?? [];
      const missing = missingKeys(rec.payload, schema).filter((k) => !allowed.includes(k));
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
    // @ts-expect-error — type_of must be a string, not a number
    const corrupted: components["schemas"]["ArticleIndex"] = { type_of: 42 };
    void corrupted;
    expect(true).toBe(true);
  });

  it("resolves $refs through the composed spec", () => {
    expect(declaredKeys({ $ref: "#/components/schemas/ArticleIndex" })).toContain("title");
    expect(() => declaredKeys({ $ref: "#/components/schemas/Nope" })).toThrow(/unresolvable/);
  });
});
