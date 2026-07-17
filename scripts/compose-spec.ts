/**
 * Composes spec/api_v1.json (pinned upstream snapshot) with spec/overlay.json
 * into spec/composed.json — the input for type generation.
 *
 * Overlay entry semantics:
 *   target  JSON pointer to the node to set or remove
 *   expect  subset-asserted against the current node; null asserts absence
 *   reason  why the entry exists (required, non-empty)
 *   patch   value to set at target; null removes the node
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface OverlayEntry {
  target: string;
  expect: unknown;
  reason: string;
  patch: unknown;
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

function parsePointer(pointer: string): string[] {
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
