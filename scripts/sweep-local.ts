/**
 * Sweeps the Composed spec's operations against a local Forem and reports, per
 * operation, whether the spec matches what the server actually renders (R4-R6).
 *
 * This is an oracle, not a fixture source. Nothing it writes may be committed
 * under tests/fixtures/recorded/ (R7): captures carry a `source` stamp naming
 * the Forem commit, and the reality check fails on any fixture bearing one.
 *
 * A separate script from the recorder on purpose (KTD1): the recorder defaults
 * its out-dir to the recorded-fixtures directory, and it swallows 401/403/404
 * while rethrowing everything else - the opposite of what R5 needs.
 *
 * Run: FOREM_BASE_URL=http://localhost:3000 FOREM_API_KEY=... bun run sweep
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DevToApiError } from "../src/errors.ts";
import { type ClientOptions, type ResolvedConfig, request, resolveConfig } from "../src/http.ts";
import {
  isLoopback,
  type Recorded,
  resolveTarget,
  scrub,
  writeFixture,
} from "./record-fixtures.ts";
import {
  extraKeys,
  isShapeMismatch,
  isVacuous,
  missingKeys,
  type Schema,
  successSchema,
} from "./spec-keys.ts";
import { deriveTemplate } from "./spec-templates.ts";
import { buildTargets, type Discovered, type SweepTarget } from "./sweep-targets.ts";

export const CAPTURE_DIR = "docs/sweep-captures";

/** A capture is a recorder envelope plus the stamp that keeps it out of the Recorded tier. */
export interface Capture extends Recorded {
  source: string;
}

export type Finding =
  | { kind: "matched"; template: string; method: string }
  | {
      kind: "disagreed";
      template: string;
      method: string;
      extra: string[];
      note?: string;
    }
  | {
      kind: "inconclusive";
      template: string;
      method: string;
      missing: string[];
      elements: number;
      hits: Record<string, number>;
    }
  | { kind: "vacuous"; template: string; method: string }
  | {
      kind: "unexercised";
      template: string;
      method: string;
      cause: "blocked" | "deferred";
      reason: string;
    };

/**
 * KTD6's refusals, both before any config is constructed. `resolveTarget` alone
 * is not enough: it only decides `allowInsecureHttp`, and with FOREM_BASE_URL
 * unset it hands back https://dev.to paired with DEVTO_API_KEY. Combined with
 * the dropped pacer that would crawl the author's real account unpaced.
 */
