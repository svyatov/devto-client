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
 * Pass two adds the write half: every operation is attempted from the lowest rung
 * of the privilege ladder upward, stopping at the first success, so one run
 * answers both what the server returns and what credential it took to get it.
 *
 * Run: see the rung environment variables in docs/local-forem.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DevToApiError } from "../src/errors.ts";
import { type ClientOptions, type ResolvedConfig, request, resolveConfig } from "../src/http.ts";
import { isLoopback, type Recorded, scrub, writeFixture } from "./record-fixtures.ts";
import {
  extraKeys,
  isInlineSchema,
  isShapeMismatch,
  isVacuous,
  missingKeys,
  type Schema,
  successSchema,
} from "./spec-keys.ts";
import { deriveTemplate } from "./spec-templates.ts";
import {
  buildTargets,
  type Cause,
  type Created,
  type Discovered,
  type SweepTarget,
  specOperations,
} from "./sweep-targets.ts";

export const CAPTURE_DIR = "docs/sweep-captures";

/** A capture is a recorder envelope plus the stamp that keeps it out of the Recorded tier. */
export interface Capture extends Recorded {
  source: string;
}

/**
 * What authorized the observation. A rung is only the honest answer when the
 * policy consulted privilege alone; where it consulted a relationship or a
 * type-scoped grant instead, "the lowest rung that succeeded" is an artifact of
 * who created the record, not a requirement (R10).
 */
export type Authorization =
  | { via: "rung"; rung: Rung }
  | { via: "relationship"; relationship: Relationship; rung: Rung }
  // `rung` is kept for context, not as the answer: the grant is what authorized it
  | { via: "scoped-grant"; resourceType: string; rung: Rung };

/** Fields every finding carries, whatever its verdict. */
type Located = {
  template: string;
  method: string;
  auth?: Authorization;
  /** R9: a destructive rung-gated operation that succeeded below its documented rung. */
  escalation?: string;
  /** Why the type-scoped grant probe could not run, when it could not (U7). */
  grantNote?: string;
};

export type Finding =
  | ({ kind: "matched" } & Located)
  | ({ kind: "disagreed"; extra: string[]; note?: string } & Located)
  | ({
      kind: "inconclusive";
      missing: string[];
      elements: number;
      hits: Record<string, number>;
    } & Located)
  | ({ kind: "vacuous" } & Located)
  | ({ kind: "confirmed-empty" } & Located)
  | ({ kind: "unexercised"; cause: Cause; reason: string } & Located);

/** Report ordering for the unexercised causes; also the list every run renders, empty or not. */
export const CAUSES: Cause[] = [
  "blocked",
  "prerequisite-failed",
  "refused",
  "target-not-found",
  "payload-rejected",
  "tier-unavailable",
];

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

/**
 * The privilege ladder, lowest first. Read against the pinned Forem checkout, not
 * the README: Forem has no role named `moderator`. `ANY_ADMIN_ROLES` is `admin`
 * and `super_admin`; the endpoints the README calls moderator-gated resolve to
 * `elevated_user?` (`any_admin? || super_moderator?`); and `trusted` sits below
 * that with the narrower surface `moderation_routes?` grants. `tech_admin` is not
 * on the ladder at all - the seeded admin carries it, but it is not in
 * `ANY_ADMIN_ROLES` and grants none of what these endpoints check.
 */
export const RUNGS = ["anonymous", "user", "trusted", "super_moderator", "admin"] as const;
export type Rung = (typeof RUNGS)[number];

/** The env var carrying each rung's key. Anonymous has none by definition. */
export const RUNG_ENV: Record<Exclude<Rung, "anonymous">, string> = {
  user: "FOREM_KEY_USER",
  trusted: "FOREM_KEY_TRUSTED",
  super_moderator: "FOREM_KEY_SUPER_MODERATOR",
  admin: "FOREM_KEY_ADMIN",
};

/**
 * R20: every rung's account is minted for the sweep and named with this prefix,
 * and discovery refuses to select one. Ten of the writes suspend a user or revoke
 * a role, so a run that picked its own credential as the target would knock out
 * the ladder halfway through and report the damage as a privilege finding.
 */
export const RUNG_ACCOUNT_PREFIX = "sweep-rung-";

export type RungClient = { rung: Rung; config: ResolvedConfig } | { rung: Rung; cause: string };

export const isUnavailable = (r: RungClient): r is { rung: Rung; cause: string } => "cause" in r;

/**
 * KTD6: a rung the operator never provisioned is a gap in coverage, not a reason
 * to abandon the run. The host assertions still throw - pointing a credentialed
 * sweep at the wrong machine is a different class of mistake from a missing key.
 */
