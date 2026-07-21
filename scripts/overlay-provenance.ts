/**
 * Derives, mechanically, whether an Overlay entry's claim is corroborated by a
 * recorded dev.to fixture (R13). Fixture existence is a necessary condition, not
 * a sufficient one: an entry is corroborated only when the composed schema and
 * the recorded payload actually agree in both directions. Asserting only the
 * necessary half is how an inflated claim would survive review.
 *
 * Lives beside the composer rather than inside the test so both the backfill and
 * the assertion that guards it read from one implementation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type OverlayEntry, parsePointer } from "./compose-spec.ts";
import { fixtureFileName, RECORDED_DIR } from "./record-fixtures.ts";
import {
  CONDITIONAL_KEYS,
  composedSpec,
  extraKeys,
  missingKeys,
  type Schema,
  successSchema,
} from "./spec-keys.ts";
import { specOperations } from "./sweep-targets.ts";

type Op = { template: string; method: string };

/**
 * The operations an entry governs, meaning the ones whose *response* a recorded
 * fixture could disagree with. A `/paths/.../responses/...` pointer names exactly
 * one; a `/components/schemas/X/...` pointer names every operation whose success
 * schema resolves to `X`.
 *
 * A `/paths/` pointer that stops short of `responses` - a request parameter, say -
 * governs nothing here on purpose. Returning its operation would let a response
 * comparison answer a question about the request and hand the entry a
 * corroboration it never earned.
 */
export function governedOps(target: string): Op[] {
  const segments = parsePointer(target);
  if (
    segments[0] === "paths" &&
    segments[1] !== undefined &&
    segments[2] !== undefined &&
    segments.includes("responses")
  ) {
    return [{ template: segments[1], method: segments[2].toUpperCase() }];
  }
  if (segments[0] === "components" && segments[1] === "schemas" && segments[2] !== undefined) {
    const name = segments[2];
    return specOperations().filter((op) => referencesSchema(op, name));
  }
  return [];
}

const refName = (schema: Schema | undefined): string | undefined => schema?.$ref?.split("/").at(-1);

/** Whether the operation's success body is this component, or an array of it. */
function referencesSchema(op: Op, name: string): boolean {
  const lookup = successSchema(op.template, op.method);
  if (lookup.kind !== "schema") return false;
  const { schema } = lookup;
  return refName(schema) === name || (schema.type === "array" && refName(schema.items) === name);
}

/** The recorded dev.to payload for an operation, when one was captured. */
export function recordedPayload(op: Op): unknown | undefined {
  const file = join(RECORDED_DIR, fixtureFileName(op));
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf8")) as { payload: unknown }).payload;
}

/**
 * Corroborated only when at least one governed operation has a recorded fixture
 * and *every* fixture that exists agrees with the composed schema in both
 * directions. Anything the comparison cannot decide comes back false.
 */
export function isCorroborated(entry: OverlayEntry): boolean {
  const ops = governedOps(entry.target);
  let compared = 0;
  for (const op of ops) {
    const payload = recordedPayload(op);
    if (payload === undefined) continue;
    const lookup = successSchema(op.template, op.method);
    if (lookup.kind !== "schema") return false;
    compared += 1;
    const extra = extraKeys(payload, lookup.schema);
    const missing = missingKeys(payload, lookup.schema).filter(
      (k) => !CONDITIONAL_KEYS.includes(k),
    );
    if (extra.length > 0 || missing.length > 0) return false;
  }
  return compared > 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // keep the composed spec warm before reading the overlay off disk
  composedSpec();
  const overlay = JSON.parse(readFileSync("spec/overlay.json", "utf8")) as OverlayEntry[];
  // every entry, not just the ones whose reason opens with a set phrase: which
  // claims have fixtures behind them is the question, and prose does not answer it
  for (const [i, entry] of overlay.entries()) {
    const ops = governedOps(entry.target);
    const withFixture = ops.filter((op) => recordedPayload(op) !== undefined);
    console.log(
      `${i}\t${isCorroborated(entry) ? "CORROBORATED" : "-"}\t${withFixture.length}/${ops.length} fixtures\t${entry.target}`,
    );
  }
}
