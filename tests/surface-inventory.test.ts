import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allTables } from "../src/resources/index.ts";

/**
 * The "% of v1 surface covered = 100" gate: every operation in the composed
 * spec has exactly one table entry, and no table entry points outside the spec.
 *
 * KTD11 exclusions (all absent from the composed spec, so nothing to subtract):
 * - listings: dead upstream stubs, never in the v1 spec
 * - /api/display_ads: transitional alias of billboards, not in the spec
 * - `suspended` role alias: alias of suspend, not in the spec
 * - GET /api/followers/organizations: route exists but the controller action
 *   does not (dead stub, R3) — deliberately neither overlaid nor implemented
 */
describe("surface inventory", () => {
  const spec = JSON.parse(readFileSync("spec/composed.json", "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const verbs = new Set(["get", "post", "put", "patch", "delete"]);

  const specOps = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const verb of Object.keys(item)) {
      if (verbs.has(verb)) specOps.add(`${verb.toUpperCase()} ${path}`);
    }
  }

  const tableOps: string[] = [];
  for (const table of Object.values(allTables)) {
    for (const entry of Object.values(table)) {
      tableOps.push(`${entry.verb.toUpperCase()} ${entry.path}`);
    }
  }

  it("implements every composed-spec operation", () => {
    const missing = [...specOps].filter((op) => !tableOps.includes(op)).sort();
    expect(missing).toEqual([]);
  });

  it("has no table entry outside the composed spec", () => {
    const phantom = tableOps.filter((op) => !specOps.has(op)).sort();
    expect(phantom).toEqual([]);
  });

  it("maps each operation to exactly one table entry", () => {
    const duplicates = tableOps.filter((op, i) => tableOps.indexOf(op) !== i).sort();
    expect(duplicates).toEqual([]);
  });

  it("covers the full 128-operation upstream surface plus the code-only extras", () => {
    expect(specOps.size).toBe(130); // 128 upstream + presign + raw_url (KTD11)
    expect(tableOps).toHaveLength(130);
  });
});