export function resolveRung(rung: Rung, env: NodeJS.ProcessEnv): RungClient {
  const baseUrl = env.FOREM_BASE_URL;
  if (baseUrl === undefined) throw new Error("FOREM_BASE_URL is required to resolve a rung");
  if (!isLoopback(baseUrl)) throw new Error(`refusing to sweep a non-loopback host: ${baseUrl}`);

  const options: ClientOptions = {
    baseUrl,
    retry: { attempts: 3 },
    timeoutMs: 30_000,
    pace: false,
    allowInsecureHttp: new URL(baseUrl).protocol === "http:",
  };
  if (rung !== "anonymous") {
    // read straight from the rung's own variable: no fallback chain, so
    // DEVTO_API_KEY can never reach a rung by accident the way resolveTarget's
    // default-host branch would allow
    const key = env[RUNG_ENV[rung]];
    if (key === undefined || key === "") {
      return { rung, cause: `tier unavailable: set ${RUNG_ENV[rung]} to a key for this rung` };
    }
    options.apiKey = key;
  }
  return { rung, config: resolveConfig(options) };
}

export const resolveRungs = (env: NodeJS.ProcessEnv): RungClient[] =>
  RUNGS.map((r) => resolveRung(r, env));

export type Relationship = "author" | "org-admin";

/**
 * Operations the pinned Forem authorizes through a relationship rather than a
 * ladder position (R10), read from `ae359ff41b2a`:
 *
 * - `Api::ArticlesController#update` looks the record up in `@user.articles`
 *   unless the caller is `super_admin`, so a non-owner gets a scoped miss.
 * - `OrganizationPolicy#update?` is `any_admin? || org_admin?(record)`.
 *
 * For these the rung that succeeds says who created the record, not what
 * privilege the endpoint needs, so recording one would be actively misleading.
 */
export const RELATIONSHIP_GATED: Record<string, Relationship> = {
  "PUT /api/articles/{id}": "author",
  "PUT /api/organizations/{id}": "org-admin",
};

/**
 * Operations whose controller authorizes against the model *class* -
 * `authorize Billboard, :access?, policy_class: InternalPolicy` and its
 * siblings - which `administrative_access_to?` also satisfies from a
 * `single_resource_admin` grant on that resource type (U7).
 */
export const SCOPED_GRANT_TYPES: { prefix: string; resourceType: string }[] = [
  { prefix: "/api/billboards", resourceType: "Billboard" },
  { prefix: "/api/pages", resourceType: "Page" },
  { prefix: "/api/recommended_articles_lists", resourceType: "RecommendedArticlesList" },
  { prefix: "/api/segments", resourceType: "AudienceSegment" },
  { prefix: "/api/organizations", resourceType: "Organization" },
];

export const scopedGrantType = (template: string, method: string): string | undefined =>
  method === "GET"
    ? undefined
    : SCOPED_GRANT_TYPES.find((s) => template.startsWith(s.prefix))?.resourceType;

/**
 * What the README's namespace table claims, mapped onto the ladder (R11). Longest
 * prefix wins. This is the only catalog of privilege the repo has, it has drifted
 * from reality before, and reconciling against it is the point rather than a
 * formality - `organizations` claiming "public" for operations that demand
 * `super_admin` is exactly the kind of entry a run should surface.
 */
export const DOCUMENTED_RUNG: { prefix: string; rung: Rung }[] = [
  { prefix: "/api/articles/{id}/unpublish", rung: "super_moderator" },
  { prefix: "/api/admin/", rung: "admin" },
  { prefix: "/api/agent_sessions", rung: "user" },
  { prefix: "/api/articles", rung: "user" },
  { prefix: "/api/badge_achievements", rung: "admin" },
  { prefix: "/api/badges", rung: "admin" },
  { prefix: "/api/billboards", rung: "admin" },
  { prefix: "/api/concepts", rung: "anonymous" },
  { prefix: "/api/feedback_messages", rung: "super_moderator" },
  { prefix: "/api/follows", rung: "user" },
  { prefix: "/api/organizations", rung: "anonymous" },
  { prefix: "/api/pages", rung: "admin" },
  { prefix: "/api/reactions", rung: "admin" },
  { prefix: "/api/recommended_articles_lists", rung: "user" },
  { prefix: "/api/segments", rung: "admin" },
  { prefix: "/api/users", rung: "super_moderator" },
];

export const documentedRung = (template: string): Rung | undefined =>
  [...DOCUMENTED_RUNG]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((e) => template.startsWith(e.prefix))?.rung;

/** Operations that remove a target, or change a user's roles or standing (R5, R9). */
export const isDestructive = (template: string, method: string): boolean =>
  method === "DELETE" || /\/(suspend|spam|limited|trusted|unpublish|merge)$/.test(template);

/**
 * Reasons land verbatim in a markdown report. Forem in development answers a 500
 * with a full better_errors HTML page, and one of those pushed 150 lines of Ruby
 * backtrace into the findings document.
 */
