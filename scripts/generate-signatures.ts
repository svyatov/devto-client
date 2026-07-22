/**
 * Signature generator (KTD1). Emits the ergonomic Call-rule surface as labeled
 * per-resource namespace interfaces with TRUE parameter names, derived from the
 * composed spec (path template → positional names/order/types; query/body →
 * flat params slot) and the op tables (`bodyKey` → wrapper authority). Field
 * types point at `src/ops.ts` helpers indexing `src/generated/types.ts` rather
 * than duplicating shapes; only names and arity are emitted here. The generator
 * is the single authority for names and arity; `tests/generate-signatures.ts`
 * checks every op's positional arity against its path template. Output is
 * deterministic and Biome-formatted downstream.
 *
 * Three files are produced:
 *   src/generated/signatures.ts: the labeled namespace interfaces (types)
 *   src/generated/schemas.ts: friendly entity aliases + per-method param types
 *   src/generated/routing.ts: params routing (query vs body) + the never-404 set
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { pathParamNames } from "../src/path-template.ts";
import { allTables } from "../src/resources/index.ts";
import { compose, type OverlayEntry } from "./compose-spec.ts";
import { type FriendlyName, schemaNames } from "./schema-names.ts";

interface ParamDef {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  schema?: { type?: string; $ref?: string };
}
interface SchemaRef {
  $ref?: string;
  type?: string;
  items?: { $ref?: string };
}
interface Response {
  content?: { "application/json"?: { schema?: SchemaRef } };
}
interface Operation {
  parameters?: ParamDef[];
  requestBody?: unknown;
  responses?: Record<string, Response>;
}
interface PathItem {
  parameters?: ParamDef[];
  [verb: string]: Operation | ParamDef[] | undefined;
}
interface Spec {
  paths: Record<string, PathItem>;
  components?: { parameters?: Record<string, ParamDef>; schemas?: Record<string, unknown> };
}

const HELPERS = [
  "CallBody",
  "CallBodyInner",
  "CallOptions",
  "CallQuery",
  "CallResult",
  "IterQuery",
  "IterResult",
  "Prettify",
] as const;

/** Collected across the whole run: what each generated file must import + emit. */
interface Ctx {
  /** ops.ts helpers used in signatures.ts (CallOptions, CallResult, IterResult). */
  sigHelpers: Set<string>;
  /** friendly entity names used in signature returns (imported from schemas.ts). */
  friendlyUsed: Set<string>;
  /** param alias names used in signature slots (imported from schemas.ts). */
  paramUsed: Set<string>;
  /** `export type …Params = Prettify<…>;` lines, in emission order. */
  paramAliases: string[];
  /** ops.ts helpers used in schemas.ts (Prettify, CallQuery, CallBody, …). */
  schemaHelpers: Set<string>;
}

const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const refName = (ref: string): string => ref.split("/").pop() as string;

/**
 * Singular PascalCase prefix for param-alias names: "articles" → "Article",
 * "admin.users" → "AdminUser". ponytail: naive de-pluralize (drop a trailing
 * "s"); the emitted name is the single authority, so upgrade to real inflection
 * only if a resource ever reads wrong (`analytics` → `Analytic` is acceptable).
 */
function resourcePrefix(key: string): string {
  const p = key.split(".").map(pascal).join("");
  return p.endsWith("s") ? p.slice(0, -1) : p;
}

export function loadSpec(): Spec {
  return compose(
    JSON.parse(readFileSync("spec/api_v1.json", "utf8")),
    JSON.parse(readFileSync("spec/overlay.json", "utf8")) as OverlayEntry[],
  ).spec as Spec;
}

/**
 * What can establish a never-404 observation (KTD1). Its own vocabulary rather
 * than the overlay's `INSTRUMENTS`: those govern spec corrections, and none of
 * them means "a walk against dev.to production". One value is enough today.
 */
export const OBSERVATION_INSTRUMENTS = ["devto-live"] as const;

/**
 * The committed record behind the never-404 set: a file-level provenance block
 * plus one entry per admitted operation, keyed like `opRouting`. Spec silence
 * proposes a candidate; only an entry here admits one (R5).
 */
