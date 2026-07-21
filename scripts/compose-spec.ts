/**
 * Composes spec/api_v1.json (pinned upstream snapshot) with spec/overlay.json
 * into spec/composed.json: the input for type generation.
 *
 * Overlay entry semantics:
 *   target      JSON pointer to the node to set or remove
 *   expect      subset-asserted against the current node; null asserts absence
 *   reason      why the entry exists (required, non-empty)
 *   patch       value to set at target; null removes the node
 *   provenance  how the claim was established (every entry carries one; see below)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * What produced a claim. The `reason` prefix says what kind of defect an entry
 * corrects; this says what saw it. Collapsing the two is what let one prefix
 * cover both a dev.to fixture match and a single local observation.
 */
export const INSTRUMENTS = [
  /** A recorded dev.to response under tests/fixtures/recorded/. */
  "devto-fixture",
  /** A response from the pinned local Forem, which nothing else can corroborate. */
  "local-forem",
  /** Forem's own source at the pin: a controller, serializer or policy. */
  "forem-source",
  /** The upstream spec read on its own terms, with no server involved. */
  "spec-structure",
] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export interface Provenance {
  instrument: Instrument;
  /** The Forem commit the claim was observed against, where one applies. */
  forem?: string;
  /** Whether a second server sent the same shape. Never true for a structural read. */
  corroborated: boolean;
}

export interface OverlayEntry {
  target: string;
  expect: unknown;
  reason: string;
  patch: unknown;
  /**
   * Optional on purpose (KTD4): composition aborts the whole spec pipeline on any
   * validation failure, so making this required would turn one typo into a red
   * type-generation run and a repo-wide test failure.
   */
  provenance?: Provenance;
}

/** Reject a malformed provenance field loudly, naming the entry that carries it. */
export function validateProvenance(entry: OverlayEntry): void {
  const p: unknown = entry.provenance;
  if (p === undefined) return;
  const fail = (why: string): never => {
    throw new Error(`overlay entry ${entry.target}: provenance ${why}`);
  };
  if (p === null || typeof p !== "object" || Array.isArray(p)) fail("must be an object");
  const { instrument, forem, corroborated } = p as Partial<Provenance>;
  if (typeof instrument !== "string" || !INSTRUMENTS.includes(instrument as Instrument)) {
    fail(`instrument must be one of ${INSTRUMENTS.join(", ")}, got ${JSON.stringify(instrument)}`);
  }
  if (typeof corroborated !== "boolean") fail("corroborated must be a boolean");
  if (forem !== undefined && typeof forem !== "string") fail("forem must be a string when present");
  // R12: a local observation is only interpretable against the commit that
  // produced it, and Forem moves. A local claim with no pin is unfalsifiable.
  if (instrument === "local-forem" && forem === undefined) {
    fail("must name the Forem commit when the instrument is local-forem");
  }
  // reading the spec on its own terms involves no server, so there is no second
  // one to agree - the field's own doc comment says so, and now the check does too
  if (instrument === "spec-structure" && corroborated) {
    fail("cannot be corroborated when the instrument is spec-structure");
  }
}

type Node = Record<string, unknown> | unknown[];

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every key/element of `expected` must match in `actual`; extra keys in `actual` are fine. */
function subsetMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object") return deepEqual(expected, actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((item, i) => subsetMatch(item, actual[i]));
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([k, v]) =>
    subsetMatch(v, (actual as Record<string, unknown>)[k]),
  );
}

/** JSON-pointer segments, unescaped (`~1` is `/`, `~0` is `~`). */
export function parsePointer(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((seg) => seg.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function getChild(node: Node, key: string): unknown {
  return Array.isArray(node) ? node[Number(key)] : node[key];
}

export function compose(
  snapshot: unknown,
  overlay: OverlayEntry[],
): { spec: unknown; deletable: string[] } {
  const spec = structuredClone(snapshot) as Node;
  const deletable: string[] = [];

  for (const entry of overlay) {
    if (!entry.reason || entry.reason.trim() === "") {
      throw new Error(`overlay entry ${entry.target}: reason must be non-empty`);
    }
    validateProvenance(entry);
    const segments = parsePointer(entry.target);
    const key = segments.at(-1);
    if (key === undefined) throw new Error(`overlay entry ${entry.target}: empty pointer`);

    let parent: unknown = spec;
    for (const seg of segments.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") parent = undefined;
      else parent = getChild(parent as Node, seg);
      if (parent === undefined) {
        throw new Error(`overlay entry ${entry.target}: dangling target (missing "${seg}")`);
      }
    }
    const parentNode = parent as Node;
    const current = getChild(parentNode, key);

    if (entry.expect === null) {
      if (current !== undefined) {
        throw new Error(`overlay entry ${entry.target}: node already exists but expect is null`);
      }
    } else if (current === undefined) {
      throw new Error(`overlay entry ${entry.target}: dangling target (missing "${key}")`);
    } else if (!subsetMatch(entry.expect, current)) {
      throw new Error(`overlay entry ${entry.target}: expect mismatch`);
    }

    if (entry.patch === null) {
      if (Array.isArray(parentNode)) parentNode.splice(Number(key), 1);
      else delete parentNode[key];
    } else {
      if (deepEqual(current, entry.patch)) deletable.push(entry.target);
      if (Array.isArray(parentNode)) parentNode[Number(key)] = entry.patch;
      else parentNode[key] = entry.patch;
    }
  }

  return { spec, deletable };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const snapshot = JSON.parse(readFileSync("spec/api_v1.json", "utf8"));
  const overlay = JSON.parse(readFileSync("spec/overlay.json", "utf8")) as OverlayEntry[];
  const { spec, deletable } = compose(snapshot, overlay);
  for (const target of deletable) {
    console.warn(`overlay entry is a no-op and can be deleted: ${target}`);
  }
  writeFileSync("spec/composed.json", `${JSON.stringify(spec, null, 2)}\n`);
  console.log(`composed spec written (${overlay.length} overlay entries applied)`);
}