export function assertSweepSafe(env: NodeJS.ProcessEnv, outDir: string): void {
  const baseUrl = env.FOREM_BASE_URL;
  if (baseUrl === undefined) {
    throw new Error(
      "FOREM_BASE_URL is required: unset, the recorder's target resolution would point this unpaced sweep at https://dev.to with DEVTO_API_KEY",
    );
  }
  if (!isLoopback(baseUrl)) {
    throw new Error(`refusing to sweep a non-loopback host: ${baseUrl}`);
  }
  // resolve first: a prefix test on the raw string accepts
  // `docs/sweep-captures/../../tests/fixtures/recorded`, which is the exact
  // contamination R7 forbids
  const rel = relative(resolve(CAPTURE_DIR), resolve(outDir));
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing to write captures outside ${CAPTURE_DIR}/: ${outDir}`);
  }
}

/** Transport for loopback: no pacing (KTD3), but retries stay - a local 429 is possible. */
export function buildSweepConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const target = resolveTarget(env);
  const options: ClientOptions = {
    baseUrl: target.baseUrl,
    retry: { attempts: 3 },
    timeoutMs: 30_000,
    // dev.to's budgets do not apply to loopback, and resolveConfig builds a pacer
    // unless told otherwise
    pace: false,
  };
  if (target.apiKey !== undefined) options.apiKey = target.apiKey;
  if (target.allowInsecureHttp) options.allowInsecureHttp = true;
  return resolveConfig(options);
}

/** How many elements carried each declared key: thin seed data reads differently from real drift. */
function keyHits(
  payload: unknown,
  keys: string[],
): { elements: number; hits: Record<string, number> } {
  const elements = Array.isArray(payload) ? payload : [payload];
  const hits: Record<string, number> = {};
  for (const k of keys) {
    hits[k] = elements.filter(
      (el) => el !== null && typeof el === "object" && k in (el as object),
    ).length;
  }
  return { elements: elements.length, hits };
}

/** Compare one payload against the operation's declared success schema. */
export function classifyPayload(template: string, method: string, payload: unknown): Finding {
  const lookup = successSchema(template, method);
  if (lookup.kind === "removed") {
    return {
      kind: "unexercised",
      template,
      method,
      cause: "blocked",
      reason: "template no longer exists in the composed spec",
    };
  }
  if (isVacuous(payload)) return { kind: "vacuous", template, method };
  if (lookup.kind === "none") {
    // op declares no JSON body, yet something came back
    return {
      kind: "disagreed",
      template,
      method,
      extra: [],
      note: "spec declares no success body",
    };
  }
  const schema: Schema = lookup.schema;
  const extra = extraKeys(payload, schema);
  if (extra[0] !== undefined) {
    if (isShapeMismatch(extra[0])) {
      // `extra: []`, matching the missing side below: the sentinel is not a key
      // name, and the report would otherwise list it as an undeclared key
      return { kind: "disagreed", template, method, extra: [], note: extra[0] };
    }
    return { kind: "disagreed", template, method, extra };
  }
  const missing = missingKeys(payload, schema);
  if (missing[0] !== undefined) {
    if (isShapeMismatch(missing[0])) {
      return { kind: "disagreed", template, method, extra: [], note: missing[0] };
    }
    return { kind: "inconclusive", template, method, missing, ...keyHits(payload, missing) };
  }
  return { kind: "matched", template, method };
}

type Rf = (
  method: string,
  path: string,
  opts?: { query?: Record<string, string | number> },
) => Promise<unknown>;

/**
 * Walk the table. Every failure mode lands as a finding rather than aborting the
 * run: a DevToApiError carries its status, and a bare Error (connection refused,
 * DNS) is caught the same way, so a dry run against a dead port classifies all
 * 130 rather than crashing on the first.
 */
export async function sweep(
  rf: Rf,
  targets: SweepTarget[],
  outDir: string,
  sha: string,
): Promise<{ findings: Finding[]; captures: string[] }> {
  const findings: Finding[] = [];
  const captures: string[] = [];
  for (const target of targets) {
    if (target.kind === "skipped") {
      findings.push({
        kind: "unexercised",
        template: target.template,
        method: target.method,
        cause: target.cause,
        reason: target.reason,
      });
      continue;
    }
    const { template, method, path } = target;
    // re-derive at capture time: the table's ids are built from what discovery
    // found, and a real id can collide with a sibling template the pure builder
    // never saw
    let derived: string;
    try {
      derived = deriveTemplate(path, method);
    } catch (err) {
      findings.push({
        kind: "unexercised",
        template,
        method,
        cause: "blocked",
        reason: `path derives to no template: ${String(err)}`,
      });
      continue;
    }
    if (derived !== template) {
      findings.push({
        kind: "unexercised",
        template,
        method,
        cause: "blocked",
        reason: `path ${path} derives to ${derived}, not ${template}`,
      });
      continue;
    }

    let payload: unknown;
    try {
      payload = await rf(method, path, target.query ? { query: target.query } : undefined);
    } catch (err) {
      const status = err instanceof DevToApiError ? ` (${err.status})` : "";
      findings.push({
        kind: "unexercised",
        template,
        method,
        cause: "blocked",
        reason: `request failed${status}: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    // classify the whole payload, trim only what goes to disk: `trim` exists to
    // keep megabytes of body_html off the filesystem, and classifying the prefix
    // instead would report `matched` for an undeclared key the 4th element carries
    const scrubbed = scrub(payload, target.scrubContent ?? false);
    findings.push(classifyPayload(template, method, scrubbed));
    const capture: Capture = {
      template,
      method,
      recordedAt: new Date().toISOString(),
      path,
      payload:
        target.trim !== undefined && Array.isArray(scrubbed)
          ? scrubbed.slice(0, target.trim)
          : scrubbed,
      source: `local-forem@${sha}`,
    };
    captures.push(writeFixture(outDir, capture));
  }
  return { findings, captures };
}

