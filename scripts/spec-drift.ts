/**
 * Offline drift-to-shot-list (KTD5/KTD6). Turns two signals — a structural diff
 * of the upstream spec against the pinned snapshot, and recorded-fixture age —
 * into a ready-to-paste list of targeted `npm run record` commands. Prints the
 * shot list to stdout (empty when nothing is stale or drifted); the workflow
 * captures it for the issue body.
 *
 * Run: node --experimental-strip-types scripts/spec-drift.ts [upstream.json] [pinned.json]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deepEqual } from "./compose-spec.ts";

interface Spec {
  paths: Record<string, unknown>;
}
export interface SpecDiff {
  added: string[];
  removed: string[];
  changed: string[];
}
export interface FixtureMeta {
  template: string;
  method: string;
}
export interface StaleFixture extends FixtureMeta {
  ageDays: number;
}

/** Added/removed path templates and templates whose operation set changed (KTD5). */
export function diffSpecs(upstream: Spec, pinned: Spec): SpecDiff {
  const up = upstream.paths;
  const pin = pinned.paths;
  const added = Object.keys(up).filter((k) => !(k in pin));
  const removed = Object.keys(pin).filter((k) => !(k in up));
  const changed = Object.keys(up)
    .filter((k) => k in pin)
    .filter((k) => {
      const upOps = (up[k] ?? {}) as Record<string, unknown>;
      const pinOps = (pin[k] ?? {}) as Record<string, unknown>;
      const methods = new Set([...Object.keys(upOps), ...Object.keys(pinOps)]);
      return [...methods].some((m) => !deepEqual(upOps[m], pinOps[m]));
    });
  return { added, removed, changed };
}

/** Recorded fixtures whose `recordedAt` is older than `maxAgeDays` (KTD6). */
export function staleFixtures(dir: string, nowMs: number, maxAgeDays: number): StaleFixture[] {
  const stale: StaleFixture[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const rec = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
      template: string;
      method: string;
      recordedAt: string;
    };
    const ageDays = (nowMs - Date.parse(rec.recordedAt)) / 86_400_000;
    if (ageDays > maxAgeDays) stale.push({ template: rec.template, method: rec.method, ageDays });
  }
  return stale;
}

/** GET reads target their own template; every write goes through the atomic write-cycle group. */
const commandFor = (f: FixtureMeta): string =>
  f.method === "GET"
    ? `npm run record -- --only ${f.template}`
    : "npm run record -- --only write-cycle";

/** Render drift + staleness findings as markdown with one re-record command per finding. */
export function buildShotList(
  diff: SpecDiff,
  fixtures: FixtureMeta[],
  stale: StaleFixture[],
): string {
  const lines: string[] = [];
  const commands = new Set<string>();
  const fixturesFor = (t: string): FixtureMeta[] => fixtures.filter((f) => f.template === t);

  for (const t of diff.added) {
    lines.push(`- New upstream template \`${t}\` — nothing recorded yet.`);
  }
  for (const t of diff.removed) {
    const fx = fixturesFor(t);
    lines.push(
      `- Upstream removed \`${t}\`${fx.length ? " — recorded fixture now orphaned" : ""}.`,
    );
    for (const f of fx) commands.add(commandFor(f));
  }
  for (const t of diff.changed) {
    const fx = fixturesFor(t);
    lines.push(`- Operation changed on \`${t}\`${fx.length ? " — re-record it" : ""}.`);
    for (const f of fx) commands.add(commandFor(f));
  }
  for (const s of stale) {
    lines.push(`- Fixture \`${s.method} ${s.template}\` is ${Math.floor(s.ageDays)} days old.`);
    commands.add(commandFor(s));
  }

  if (lines.length === 0) return "";

  const cmds = [...commands];
  return [
    "## Fixture shot list",
    "",
    ...lines,
    ...(cmds.length > 0 ? ["", "### Re-record commands", "", "```sh", ...cmds, "```"] : []),
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const upstreamPath = process.argv[2] ?? "spec/api_v1.json";
  const pinnedPath = process.argv[3] ?? "spec/api_v1.json";
  const fixturesDir = process.argv[4] ?? "tests/fixtures/recorded";
  const maxAgeDays = process.env.FIXTURE_MAX_AGE_DAYS
    ? Number(process.env.FIXTURE_MAX_AGE_DAYS)
    : 90;

  const upstream = JSON.parse(readFileSync(upstreamPath, "utf8")) as Spec;
  const pinned = JSON.parse(readFileSync(pinnedPath, "utf8")) as Spec;
  const diff = diffSpecs(upstream, pinned);

  const fixtures: FixtureMeta[] = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const rec = JSON.parse(readFileSync(join(fixturesDir, f), "utf8")) as FixtureMeta;
      return { template: rec.template, method: rec.method };
    });
  const stale = staleFixtures(fixturesDir, Date.now(), maxAgeDays);

  const shotList = buildShotList(diff, fixtures, stale);
  if (shotList) console.log(shotList);
}
