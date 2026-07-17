/**
 * Signature generator (KTD1). Emits the ergonomic Call-rule surface as labeled
 * per-resource namespace interfaces with TRUE parameter names, derived from the
 * composed spec (path template → positional names/order/types; query/body →
 * flat params slot) and the op tables (`bodyKey` → wrapper authority). Field
 * types point at `src/ops.ts` helpers indexing `src/generated/types.ts` rather
 * than duplicating shapes; only names and arity are emitted here. The generic
 * `CallSig`/`IterCallSig` in `ops.ts` is the spec-derived reference these are
 * pinned against (KTD2). Output is deterministic and Biome-formatted downstream.
 *
 * Two files are produced:
 *   src/generated/signatures.ts — the labeled namespace interfaces (types)
 *   src/generated/routing.ts    — runtime params routing (query vs body) manifest
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { pathParamNames } from "../src/path-template.ts";
import { allTables } from "../src/resources/index.ts";
import { compose, type OverlayEntry } from "./compose-spec.ts";

interface ParamDef {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  schema?: { type?: string; $ref?: string };
}
interface Operation {
  parameters?: ParamDef[];
  requestBody?: unknown;
}
interface PathItem {
  parameters?: ParamDef[];
  [verb: string]: Operation | ParamDef[] | undefined;
}
interface Spec {
  paths: Record<string, PathItem>;
  components?: { parameters?: Record<string, ParamDef> };
}

const HELPERS = [
  "CallBody",
  "CallBodyInner",
  "CallOptions",
  "CallQuery",
  "CallResult",
  "IterQuery",
  "IterResult",
] as const;

export function loadSpec(): Spec {
  return compose(
    JSON.parse(readFileSync("spec/api_v1.json", "utf8")),
    JSON.parse(readFileSync("spec/overlay.json", "utf8")) as OverlayEntry[],
  ).spec as Spec;
}

/** "admin.requestRedirects" → "AdminRequestRedirectsNamespace" (matches the existing exports). */
function namespaceName(key: string): string {
  const pascal = key
    .split(".")
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");
  return `${pascal}Namespace`;
}

function resolveParam(spec: Spec, p: ParamDef): ParamDef {
  if (p.$ref) {
    const name = p.$ref.split("/").pop() as string;
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
    ? spec.components?.parameters?.[def.schema.$ref.split("/").pop() as string]?.schema
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

/** Emit the base call member and, for paginated ops, the `<name>All` iterator twin. */
function emitMembers(
  spec: Spec,
  name: string,
  entry: Entry,
  used: Set<string>,
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

  // base call: [positional..., params?/params (if query or body), opts?]
  const slots = [...positional];
  if (facts.hasBody) {
    if (bodyKey) {
      used.add("CallBodyInner");
      slots.push(`params?: CallBodyInner<${pv}, "${bodyKey}">`);
    } else {
      used.add("CallBody");
      slots.push(`params?: CallBody<${pv}>`);
    }
  } else if (facts.hasQuery) {
    used.add("CallQuery");
    slots.push(`params${facts.queryRequired ? "" : "?"}: CallQuery<${pv}>`);
  }
  used.add("CallOptions");
  used.add("CallResult");
  slots.push("opts?: CallOptions");
  const members = [`${name}: (${slots.join(", ")}) => CallResult<${pv}>;`];

  if (entry.paginated) {
    used.add("IterQuery");
    used.add("IterResult");
    const iterSlots = [
      ...positional,
      `params${facts.requiredNonPageQuery ? "" : "?"}: IterQuery<${pv}>`,
      "opts?: CallOptions",
    ];
    members.push(`${name}All: (${iterSlots.join(", ")}) => IterResult<${pv}>;`);
  }
  return { members, facts };
}

export function generate(spec: Spec): { signatures: string; routing: string } {
  const used = new Set<string>();
  const interfaces: string[] = [];
  const routing: string[] = [];

  for (const [resourceKey, table] of Object.entries(allTables)) {
    const iface = namespaceName(resourceKey);
    const lines: string[] = [];
    for (const [name, raw] of Object.entries(table)) {
      const entry = raw as Entry;
      const { members, facts } = emitMembers(spec, name, entry, used);
      for (const member of members) lines.push(`  ${member}`);
      if (facts.hasBody) routing.push(`  "${entry.verb} ${entry.path}": "body",`);
      else if (facts.hasQuery) routing.push(`  "${entry.verb} ${entry.path}": "query",`);
    }
    interfaces.push(`export interface ${iface} {\n${lines.join("\n")}\n}`);
  }

  const imports = [...used].filter((h) => HELPERS.includes(h as (typeof HELPERS)[number])).sort();
  // Shared across both generated files so the drift-detection line can't be
  // dropped from one but not the other.
  const header =
    "// Generated by scripts/generate-signatures.ts. Do not edit by hand.\n" +
    "// Regenerate with `npm run generate`; a dirty diff afterward means drift.\n";
  const signatures = `${header}import type {\n${imports.map((h) => `  ${h},`).join("\n")}\n} from "../ops.ts";\n\n${interfaces.join("\n\n")}\n`;

  const routingBody =
    `${header}// Runtime params routing: which ops send their flat params as query vs body\n` +
    "// (KTD4). Ops absent from this map take no params object — opts follows the\n" +
    "// positional path args directly.\n\n" +
    `export const opRouting: Record<string, "query" | "body"> = {\n${routing.sort().join("\n")}\n};\n`;

  return { signatures, routing: routingBody };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const spec = loadSpec();
  const { signatures, routing } = generate(spec);
  writeFileSync("src/generated/signatures.ts", signatures);
  writeFileSync("src/generated/routing.ts", routing);
  console.log("generated src/generated/signatures.ts and src/generated/routing.ts");
}