export interface Never404Observation {
  provenance: {
    instrument: (typeof OBSERVATION_INSTRUMENTS)[number];
    /** When the walk ran. A claim with no date cannot go stale, which is the problem. */
    observedAt: string;
    /** The credential tier the walk ran at: a re-run on another key is not set drift. */
    tier: string;
    /** What the walk did, in enough detail to repeat it. */
    walk: string;
  };
  operations: Record<string, { status: number }>;
}

export const OBSERVATION_FILE = "spec/never-404.json";

/** Reject a malformed observation loudly, in `validateProvenance`'s style: no partial set. */
export function validateObservation(raw: unknown): Never404Observation {
  const fail = (why: string): never => {
    throw new Error(`${OBSERVATION_FILE}: ${why}`);
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("must be an object");
  const { provenance, operations } = raw as Partial<Never404Observation>;
  if (provenance === null || typeof provenance !== "object") fail("provenance is missing");
  const { instrument, observedAt, tier, walk } = provenance as Never404Observation["provenance"];
  if (!OBSERVATION_INSTRUMENTS.includes(instrument)) {
    fail(
      `provenance.instrument must be one of ${OBSERVATION_INSTRUMENTS.join(", ")}, got ${JSON.stringify(instrument)}`,
    );
  }
  for (const [field, value] of Object.entries({ observedAt, tier, walk })) {
    if (typeof value !== "string" || value.trim() === "") {
      fail(`provenance.${field} must be a non-empty string`);
    }
  }
  if (operations === null || typeof operations !== "object" || Array.isArray(operations)) {
    fail("operations is missing");
  }
  for (const [key, record] of Object.entries(operations as Record<string, unknown>)) {
    const { status } = (record ?? {}) as { status?: unknown };
    if (typeof status !== "number") fail(`operation ${key} must record the status the walk saw`);
    // the walk never writes these, so reaching here means the file was edited by
    // hand or by another tool. A 404 refutes the very claim the entry makes, and
    // a 429 or 5xx never reached the routing layer that would have decided.
    if (status === 404) fail(`operation ${key} records a 404, which refutes its own entry`);
    if (status === 429 || (typeof status === "number" && status >= 500)) {
      fail(`operation ${key} records ${status}, which says nothing about whether the path exists`);
    }
  }
  return raw as Never404Observation;
}

export function loadObservation(): Never404Observation {
  return validateObservation(JSON.parse(readFileSync(OBSERVATION_FILE, "utf8")));
}

/**
 * Operations the spec permits a never-404 claim about (KTD2): GET, no path
 * parameters, no declared 404. Structure selects; it never admits, because a
 * spec silence is not evidence that the server cannot 404.
 */
export function never404Candidates(spec: Spec): string[] {
  return Object.entries(spec.paths)
    .filter(([path]) => pathParamNames(path).length === 0)
    .filter(([, item]) => {
      const get = item.get as Operation | undefined;
      return get !== undefined && !("404" in (get.responses ?? {}));
    })
    .map(([path]) => `get ${path}`)
    .sort();
}

/** "admin.requestRedirects" → "AdminRequestRedirectsNamespace" (matches the existing exports). */
export function namespaceName(key: string): string {
  return `${key.split(".").map(pascal).join("")}Namespace`;
}

function resolveParam(spec: Spec, p: ParamDef): ParamDef {
  if (p.$ref) {
    const name = refName(p.$ref);
    const resolved = spec.components?.parameters?.[name];
    if (!resolved) throw new Error(`unknown parameter $ref: ${p.$ref}`);
    return resolved;
  }
  return p;
}

function operationParams(spec: Spec, item: PathItem, verb: string): ParamDef[] {
  const op = item[verb] as Operation | undefined;
  const merged = [...(item.parameters ?? []), ...(op?.parameters ?? [])];
  return merged.map((p) => resolveParam(spec, p));
}

function tsPrimitive(schema: { type?: string } | undefined): string {
  switch (schema?.type) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

/** Resolve a single path param's TS primitive type from the spec, by name. */
function pathParamType(spec: Spec, params: ParamDef[], name: string, template: string): string {
  const def = params.find((p) => p.in === "path" && p.name === name);
  if (!def) throw new Error(`path param "${name}" of ${template} is absent from the composed spec`);
  const schema = def.schema?.$ref
    ? spec.components?.parameters?.[refName(def.schema.$ref)]?.schema
    : def.schema;
  return tsPrimitive(schema);
}

interface OpFacts {
  hasQuery: boolean;
  queryRequired: boolean;
  requiredNonPageQuery: boolean;
  hasBody: boolean;
}

function opFacts(spec: Spec, item: PathItem, verb: string): OpFacts {
  const op = item[verb] as Operation | undefined;
  const params = operationParams(spec, item, verb);
  const query = params.filter((p) => p.in === "query");
  return {
    hasQuery: query.length > 0,
    queryRequired: query.some((p) => p.required),
    requiredNonPageQuery: query.some((p) => p.required && p.name !== "page"),
    hasBody: op?.requestBody !== undefined,
  };
}

type Entry = { path: string; verb: string; paginated?: true; bodyKey?: string };

/** Status codes the runtime `SuccessOf` (ops.ts) reads: 200/201 JSON bodies, 204 → undefined. */
const SUCCESS_CODES = ["200", "201", "204"] as const;

/**
 * Resolve an op's success response to its friendly return type (KTD3). The
 * runtime's `SuccessOf` (ops.ts) unions the JSON bodies of 200 and 201 with
 * `undefined` when 204 (or a content-less 200/201) is present, so a friendly
 * `Promise<Friendly>` may only REPLACE the computed `CallResult<pv>` when it is
 * provably equal to that union: exactly one distinct response schema and no
 * `undefined` arm. Anything else falls back to `CallResult<pv>`, which is by
 * definition `Promise<SuccessOf>` and therefore can never disagree with the
 * runtime (closes the "friendly type present but not assignable" gap).
 *
 * When a single schema resolves, three branches: (1) top-level `$ref` →
 * `Promise<Friendly>`; (2) real `type: "array"` + `items.$ref` →
 * `Promise<Friendly[]>` (`items.$ref` followed ONLY when `type` is `"array"`);
 * (3) everything else (inline, spec-malformed `object + items`, array-inline) →
 * `CallResult<pv>`. No JSON body at all → `Promise<void>`.
 *
 * `friendlyUsed` collects the friendly names this op imports into signatures.ts.
 */
function resolveReturn(
  item: PathItem,
  path: string,
  verb: string,
  friendlyUsed: Set<string>,
): string {
  const pv = `"${path}", "${verb}"`;
  const where = `${verb} ${path}`;
  const op = item[verb] as Operation | undefined;
  const responses = op?.responses ?? {};
  const present = SUCCESS_CODES.filter((c) => c in responses);
  // no success response at all → the runtime resolves to never; keep the computed shape
  if (present.length === 0) return `CallResult<${pv}>`;

  const jsonSchemas = (["200", "201"] as const)
    .map((c) => (c in responses ? responses[c]?.content?.["application/json"]?.schema : undefined))
    .filter((s): s is SchemaRef => s !== undefined);
  // an `undefined` arm enters SuccessOf from a 204 or a content-less 200/201
  const hasUndefinedArm = present.some(
    (c) => responses[c]?.content?.["application/json"]?.schema === undefined,
  );
  // no JSON body on any success code → SuccessOf is undefined → void
  if (jsonSchemas.length === 0) return "Promise<void>";
  // a union (distinct 200/201 schemas, or a schema alongside an undefined arm) can't be
  // one friendly name; fall back to the computed type rather than emit a partial one
  const distinct = new Set(jsonSchemas.map((s) => JSON.stringify(s)));
  if (distinct.size > 1 || hasUndefinedArm) return `CallResult<${pv}>`;

  const schema = jsonSchemas[0] as SchemaRef;
  const map = schemaNames as Record<string, FriendlyName | undefined>;
  const friendlyFor = (schemaName: string): string => {
    const friendly = map[schemaName];
    // KTD2: the completeness gate is scoped to response schemas reached by
    // branch 1/2: a named response with no map entry fails generation.
    if (friendly === undefined) {
      throw new Error(
        `response schema "${schemaName}" for ${where} has no friendly name. ` +
          "Add it to scripts/schema-names.ts (KTD2)",
      );
    }
    friendlyUsed.add(friendly);
    return friendly;
  };

  // branch 1: top-level $ref
  if (schema.$ref) return `Promise<${friendlyFor(refName(schema.$ref))}>`;
  // branch 2: real array of $ref (follow items.$ref ONLY when type is actually "array")
  if (schema.type === "array" && schema.items?.$ref) {
    return `Promise<${friendlyFor(refName(schema.items.$ref))}[]>`;
  }
  // branch 3: inline / malformed object+items / array-inline → keep the computed shape
  return `CallResult<${pv}>`;
}

/** Emit the base call member and, for paginated ops, the `<name>All` iterator twin. */
function emitMembers(
  spec: Spec,
  prefix: string,
  name: string,
  entry: Entry,
  ctx: Ctx,
): { members: string[]; facts: OpFacts } {
  const { path, verb, bodyKey } = entry;
  const item = spec.paths[path];
  if (!item) throw new Error(`op "${name}" references path absent from the composed spec: ${path}`);
  const params = operationParams(spec, item, verb);
  const positional = pathParamNames(path).map(
    (n) => `${n}: ${pathParamType(spec, params, n, path)}`,
  );
  const facts = opFacts(spec, item, verb);
  const pv = `"${path}", "${verb}"`;

  // Register a `Prettify`-wrapped param alias in schemas.ts and return its name
  // for the signature slot (KTD4). `Prettify` flattens the assembled type so it
  // hovers as a flat field list, not `Omit<…> & {…}`.
  const paramAlias = (suffix: string, helper: string, args: string): string => {
    const alias = `${prefix}${pascal(name)}${suffix}Params`;
    ctx.schemaHelpers.add("Prettify");
    ctx.schemaHelpers.add(helper);
    ctx.paramAliases.push(`export type ${alias} = Prettify<${helper}<${args}>>;`);
    ctx.paramUsed.add(alias);
    return alias;
  };

  // base call: [positional..., params?/params (if query or body), opts?]
  const slots = [...positional];
  if (facts.hasBody) {
    const alias = bodyKey
      ? paramAlias("", "CallBodyInner", `${pv}, "${bodyKey}"`)
      : paramAlias("", "CallBody", pv);
    slots.push(`params?: ${alias}`);
  } else if (facts.hasQuery) {
    const alias = paramAlias("", "CallQuery", pv);
    slots.push(`params${facts.queryRequired ? "" : "?"}: ${alias}`);
  }
  ctx.sigHelpers.add("CallOptions");
  slots.push("opts?: CallOptions");
  const ret = resolveReturn(item, path, verb, ctx.friendlyUsed);
  if (ret.startsWith("CallResult")) ctx.sigHelpers.add("CallResult");
  const members = [`${name}: (${slots.join(", ")}) => ${ret};`];

  if (entry.paginated) {
    ctx.sigHelpers.add("IterResult");
    const alias = paramAlias("All", "IterQuery", pv);
    const iterSlots = [
      ...positional,
      `params${facts.requiredNonPageQuery ? "" : "?"}: ${alias}`,
      "opts?: CallOptions",
    ];
    members.push(`${name}All: (${iterSlots.join(", ")}) => IterResult<${pv}>;`);
  }
  return { members, facts };
}

const importBlock = (names: string[], from: string): string =>
  names.length > 0
    ? `import type {\n${names.map((n) => `  ${n},`).join("\n")}\n} from "${from}";\n`
    : "";

/**
 * Friendly entity aliases (KTD1) + per-method `Prettify`-wrapped param aliases
 * (KTD4). Entity aliases stay plain `type X = …` so they hover as a clickable
 * name; only params are `Prettify`-flattened.
 */
function emitSchemas(header: string, ctx: Ctx): string {
  const entityAliases = Object.entries(schemaNames).map(
    ([schema, friendly]) => `export type ${friendly} = components["schemas"]["${schema}"];`,
  );
  const helperImports = [...ctx.schemaHelpers]
    .filter((h) => HELPERS.includes(h as (typeof HELPERS)[number]))
    .sort();
  return (
    `${header}// Friendly, importable aliases over the generated spec schemas (KTD1): entity\n` +
    "// names as plain 1:1 aliases (R4) + per-method Prettify-flattened param types\n" +
    "// (KTD4/R2). Spec drift is a build error (R6).\n\n" +
    `import type { components } from "./types.ts";\n${importBlock(helperImports, "../ops.ts")}\n` +
    `${entityAliases.join("\n")}\n\n${ctx.paramAliases.join("\n")}\n`
  );
}

export function generate(
  spec: Spec,
  observation: unknown,
): { signatures: string; schemas: string; routing: string } {
  const observed = validateObservation(observation);
  const ctx: Ctx = {
    sigHelpers: new Set(),
    friendlyUsed: new Set(),
    paramUsed: new Set(),
    paramAliases: [],
    schemaHelpers: new Set(),
  };
  const interfaces: string[] = [];
  const routing: string[] = [];

  for (const [resourceKey, table] of Object.entries(allTables)) {
    const iface = namespaceName(resourceKey);
    const prefix = resourcePrefix(resourceKey);
    const lines: string[] = [];
    for (const [name, raw] of Object.entries(table)) {
      const entry = raw as Entry;
      const { members, facts } = emitMembers(spec, prefix, name, entry, ctx);
      for (const member of members) lines.push(`  ${member}`);
      if (facts.hasBody) routing.push(`  "${entry.verb} ${entry.path}": "body",`);
      else if (facts.hasQuery) routing.push(`  "${entry.verb} ${entry.path}": "query",`);
    }
    interfaces.push(`export interface ${iface} {\n${lines.join("\n")}\n}`);
  }

  const sigHelperImports = [...ctx.sigHelpers]
    .filter((h) => HELPERS.includes(h as (typeof HELPERS)[number]))
    .sort();
  const schemaImports = [...ctx.friendlyUsed, ...ctx.paramUsed].sort();
  // Shared across the generated files so the drift-detection line can't be
  // dropped from one but not the others.
  const header =
    "// Generated by scripts/generate-signatures.ts. Do not edit by hand.\n" +
    "// Regenerate with `bun run generate`; a dirty diff afterward means drift.\n";
  const signatures = `${header}${importBlock(sigHelperImports, "../ops.ts")}${importBlock(schemaImports, "./schemas.ts")}\n${interfaces.join("\n\n")}\n`;

  // KTD2: spec structure selects candidates, the observation admits them, and a
  // candidate with nothing behind it is named rather than failed. A network walk
  // must never block an unrelated spec update, and a hard failure here would make
  // a red CI run the only way to learn the set has gone stale.
  const never404: string[] = [];
  for (const key of never404Candidates(spec)) {
    if (key in observed.operations) never404.push(key);
    else {
      console.warn(
        `never-404 candidate with no observation behind it: ${key} (run bun scripts/observe-never-404.ts)`,
      );
    }
  }

  const routingBody =
    `${header}// Two op-keyed tables, both keyed "<verb> <path>" (KTD3).\n` +
    "//\n" +
    "// opRouting: which ops send their flat params as query vs body (KTD4). Ops\n" +
    "// absent from this map take no params object. Opts follows the positional\n" +
    "// path args directly.\n" +
    "//\n" +
    "// NEVER_404: ops the spec permits a never-404 claim about (GET, no path\n" +
    `// params, no declared 404) AND ${OBSERVATION_FILE} records a walk behind.\n` +
    "// A cached 404 from one of these contradicts the record, which is what the\n" +
    "// transport reports as `impossible-404`.\n\n" +
    `export const opRouting: Record<string, "query" | "body"> = {\n${routing.sort().join("\n")}\n};\n\n` +
    `export const NEVER_404: ReadonlySet<string> = new Set([\n${never404.map((key) => `  "${key}",`).join("\n")}\n]);\n`;

  return { signatures, schemas: emitSchemas(header, ctx), routing: routingBody };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const spec = loadSpec();
  const { signatures, schemas, routing } = generate(spec, loadObservation());
  writeFileSync("src/generated/signatures.ts", signatures);
  writeFileSync("src/generated/schemas.ts", schemas);
  writeFileSync("src/generated/routing.ts", routing);
  console.log("generated src/generated/{signatures,schemas,routing}.ts");
}