export const trimReason = (reason: string): string => {
  const firstLine = reason.split("\n")[0] ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}...` : firstLine;
};

/** One attempt's outcome, reduced to the four things the ladder decides on. */
export type Attempt =
  | { kind: "success"; payload: unknown }
  | { kind: "refused" }
  | { kind: "not-found" }
  | { kind: "payload-rejected"; reason: string }
  | { kind: "error"; reason: string };

/**
 * Read a thrown error as a ladder outcome. Payload rejection deliberately does
 * not escalate: retrying a malformed request with more privilege would file a
 * client error as a privilege gap, and no rung fixes a body the server refuses.
 */
export function readError(err: unknown): Attempt {
  if (!(err instanceof DevToApiError)) {
    return { kind: "error", reason: trimReason(err instanceof Error ? err.message : String(err)) };
  }
  const detail = trimReason(`request failed (${err.status}): ${err.message}`);
  if (err.status === 401 || err.status === 403) return { kind: "refused" };
  if (err.status === 404) return { kind: "not-found" };
  if (err.status === 400 || err.status === 409 || err.status === 422) {
    return { kind: "payload-rejected", reason: detail };
  }
  return { kind: "error", reason: detail };
}

/**
 * The account holding the `single_resource_admin` grants (U7). One account covers
 * every affected resource type, because the grant is keyed by type rather than by
 * record, which is what makes the path probeable without chasing the run's own ids.
 */
export interface ScopedGrant {
  call?: (method: string, path: string, opts?: RequestOpts) => Promise<unknown>;
  cause?: string;
}

export const SCOPED_GRANT_ENV = "FOREM_KEY_SCOPED_GRANT";

/** The rungs available to a run, plus how to issue a request as one of them. */
export interface Ladder {
  rungs: RungClient[];
  call: (rung: Rung, method: string, path: string, opts?: RequestOpts) => Promise<unknown>;
  scopedGrant?: ScopedGrant;
}

export type LadderResult =
  | { kind: "success"; rung: Rung; payload: unknown; attempted: Rung[] }
  | { kind: "skip"; cause: Cause; reason: string };

/**
 * Attempt one operation from the lowest rung upward, stopping at the first
 * success (R6). At most one mutation lands per operation: every attempt below the
 * successful one was refused before it touched state.
 */
export async function climb(
  ladder: Ladder,
  target: { method: string; path: string; query?: Record<string, string | number>; body?: unknown },
  fromLedger: boolean,
): Promise<LadderResult> {
  const missing: string[] = [];
  const attempted: Rung[] = [];
  for (const client of ladder.rungs) {
    if (isUnavailable(client)) {
      missing.push(client.cause);
      continue;
    }
    attempted.push(client.rung);
    let outcome: Attempt;
    try {
      const payload = await ladder.call(
        client.rung,
        target.method,
        target.path,
        requestOpts(target),
      );
      outcome = { kind: "success", payload };
    } catch (err) {
      outcome = readError(err);
    }
    if (outcome.kind === "success") {
      return { kind: "success", rung: client.rung, payload: outcome.payload, attempted };
    }
    if (outcome.kind === "refused") continue;
    if (outcome.kind === "not-found") {
      // F2: Forem scopes several write lookups to the caller's own records and
      // renders the resulting miss as 404. On an identifier this run created the
      // record provably exists, so a miss is a refusal and escalates; on any
      // other identifier it means the target is simply not there.
      if (fromLedger) continue;
      return { kind: "skip", cause: "target-not-found", reason: `not found: ${target.path}` };
    }
    if (outcome.kind === "payload-rejected") {
      return { kind: "skip", cause: "payload-rejected", reason: outcome.reason };
    }
    return { kind: "skip", cause: "blocked", reason: outcome.reason };
  }
  if (attempted.length === 0) {
    return {
      kind: "skip",
      cause: "tier-unavailable",
      reason: missing.join("; ") || "no rung is configured",
    };
  }
  return {
    kind: "skip",
    cause: "refused",
    reason: `refused at every configured rung: ${attempted.join(", ")}`,
  };
}

/**
 * What the successful rung means, and whether it beat the documentation. R21
 * exempts relationship-authorized operations from the escalation finding: an
 * owner deleting their own article is not a privilege escalation.
 */
export function authorize(
  template: string,
  method: string,
  rung: Rung,
): { auth: Authorization; escalation?: string } {
  const relationship = RELATIONSHIP_GATED[`${method} ${template}`];
  if (relationship) return { auth: { via: "relationship", relationship, rung } };
  const auth: Authorization = { via: "rung", rung };
  const documented = documentedRung(template);
  if (
    isDestructive(template, method) &&
    documented !== undefined &&
    RUNGS.indexOf(rung) < RUNGS.indexOf(documented)
  ) {
    return {
      auth,
      escalation: `succeeded at ${rung}, below the documented ${documented}`,
    };
  }
  return { auth };
}

export const RESET_DB = "Forem_development";
export const RESET_HINT =
  "restore the baseline snapshot as the reset procedure in docs/local-forem.md describes, then re-run";

/**
 * The HTTP half refuses a non-loopback host; this is the same guard for the half
 * that runs `pg_dump` and `pg_restore`. A stale `DATABASE_URL` pointing at another
 * local database would otherwise be overwritten without a word.
 */
export function assertResetTarget(databaseUrl: string | undefined, expected = RESET_DB): void {
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error(`DATABASE_URL is required to capture or restore the baseline (${expected})`);
  }
  const url = new URL(databaseUrl);
  if (!isLoopback(databaseUrl)) {
    throw new Error(`refusing to reset a non-loopback database host: ${url.hostname}`);
  }
  const name = url.pathname.replace(/^\//, "");
  if (name !== expected) {
    throw new Error(`refusing to capture or restore database "${name}": expected "${expected}"`);
  }
}

/**
 * The partial-seed signature documented in docs/local-forem.md is organizations
 * and four users only, so the floor sits just above it. A restored instance below
 * this reads exactly like a thin seed, which is the confusion U8 exists to prevent.
 */
export const BASELINE_FLOOR = { users: 5, articles: 1 };

/**
 * Everything that has to be true before a run's results mean anything. Returns
 * the problems rather than throwing, so the caller decides - but every message
 * names the reset procedure, not the field, because the field is a symptom.
 */
export function preflight(observed: {
  users: number;
  articles: number;
  /** Rungs whose key resolved but whose account did not answer as itself after the restore. */
  rungsUnverified: Rung[];
}): string[] {
  const problems: string[] = [];
  if (observed.users < BASELINE_FLOOR.users) {
    problems.push(
      `baseline discovery found ${observed.users} users, below the floor of ${BASELINE_FLOOR.users}: ${RESET_HINT}`,
    );
  }
  if (observed.articles < BASELINE_FLOOR.articles) {
    problems.push(
      `baseline discovery found ${observed.articles} articles, below the floor of ${BASELINE_FLOOR.articles}: ${RESET_HINT}`,
    );
  }
  for (const rung of observed.rungsUnverified) {
    problems.push(
      `rung ${rung} has a key but its account did not survive the restore: ${RESET_HINT}`,
    );
  }
  return problems;
}

/**
 * A read only this rung's role can serve. Only `admin` has one: no v1 read is
 * gated on exactly `trusted` or exactly `super_moderator`, so for those rungs the
 * identity check below is the whole check available through the API.
 */
const ROLE_PROBE: Partial<Record<Rung, string>> = { admin: "/api/admin/users" };

/** Which configured rungs failed to answer as their own dedicated account (R20, U8). */
export async function verifyRungs(ladder: Ladder): Promise<Rung[]> {
  const unverified: Rung[] = [];
  for (const client of ladder.rungs) {
    if (isUnavailable(client) || client.rung === "anonymous") continue;
    try {
      const me = (await ladder.call(client.rung, "GET", "/api/users/me")) as {
        username?: string;
      } | null;
      if (me?.username !== `${RUNG_ACCOUNT_PREFIX}${client.rung}`) {
        unverified.push(client.rung);
        continue;
      }
      const probe = ROLE_PROBE[client.rung];
      if (probe !== undefined) await ladder.call(client.rung, "GET", probe);
    } catch {
      unverified.push(client.rung);
    }
  }
  return unverified;
}

/** Issues each request as the rung asked for; the production half of a `Ladder`. */
export function buildLadder(env: NodeJS.ProcessEnv): Ladder {
  const rungs = resolveRungs(env);
  const baseUrl = env.FOREM_BASE_URL;
  if (baseUrl === undefined) throw new Error("FOREM_BASE_URL is required to build a ladder");
  const key = env[SCOPED_GRANT_ENV];
  const scopedGrant: ScopedGrant =
    key === undefined || key === ""
      ? { cause: `${SCOPED_GRANT_ENV} is not set; the type-scoped grant path was not probed` }
      : {
          call: (method, path, opts) => {
            const config = resolveConfig({
              baseUrl,
              apiKey: key,
              retry: { attempts: 3 },
              timeoutMs: 30_000,
              pace: false,
              allowInsecureHttp: new URL(baseUrl).protocol === "http:",
            });
            return request(config, method, path, opts ?? {});
          },
        };
  return {
    rungs,
    scopedGrant,
    call: (rung, method, path, opts) => {
      const client = rungs.find((r) => r.rung === rung);
      if (client === undefined || isUnavailable(client)) {
        throw new Error(`rung not configured: ${rung}`);
      }
      return request(client.config, method, path, opts ?? {});
    },
  };
}

/** The highest rung with a credential; discovery needs admin reads to find its write targets. */
export const topRung = (ladder: Ladder): RungClient | undefined =>
  [...ladder.rungs].reverse().find((r) => !isUnavailable(r));

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
  // KTD3: ahead of the vacuous check, not after it. An absent payload satisfies
  // `isVacuous`, so with the old order every no-body write - a quarter of the
  // write half - reported "verified nothing" while the server had in fact agreed.
  if (lookup.kind === "none") {
    if (isVacuous(payload)) return { kind: "confirmed-empty", template, method };
    // op declares no JSON body, yet something came back
    return {
      kind: "disagreed",
      template,
      method,
      extra: [],
      note: "spec declares no success body",
    };
  }
  if (isVacuous(payload)) return { kind: "vacuous", template, method };
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

export type RequestOpts = { query?: Record<string, string | number>; body?: unknown };

type Rf = (method: string, path: string, opts?: RequestOpts) => Promise<unknown>;

/**
 * Conditional assignment, not a spread of possibly-undefined: exactOptionalPropertyTypes
 * rejects `{ body: undefined }` where the property is optional, and passing it
 * anyway would make `body` present-but-undefined in the transport layer.
 */
export function requestOpts(target: {
  query?: Record<string, string | number>;
  body?: unknown;
}): RequestOpts | undefined {
  const opts: RequestOpts = {};
  if (target.query) opts.query = target.query;
  if (target.body !== undefined) opts.body = target.body;
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * Walk the table. Every failure mode lands as a finding rather than aborting the
 * run: a DevToApiError carries its status, and a bare Error (connection refused,
 * DNS) is caught the same way, so a dry run against a dead port classifies all
 * 130 rather than crashing on the first.
 */
export const opKey = (o: { template: string; method: string }): string =>
  `${o.method} ${o.template}`;

export async function sweep(
  ladder: Ladder,
  targets: SweepTarget[],
  outDir: string,
  sha: string,
): Promise<{
  findings: Finding[];
  captures: string[];
  /** Successful payloads by `METHOD /template`, so the write sequence can read out created ids. */
  payloads: Record<string, unknown>;
}> {
  const findings: Finding[] = [];
  const captures: string[] = [];
  const payloads: Record<string, unknown> = {};
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

    const climbed = await climb(ladder, target, target.fromLedger ?? false);
    if (climbed.kind === "skip") {
      findings.push({
        kind: "unexercised",
        template,
        method,
        cause: climbed.cause,
        reason: climbed.reason,
      });
      continue;
    }
    // classify the whole payload, trim only what goes to disk: `trim` exists to
    // keep megabytes of body_html off the filesystem, and classifying the prefix
    // instead would report `matched` for an undeclared key the 4th element carries
    const scrubbed = scrub(climbed.payload, target.scrubContent ?? false);
    payloads[opKey(target)] = climbed.payload;
    const { auth, escalation } = authorize(template, method, climbed.rung);
    const finding = classifyPayload(template, method, scrubbed);
    finding.auth = auth;
    if (escalation !== undefined) finding.escalation = escalation;

    // U7: one fixed extra attempt, and only for the operations whose controller
    // authorizes against the model class. A grant that authorizes replaces the
    // rung, because for these no rung is the real requirement.
    const resourceType = scopedGrantType(template, method);
    if (resourceType !== undefined) {
      const grant = ladder.scopedGrant;
      if (grant?.call === undefined) {
        finding.grantNote = grant?.cause ?? `${SCOPED_GRANT_ENV} is not set`;
      } else {
        try {
          await grant.call(method, path, requestOpts(target));
          finding.auth = { via: "scoped-grant", resourceType, rung: climbed.rung };
        } catch {
          // the grant does not authorize this one; the ladder's answer stands
        }
      }
    }
    findings.push(finding);
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
  return { findings, captures, payloads };
}

/** What a create put on the board, and which rung put it there (R7, and the ladder's 404 rule). */
export interface LedgerEntry {
  id: string | number;
  rung: Rung;
}
export type Ledger = Partial<Record<Created, LedgerEntry>>;

/**
 * The creates, in dependency order: a badge before the achievement that awards it,
 * a user identity last because it needs a target account discovery had to find.
 */
export const CREATE_SEQUENCE: { op: string; resource: Created }[] = [
  { op: "POST /api/articles", resource: "article" },
  { op: "POST /api/agent_sessions", resource: "agentSession" },
  { op: "POST /api/badges", resource: "badge" },
  { op: "POST /api/badge_achievements", resource: "badgeAchievement" },
  { op: "POST /api/billboards", resource: "billboard" },
  { op: "POST /api/admin/concepts", resource: "concept" },
  { op: "POST /api/organizations", resource: "organization" },
  { op: "POST /api/pages", resource: "page" },
  { op: "POST /api/segments", resource: "segment" },
  { op: "POST /api/recommended_articles_lists", resource: "recommendedArticlesList" },
  { op: "POST /api/admin/request_redirects", resource: "requestRedirect" },
  { op: "POST /api/admin/users/{user_id}/identities", resource: "userIdentity" },
];

/**
 * Where a created identifier lands in the discovery record, so the reads that had
 * nothing to find re-run against it (R3). Filled only where discovery came up
 * empty: overriding a discovered value would silently change what a read observed.
 */
const LEDGER_TO_DISCOVERY: Partial<Record<Created, keyof Discovered>> = {
  agentSession: "agentSessionId",
  article: "articleId",
  badge: "badgeId",
  badgeAchievement: "badgeAchievementId",
  billboard: "billboardId",
  concept: "conceptId",
  organization: "organizationId",
  page: "pageId",
  recommendedArticlesList: "recommendedArticlesListId",
  requestRedirect: "requestRedirectId",
  segment: "segmentId",
};

/** The id a create handed back. Forem wraps some payloads one level (`{badge: {id}}`). */
export function extractId(payload: unknown): string | number | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ["id", "id_code"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") return value;
  }
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const inner = (value as Record<string, unknown>).id;
      if (typeof inner === "string" || typeof inner === "number") return inner;
    }
  }
  return undefined;
}

/** Fold the ledger back into a discovery record the pure target table can resolve against. */
export function withLedger(discovered: Discovered, ledger: Ledger): Discovered {
  const created: Partial<Record<Created, string | number>> = {};
  const filled: Discovered = { ...discovered };
  for (const [resource, entry] of Object.entries(ledger) as [Created, LedgerEntry][]) {
    created[resource] = entry.id;
    const field = LEDGER_TO_DISCOVERY[resource];
    if (field !== undefined && filled[field] === undefined) {
      Object.assign(filled, { [field]: entry.id });
    }
  }
  return { ...filled, created };
}

/**
 * One ordered pass (F1). Reads first, then creates, then the reads that were
 * blocked on what the creates made, then updates, then everything destructive.
 *
 * Findings are keyed by method and template, so a re-run replaces its earlier
 * blocked entry instead of appending a second verdict for the same operation.
 */
export async function runSweep(
  ladder: Ladder,
  discovered: Discovered,
  outDir: string,
  sha: string,
  /** Called with the findings so far before the destructive phase, so a late failure discards nothing. */
  checkpoint?: (findings: Finding[]) => void,
): Promise<{ findings: Finding[]; captures: string[]; ledger: Ledger }> {
  const found = new Map<string, Finding>();
  const captures: string[] = [];
  const ledger: Ledger = {};

  const state = (): Discovered => withLedger(discovered, ledger);
  const targetsNow = (): Map<string, SweepTarget> =>
    new Map(buildTargets(state()).map((t) => [opKey(t), t]));

  const runBatch = async (targets: SweepTarget[]): Promise<Record<string, unknown>> => {
    const result = await sweep(ladder, targets, outDir, sha);
    for (const f of result.findings) found.set(opKey(f), f);
    captures.push(...result.captures);
    return result.payloads;
  };

  const all = targetsNow();
  const phaseOf = (t: SweepTarget): "read" | "create" | "update" | "destroy" => {
    if (t.method === "GET") return "read";
    if (CREATE_SEQUENCE.some((c) => c.op === opKey(t))) return "create";
    return isDestructive(t.template, t.method) ? "destroy" : "update";
  };

  await runBatch([...all.values()].filter((t) => phaseOf(t) === "read"));

  // creates one at a time: each one's identifier has to be on the board before the
  // next recipe is built, and a badge achievement needs the badge that precedes it
  for (const { op, resource } of CREATE_SEQUENCE) {
    const target = targetsNow().get(op);
    if (target === undefined) continue;
    const payloads = await runBatch([target]);
    const id = extractId(payloads[op]);
    // every authorization path carries the rung the ladder reached, including the
    // scoped-grant one - keying off `via === "rung"` here silently dropped every
    // billboard, page and organization the run created
    const auth = found.get(op)?.auth;
    if (id !== undefined && auth !== undefined) ledger[resource] = { id, rung: auth.rung };
  }

  // R3: the reads that had nothing to discover, re-run now that the creates exist
  const reread = [...targetsNow().values()].filter(
    (t) =>
      t.method === "GET" && t.kind === "targeted" && found.get(opKey(t))?.kind === "unexercised",
  );
  await runBatch(reread);

  await runBatch([...targetsNow().values()].filter((t) => phaseOf(t) === "update"));
  checkpoint?.([...found.values()]);

  // last, and last for a reason: these delete records the earlier phases needed,
  // and ten of them suspend a user or revoke a role - including, if discovery had
  // picked one, the very accounts the ladder authenticates with
  await runBatch([...targetsNow().values()].filter((t) => phaseOf(t) === "destroy"));

  // spec order, not phase order, so the report reads the same way twice
  const order = specOperations().map(opKey);
  const findings = order.flatMap((k) => {
    const f = found.get(k);
    return f ? [f] : [];
  });
  return { findings, captures, ledger };
}

const ORDER = [
  "disagreed",
  "inconclusive",
  "matched",
  "confirmed-empty",
  "vacuous",
  "unexercised",
] as const;

export function renderReport(findings: Finding[], sha: string, baseUrl: string): string {
  const counts = Object.fromEntries(
    ORDER.map((k) => [k, findings.filter((f) => f.kind === k).length]),
  );
  const byCause = (cause: Cause): Finding[] =>
    findings.filter((f) => f.kind === "unexercised" && f.cause === cause);
  const lines: string[] = [
    `# Local Forem sweep`,
    ``,
    `Forem \`${sha}\` at ${baseUrl}. ${findings.length} operations classified.`,
    ``,
    `| Finding | Count |`,
    `|---|---|`,
    ...ORDER.map((k) => `| ${k} | ${counts[k]} |`),
    ...CAUSES.map((c) => `| - of which ${c} | ${byCause(c).length} |`),
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

  const empty = findings.filter((f) => f.kind === "confirmed-empty");
  lines.push(`## Confirmed empty (${empty.length})`, ``);
  if (empty.length === 0) lines.push(`None.`, ``);
  for (const f of empty)
    lines.push(`- \`${f.method} ${f.template}\` - spec declares no body, server sent none`);
  lines.push(``);

  const vacuous = findings.filter((f) => f.kind === "vacuous");
  lines.push(`## Vacuous (${vacuous.length})`, ``);
  for (const f of vacuous)
    lines.push(`- \`${f.method} ${f.template}\` - empty payload, verified nothing`);
  lines.push(``);

  lines.push(`## Unexercised (${counts.unexercised})`, ``);
  for (const cause of CAUSES) {
    const group = byCause(cause);
    lines.push(`### ${cause} (${group.length})`, ``);
    for (const f of group) {
      if (f.kind !== "unexercised") continue;
      lines.push(`- \`${f.method} ${f.template}\` - ${f.reason}`);
    }
    lines.push(``);
  }

  const writes = findings.filter((f) => f.method !== "GET");
  lines.push(
    `## Authorization observed (${writes.filter((f) => f.auth).length} of ${writes.length} writes)`,
    ``,
    // R14: this is the whole provenance these values will ever have. Nothing
    // corroborates a tier - dev.to cannot be asked which role an endpoint wants.
    `Every value below rests on local observation against Forem \`${sha}\` alone. No second`,
    `server can corroborate a credential tier, so none of it is corroborated.`,
    ``,
  );
  if (writes.length === 0) lines.push(`None.`, ``);
  for (const f of writes) {
    const label = authLabel(f);
    const note = f.grantNote === undefined ? "" : ` (${f.grantNote})`;
    lines.push(`- \`${f.method} ${f.template}\` - ${label}${note}`);
  }
  lines.push(``);

  const escalations = findings.filter((f) => f.escalation !== undefined);
  lines.push(`## Escalation findings (${escalations.length})`, ``);
  if (escalations.length === 0) lines.push(`None.`, ``);
  for (const f of escalations) {
    lines.push(
      `- \`${f.method} ${f.template}\` - ${f.escalation}`,
      `  - disposition: **TODO** (upstream defect | README error)`,
    );
  }
  lines.push(``);

  const drift = reconcileWithReadme(findings);
  lines.push(`## README tier reconciliation (${drift.length})`, ``);
  if (drift.length === 0) lines.push(`None.`, ``);
  for (const d of drift)
    lines.push(`- \`${d.op}\` - README says ${d.documented}, observed ${d.observed}`);
  lines.push(``);

  const inline = findings.filter((f) => isInlineSchema(f.template, f.method));
  lines.push(`## Inline unnamed response schemas (${inline.length})`, ``);
  if (inline.length === 0) lines.push(`None.`, ``);
  for (const f of inline) {
    lines.push(`- \`${f.method} ${f.template}\` - ${f.kind}; the spec never named this shape`);
  }
  lines.push(``);
  return lines.join("\n");
}

