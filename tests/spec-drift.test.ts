import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShotList, diffSpecs, staleFixtures } from "../scripts/spec-drift.ts";

const DAY = 86_400_000;
const tmp = (): string => mkdtempSync(join(tmpdir(), "drift-"));

const op = (schemaRef: string): Record<string, unknown> => ({
  responses: { "200": { content: { "application/json": { schema: { $ref: schemaRef } } } } },
});
const spec = (paths: Record<string, unknown>): { paths: Record<string, unknown> } => ({ paths });

const writeFixture = (dir: string, name: string, rec: object): void =>
  writeFileSync(join(dir, name), JSON.stringify(rec));

describe("diffSpecs", () => {
  it("reports added and removed templates", () => {
    const d = diffSpecs(
      spec({ "/api/a": { get: op("#/A") }, "/api/new": { get: op("#/N") } }),
      spec({ "/api/a": { get: op("#/A") }, "/api/gone": { get: op("#/G") } }),
    );
    expect(d.added).toEqual(["/api/new"]);
    expect(d.removed).toEqual(["/api/gone"]);
    expect(d.changed).toEqual([]);
  });

  it("reports a template whose operation schema changed", () => {
    const d = diffSpecs(
      spec({ "/api/a": { get: op("#/A_v2") } }),
      spec({ "/api/a": { get: op("#/A_v1") } }),
    );
    expect(d.changed).toEqual(["/api/a"]);
  });

  it("is quiet when specs are identical", () => {
    const s = spec({ "/api/a": { get: op("#/A") } });
    expect(diffSpecs(s, s)).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe("staleFixtures", () => {
  const now = Date.parse("2026-07-17T00:00:00Z");
  const at = (daysAgo: number): string => new Date(now - daysAgo * DAY).toISOString();

  it("flags fixtures past the threshold and ignores fresh ones (89 quiet, 91 flagged)", () => {
    const dir = tmp();
    writeFixture(dir, "fresh.json", { template: "/api/a", method: "GET", recordedAt: at(89) });
    writeFixture(dir, "stale.json", { template: "/api/b", method: "GET", recordedAt: at(91) });
    const stale = staleFixtures(dir, now, 90);
    expect(stale.map((s) => s.template)).toEqual(["/api/b"]);
  });

  it("returns nothing for an empty directory", () => {
    expect(staleFixtures(tmp(), now, 90)).toEqual([]);
  });
});

describe("buildShotList", () => {
  const empty = { added: [], removed: [], changed: [] };
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it("AE2: one stale fixture yields exactly that fixture's command", () => {
    const out = buildShotList(
      empty,
      [{ template: "/api/tags", method: "GET" }],
      [{ template: "/api/tags", method: "GET", ageDays: 100 }],
    );
    expect(out).toContain("bun run record -- --only /api/tags");
    expect(count(out, "bun run record")).toBe(1);
  });

  it("lists an added template with no command, and a removed template's fixture with one", () => {
    const out = buildShotList(
      { added: ["/api/new"], removed: ["/api/gone"], changed: [] },
      [{ template: "/api/gone", method: "GET" }],
      [],
    );
    expect(out).toContain("/api/new");
    expect(out).not.toContain("--only /api/new");
    expect(out).toContain("bun run record -- --only /api/gone");
  });

  it("lists a changed operation's fixture command", () => {
    const out = buildShotList(
      { added: [], removed: [], changed: ["/api/tags"] },
      [{ template: "/api/tags", method: "GET" }],
      [],
    );
    expect(out).toContain("bun run record -- --only /api/tags");
  });

  it("renders the write-cycle group command once for multiple stale write fixtures", () => {
    const out = buildShotList(
      empty,
      [],
      [
        { template: "/api/articles", method: "POST", ageDays: 100 },
        { template: "/api/articles/{id}", method: "PUT", ageDays: 100 },
      ],
    );
    expect(count(out, "bun run record -- --only write-cycle")).toBe(1);
    expect(out).not.toContain("--only /api/articles\n");
  });

  it("returns empty output when there are no findings", () => {
    expect(buildShotList(empty, [{ template: "/api/tags", method: "GET" }], [])).toBe("");
  });
});
