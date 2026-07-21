/**
 * Shared spec-versus-payload key comparison (KTD2). Extracted from
 * tests/reality.test.ts so the local-Forem sweep and the reality check use one
 * implementation, and gaining the direction reality never needed: `extraKeys`,
 * carried-minus-declared. The reality check only asks whether dev.to still sends
 * what the spec declares; the sweep exists to catch a server sending a key the
 * spec never declared, which `missingKeys` is structurally blind to.
 */
import { readFileSync } from "node:fs";
import { compose, type OverlayEntry } from "./compose-spec.ts";

export type Schema = {
  $ref?: string;
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
};

type ComposedSpec = {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema> };
};

let cached: ComposedSpec | undefined;
// Compose in-memory from the two committed source files, never the gitignored
// spec/composed.json: no build step wires that up in CI or a fresh clone.
export function composedSpec(): ComposedSpec {
  cached ??= compose(
    JSON.parse(readFileSync("spec/api_v1.json", "utf8")),
    JSON.parse(readFileSync("spec/overlay.json", "utf8")) as OverlayEntry[],
  ).spec as ComposedSpec;
  return cached;
}

function deref(schema: Schema): Schema {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1) ?? "";
    const target = composedSpec().components.schemas[name];
    if (!target) throw new Error(`unresolvable $ref: ${schema.$ref}`);
    return deref(target);
  }
  return schema;
}

/** Property names the composed spec declares for a schema (allOf merged). */
export function declaredKeys(schema: Schema): string[] {
  const resolved = deref(schema);
  if (resolved.allOf) return resolved.allOf.flatMap((s) => declaredKeys(s));
  return Object.keys(resolved.properties ?? {});
}

/**
 * Success schema for an operation, distinguishing three cases a bare `null`
 * conflates: the template vanished upstream (`removed`), the op exists but
 * declares no JSON body (`none`, a legitimate 204), or a real schema.
 */
export type SchemaLookup =
  | { kind: "schema"; schema: Schema }
  | { kind: "none" }
  | { kind: "removed" };

export function successSchema(template: string, method: string): SchemaLookup {
  const spec = composedSpec();
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

export function isVacuous(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.length === 0;
  if (payload !== null && typeof payload === "object") {
    return Object.keys(payload).length === 0;
  }
  return payload === null || payload === undefined;
}

/** Keys any element of the payload actually carries; a bare object counts as one element. */
export function carriedKeys(payload: unknown): Set<string> {
  const elements = Array.isArray(payload) ? payload : [payload];
  return new Set(
    elements.flatMap((el) => (el !== null && typeof el === "object" ? Object.keys(el) : [])),
  );
}

/**
 * `missingKeys` and `extraKeys` return this in place of key names when the
 * payload's shape is not comparable to the schema at all. Callers ask through
 * this predicate rather than matching the prefix themselves: the sentinel is a
 * string sitting in a list of property names, so nothing else marks it as one.
 */
export const isShapeMismatch = (key: string): boolean => key.startsWith("<payload is not");

/**
 * Keys the spec declares that the payload never carries. For arrays the keys
 * are unioned across elements: serializers omit conditional fields (e.g.
 * `organization` only when the article has one), so any element carrying the
 * key proves the server still sends it.
 */
export function missingKeys(payload: unknown, schema: Schema): string[] {
  const target = comparable(payload, schema);
  if (typeof target === "string") return [target];
  const seen = carriedKeys(payload);
  return declaredKeys(target).filter((k) => !seen.has(k));
}

/**
 * The shape check both directions share: the schema to compare keys against (an
 * array's item schema, or the object itself), or the sentinel when the payload
 * is not comparable to the schema at all.
 *
 * `Array.isArray` in the object branch is load-bearing. `typeof [] === "object"`,
 * so without it an array served where the spec declares an object unions its
 * elements' keys and comes back clean in both directions, reporting `matched`
 * for a payload that is wrong at the top level.
 */
function comparable(payload: unknown, schema: Schema): Schema | string {
  const resolved = deref(schema);
  if (resolved.type === "array" && resolved.items) {
    return Array.isArray(payload) ? resolved.items : "<payload is not an array>";
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return "<payload is not an object>";
  }
  return resolved;
}

/**
 * The other direction: keys the payload carries that the spec never declared.
 * Unioned across array elements too, so a key only one element carries is still
 * reported - an undeclared key is drift no matter how rarely it appears.
 */
export function extraKeys(payload: unknown, schema: Schema): string[] {
  const target = comparable(payload, schema);
  if (typeof target === "string") return [target];
  const declared = new Set(declaredKeys(target));
  return [...carriedKeys(payload)].filter((k) => !declared.has(k));
}

/**
 * Keys the article serializer emits only when the data exists: org membership, a flare tag.
 * Not checked per endpoint: whether a given page of articles happens to contain one is a coin
 * flip, and that flakiness has filed a false drift alarm twice.
 */
export const CONDITIONAL_KEYS = ["organization", "flare_tag"];