/** How an operation was authorized, in one phrase. */
export function authLabel(f: Finding): string {
  if (f.auth === undefined) return "not exercised";
  if (f.auth.via === "rung") return f.auth.rung;
  if (f.auth.via === "relationship") {
    return `${f.auth.relationship} relationship, not a rung (observed at ${f.auth.rung})`;
  }
  return `single_resource_admin on ${f.auth.resourceType}, not a rung (ladder reached ${f.auth.rung})`;
}

/**
 * R11. The README's namespace table is the repo's only catalog of privilege and
 * has drifted before, so every disagreement is listed rather than quietly
 * corrected. Relationship- and grant-authorized operations are excluded: no rung
 * is their answer, so there is nothing to disagree with.
 */
export function reconcileWithReadme(
  findings: Finding[],
): { op: string; documented: Rung; observed: Rung }[] {
  const out: { op: string; documented: Rung; observed: Rung }[] = [];
  for (const f of findings) {
    if (f.method === "GET" || f.auth?.via !== "rung") continue;
    const documented = documentedRung(f.template);
    if (documented !== undefined && documented !== f.auth.rung) {
      out.push({ op: opKey(f), documented, observed: f.auth.rung });
    }
  }
  return out;
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

  // Two disposable accounts for the writes that suspend, retag and merge. The
  // filter is what keeps R20 true: a rung account picked here would be suspended
  // by the run's own destructive phase, taking its credential with it. The caller
  // is excluded for the same reason.
  const admin = await tryGet<{ users?: { id: number; username?: string; email?: string }[] }>(
    "/api/admin/users",
    { per_page: 30 },
  );
  const users = Array.isArray(admin) ? admin : (admin?.users ?? []);
  const disposable = (Array.isArray(users) ? users : []).filter(
    (u) => !u.username?.startsWith(RUNG_ACCOUNT_PREFIX) && u.id !== me?.id,
  );
  if (disposable[0]) d.targetUserId = disposable[0].id;
  if (disposable[1]) d.mergeUserId = disposable[1].id;
  // the user search needs an address that exists. `/api/users/me` renders email
  // as null when the account hides it, which on a seeded instance is most of them
  d.userEmail ??= disposable.find((u) => u.email)?.email;

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
  // the org index is a second chance at {username}: the article listing only
  // yields one when a seeded article happens to belong to an organization
  if (d.organization === undefined) {
    const orgs = await tryGet<{ username?: string; slug?: string }[]>("/api/organizations");
    const name = Array.isArray(orgs) ? (orgs[0]?.username ?? orgs[0]?.slug) : undefined;
    if (name !== undefined && !/^\d+$/.test(name)) d.organization = name;
  }
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
  const baseUrl = process.env.FOREM_BASE_URL ?? "";
  const ladder = buildLadder(process.env);
  for (const r of ladder.rungs) {
    if (isUnavailable(r)) console.warn(`rung ${r.rung} unavailable: ${r.cause}`);
  }
  const top = topRung(ladder);
  if (top === undefined) throw new Error("no rung resolved, not even anonymous");
  const discoverRf: Rf = (method, path, opts) => ladder.call(top.rung, method, path, opts);

  const discovered = await discover(discoverRf);
  if (process.env.FOREM_IMAGE_URL) discovered.imageUrl = process.env.FOREM_IMAGE_URL;
  // scrubbed like the captures are: discovery reads the operator's own email off
  // /api/users/me, and this line is the one place it would otherwise print verbatim
  console.log(`discovered: ${JSON.stringify(scrub(discovered))}`);

  // U8: a partly-restored database produces a run that reads thin rather than
  // broken, so it has to fail here rather than downstream in a wall of causes
  const users = ((await discoverRf("GET", "/api/admin/users", { query: { per_page: 30 } }).catch(
    () => ({ users: [] }),
  )) as { users?: unknown[] }) ?? { users: [] };
  const articles = (await discoverRf("GET", "/api/articles").catch(() => [])) as unknown[];
  const problems = preflight({
    users: Array.isArray(users) ? users.length : (users.users?.length ?? 0),
    articles: Array.isArray(articles) ? articles.length : 0,
    rungsUnverified: await verifyRungs(ladder),
  });
  if (problems.length > 0) throw new Error(`pre-flight failed:\n- ${problems.join("\n- ")}`);

  // docs/ is gitignored, so a fresh clone has none. Without this the dry run the
  // docstring above advertises sweeps all 130 operations and then dies on ENOENT.
  mkdirSync("docs", { recursive: true });
  const write = (fs: Finding[]): void => {
    writeFileSync("docs/local-forem-sweep.md", `${renderReport(fs, sha, baseUrl)}\n`);
  };
  // checkpointed before the destructive phase: a late failure loses the last
  // phase's verdicts, never the whole run's
  const { findings, captures } = await runSweep(ladder, discovered, outDir, sha, write);
  write(findings);
  console.log(`${captures.length} captures in ${outDir}, report in docs/local-forem-sweep.md`);
  for (const kind of ORDER) {
    console.log(`${kind}: ${findings.filter((f) => f.kind === kind).length}`);
  }
}
