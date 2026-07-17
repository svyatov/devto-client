/**
 * Shared path→template matcher (KTD1/KTD2). Given a concrete request path and
 * method, returns the single spec path template it was recorded from — the
 * chain-of-custody primitive the recorder, drift script, and reality test all
 * assert against. Pure functions over the composed spec's `paths` keys.
 */
import { readFileSync } from "node:fs";
import { compose, type OverlayEntry } from "./compose-spec.ts";

type SpecPaths = Record<string, Record<string, unknown>>;

let cachedPaths: SpecPaths | undefined;
// Compose in-memory from the two committed source files (like reality.test.ts),
// not the gitignored spec/composed.json — no build step wires that up in CI or a
// fresh clone, and it would be a second, drift-prone way to derive the same spec.
function defaultSpecPaths(): SpecPaths {
  cachedPaths ??= (
    compose(
      JSON.parse(readFileSync("spec/api_v1.json", "utf8")),
      JSON.parse(readFileSync("spec/overlay.json", "utf8")) as OverlayEntry[],
    ).spec as { paths: SpecPaths }
  ).paths;
  return cachedPaths;
}

const isParam = (seg: string): boolean => seg.startsWith("{") && seg.endsWith("}");
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A template matches a path when literals line up and each `{param}` eats one segment. */
const compiledCache = new Map<string, RegExp>();
function compile(template: string): RegExp {
  let re = compiledCache.get(template);
  if (re === undefined) {
    const body = template
      .split("/")
      .map((seg) => (isParam(seg) ? "[^/]+" : escapeRegex(seg)))
      .join("/");
    re = new RegExp(`^${body}$`);
    compiledCache.set(template, re);
  }
  return re;
}

const literalCount = (template: string): number =>
  template.split("/").filter((seg) => !isParam(seg)).length;

/**
 * Fit score for a param-vs-param tie: an id-looking param over a numeric segment
 * scores, and a non-id param over a non-numeric segment scores. Resolves
 * `/api/organizations/{id}` (numeric) vs `/api/organizations/{username}` (name).
 */
function fitScore(template: string, pathSegs: string[]): number {
  const segs = template.split("/");
  let score = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === undefined || !isParam(seg)) continue;
    const numeric = /^\d+$/.test(pathSegs[i] ?? "");
    const idish = /id/i.test(seg);
    if (numeric === idish) score++;
  }
  return score;
}

export function deriveTemplate(path: string, method: string, specPaths?: SpecPaths): string {
  const paths = specPaths ?? defaultSpecPaths();
  const p = path.split("?")[0] ?? path;

  const candidates = Object.keys(paths).filter((t) => compile(t).test(p));
  if (candidates.length === 0) throw new Error(`path matches no spec template: ${p}`);

  // literal beats param
  const maxLiteral = Math.max(...candidates.map(literalCount));
  let pool = candidates.filter((t) => literalCount(t) === maxLiteral);
  const [onlyLiteral, secondLiteral] = pool;
  if (onlyLiteral !== undefined && secondLiteral === undefined) return onlyLiteral;

  // method beats numeric: only one template of a colliding pair may support a non-GET method
  const m = method.toLowerCase();
  const byMethod = pool.filter((t) => paths[t]?.[m] !== undefined);
  const [onlyMethod, secondMethod] = byMethod;
  if (onlyMethod !== undefined && secondMethod === undefined) return onlyMethod;
  if (byMethod.length > 1) pool = byMethod;

  // numeric-segment tie-break
  const pathSegs = p.split("/");
  const scored = pool
    .map((t) => ({ t, score: fitScore(t, pathSegs) }))
    .sort((a, b) => b.score - a.score);
  const [top, next] = scored;
  if (top && (!next || top.score > next.score)) return top.t;
  throw new Error(`path is ambiguous across templates [${pool.join(", ")}]: ${p}`);
}