const ORDER = ["disagreed", "inconclusive", "matched", "vacuous", "unexercised"] as const;

export function renderReport(findings: Finding[], sha: string, baseUrl: string): string {
  const counts = Object.fromEntries(
    ORDER.map((k) => [k, findings.filter((f) => f.kind === k).length]),
  );
  const blocked = findings.filter((f) => f.kind === "unexercised" && f.cause === "blocked").length;
  const deferred = findings.filter(
    (f) => f.kind === "unexercised" && f.cause === "deferred",
  ).length;
  const lines: string[] = [
    `# Local Forem sweep`,
    ``,
    `Forem \`${sha}\` at ${baseUrl}. ${findings.length} operations classified.`,
    ``,
    `| Finding | Count |`,
    `|---|---|`,
    ...ORDER.map((k) => `| ${k} | ${counts[k]} |`),
    `| - of which blocked | ${blocked} |`,
    `| - of which deferred | ${deferred} |`,
    ``,
  ];

  const disagreed = findings.filter((f) => f.kind === "disagreed");
  lines.push(`## Disagreed (${disagreed.length})`, ``);
  if (disagreed.length === 0) lines.push(`None.`, ``);
  for (const f of disagreed) {
    if (f.kind !== "disagreed") continue;
    const undeclared = f.extra.length > 0 ? `undeclared keys: \`${f.extra.join("`, `")}\`` : "";
    lines.push(
      `- \`${f.method} ${f.template}\` - ${[undeclared, f.note].filter(Boolean).join("; ")}`,
      `  - disposition: **TODO** (spec error | local-deployment artifact)`,
    );
  }
  lines.push(``);

  const inconclusive = findings.filter((f) => f.kind === "inconclusive");
  lines.push(`## Inconclusive (${inconclusive.length})`, ``);
  if (inconclusive.length === 0) lines.push(`None.`, ``);
  for (const f of inconclusive) {
    if (f.kind !== "inconclusive") continue;
    const hits = f.missing.map((k) => `${k} ${f.hits[k] ?? 0}/${f.elements}`).join(", ");
    lines.push(`- \`${f.method} ${f.template}\` - declared but never carried: ${hits}`);
  }
  lines.push(``);

  const matched = findings.filter((f) => f.kind === "matched");
  lines.push(`## Matched (${matched.length})`, ``);
  for (const f of matched) lines.push(`- \`${f.method} ${f.template}\``);
  lines.push(``);

  const vacuous = findings.filter((f) => f.kind === "vacuous");
  lines.push(`## Vacuous (${vacuous.length})`, ``);
  for (const f of vacuous)
    lines.push(`- \`${f.method} ${f.template}\` - empty payload, verified nothing`);
  lines.push(``);

  lines.push(`## Unexercised (${blocked + deferred})`, ``);
  for (const cause of ["blocked", "deferred"] as const) {
    const group = findings.filter((f) => f.kind === "unexercised" && f.cause === cause);
    lines.push(`### ${cause} (${group.length})`, ``);
    for (const f of group) {
      if (f.kind !== "unexercised") continue;
      lines.push(`- \`${f.method} ${f.template}\` - ${f.reason}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

/** Best-effort discovery: every lookup that fails leaves its field unset, degrading those entries to blocked. */
export async function discover(rf: Rf): Promise<Discovered> {
  const d: Discovered = {};
  const tryGet = async <T>(
    path: string,
    query?: Record<string, string | number>,
  ): Promise<T | undefined> => {
    try {
      return (await rf("GET", path, query ? { query } : undefined)) as T;
    } catch {
      return undefined;
    }
  };

  // Array.isArray for the same reason firstId below has it: tryGet swallows a
  // failed request, not a 200 of the wrong shape, and `.find` on a non-array
  // would abort the whole run before a single operation is classified
  const listed = await tryGet<
    { id: number; path: string; user?: { user_id: number }; organization?: { username: string } }[]
  >("/api/articles", { per_page: 10 });
  const articles = Array.isArray(listed) ? listed : undefined;
  const first = articles?.find((a) => !a.organization) ?? articles?.[0];
  if (first) {
    d.articleId = first.id;
    const [username, slug] = first.path.replace(/^\//, "").split("/");
    if (username) d.username = username;
    if (slug) d.slug = slug;
    if (first.user) d.userId = first.user.user_id;
  }
  const org = articles?.find((a) => a.organization && !/^\d+$/.test(a.organization.username))
    ?.organization?.username;
  if (org) d.organization = org;

  const me = await tryGet<{ id: number; email?: string }>("/api/users/me");
  if (me?.email) d.userEmail = me.email;

  const comments = d.articleId
    ? await tryGet<{ id_code: string }[]>("/api/comments", { a_id: d.articleId })
    : undefined;
  const comment = comments?.[0]?.id_code;
  if (comment) d.commentId = comment;

  const tags = await tryGet<{ name: string }[]>("/api/tags");
  const tag = tags?.[0]?.name;
  if (tag) d.tag = tag;

  // each of these is a plain "first element of the index" lookup; an endpoint the
  // seed leaves empty (or that 401s) simply leaves its field unset
  const firstId = async (path: string): Promise<number | undefined> => {
    const list = await tryGet<{ id: number }[]>(path);
    return Array.isArray(list) ? list[0]?.id : undefined;
  };
  const set = async (field: keyof Discovered, path: string): Promise<void> => {
    const id = await firstId(path);
    if (id !== undefined) Object.assign(d, { [field]: id });
  };
  await set("pageId", "/api/pages");
  await set("badgeId", "/api/badges");
  await set("badgeAchievementId", "/api/badge_achievements");
  await set("billboardId", "/api/billboards");
  await set("conceptId", "/api/concepts");
  await set("segmentId", "/api/segments");
  await set("surveyId", "/api/surveys");
  await set("trendId", "/api/trends");
  await set("recommendedArticlesListId", "/api/recommended_articles_lists");
  await set("requestRedirectId", "/api/admin/request_redirects");
  await set("agentSessionId", "/api/agent_sessions");
  await set("organizationId", "/api/organizations");
  // a fixed window rather than a discovered one: analytics rejects a missing start
  d.analyticsStart = "2020-01-01";
  return d;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outDir = process.argv[2] ?? CAPTURE_DIR;
  assertSweepSafe(process.env, outDir);

  const sha = process.env.FOREM_SHA ?? "ae359ff41b2a";
  const config = buildSweepConfig(process.env);
  const rf: Rf = (method, path, opts) => request(config, method, path, opts ?? {});

  const discovered = await discover(rf);
  // scrubbed like the captures are: discovery reads the operator's own email off
  // /api/users/me, and this line is the one place it would otherwise print verbatim
  console.log(`discovered: ${JSON.stringify(scrub(discovered))}`);
  const targets = buildTargets(discovered);
  const { findings, captures } = await sweep(rf, targets, outDir, sha);

  const report = renderReport(findings, sha, config.baseUrl);
  // docs/ is gitignored, so a fresh clone has none. Without this the dry run the
  // docstring above advertises sweeps all 130 operations and then dies on ENOENT.
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/local-forem-sweep.md", `${report}\n`);
  console.log(`${captures.length} captures in ${outDir}, report in docs/local-forem-sweep.md`);
  for (const kind of ORDER) {
    console.log(`${kind}: ${findings.filter((f) => f.kind === kind).length}`);
  }
}
