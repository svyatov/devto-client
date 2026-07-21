/**
 * Records real dev.to responses into tests/fixtures/recorded/: R17's raw material.
 *
 * Keyless: public read endpoints. With DEVTO_API_KEY (dedicated low-privilege
 * account only): user-scope reads plus the reversible write cycle: draft
 * create (published: false) → update → unpublish, and a reaction toggle pair.
 * POST /api/follows is NOT recorded: v1 has no unfollow endpoint, so the write
 * cannot be reversed in the same run (KTD9); its fixture stays type-derived.
 * Each run leaves its unpublished draft behind: v1 has no article-delete
 * endpoint; the run logs the draft id for manual cleanup.
 *
 * Run: DEVTO_API_KEY=... bun scripts/record-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { DevToApiError } from "../src/errors.ts";
import {
  type ClientOptions,
  type RequestOptions,
  type ResolvedConfig,
  request,
  resolveConfig,
} from "../src/http.ts";
import { createPacer } from "../src/pacing.ts";
import { deriveTemplate } from "./spec-templates.ts";

export type Rf = <T>(method: string, path: string, opts?: RequestOptions) => Promise<T>;

export interface ReadSpec {
  /** Spec path template, e.g. "/api/articles/{id}": U7 keys response types on this. */
  template: string;
  /** Concrete path to call. */
  path: string;
  method?: string;
  query?: Record<string, string | number>;
  /** Replace title/body/description content in the payload (draft listings). */
  scrubContent?: boolean;
  /** Cap array payloads at this many elements (pages ships megabytes of body_html). */
  trim?: number;
}

export interface Recorded {
  template: string;
  method: string;
  recordedAt: string;
  /** The concrete request path this recording hit: R8's chain-of-custody stamp. */
  path: string;
  payload: unknown;
}

/** R9 record-time guard: the label must be derivable from the path it was recorded from. */
function assertLabel(path: string, method: string, template: string): void {
  const derived = deriveTemplate(path, method);
  if (derived !== template) {
    throw new Error(`fixture mislabeled: ${method} ${path} derives to ${derived}, not ${template}`);
  }
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// slug/path/url/canonical_url derive from titles, so they leak draft content too
const CONTENT_FIELDS = new Set([
  "title",
  "body_markdown",
  "body_html",
  "description",
  "slug",
  "path",
  "url",
  "canonical_url",
]);

/** Replaces emails/IPs everywhere; with scrubContent, blanks content fields too. */
export function scrub(value: unknown, scrubContent = false): unknown {
  if (typeof value === "string") {
    return value.replaceAll(EMAIL_RE, "scrubbed@example.com").replaceAll(IP_RE, "0.0.0.0");
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, scrubContent));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        scrubContent && CONTENT_FIELDS.has(k) && typeof v === "string"
          ? `synthetic ${k} placeholder`
          : scrub(v, scrubContent),
      ]),
    );
  }
  return value;
}

/**
 * Records each read, persisting every fixture to `outDir` the moment it is
 * captured (KTD4) so a crash mid-crawl keeps completed work. 401/403/404 means
 * the key can't access it: skip, not fail.
 */
export async function recordReads(
  rf: Rf,
  specs: ReadSpec[],
  outDir: string,
  pauseMs = 3000, // keyless per-IP throttling on dev.to is far stricter than the per-key 3 GET/s
): Promise<{ recorded: Recorded[]; skipped: string[]; files: string[] }> {
  const recorded: Recorded[] = [];
  const skipped: string[] = [];
  const files: string[] = [];
  for (const spec of specs) {
    const method = spec.method ?? "GET";
    assertLabel(spec.path, method, spec.template);
    try {
      const opts: RequestOptions = {};
      if (spec.query) opts.query = spec.query;
      let payload = await rf<unknown>(method, spec.path, opts);
      if (spec.trim !== undefined && Array.isArray(payload)) payload = payload.slice(0, spec.trim);
      const rec: Recorded = {
        template: spec.template,
        method,
        recordedAt: new Date().toISOString(),
        path: spec.path,
        payload: scrub(payload, spec.scrubContent ?? false),
      };
      recorded.push(rec);
      files.push(writeFixture(outDir, rec));
    } catch (err) {
      if (err instanceof DevToApiError && [401, 403, 404].includes(err.status)) {
        skipped.push(`${method} ${spec.template} (${err.status})`);
      } else {
        throw err;
      }
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { recorded, skipped, files };
}

/**
 * The reversible write cycle: draft create → update → unpublish, plus a
 * reaction toggle pair on an existing article. Every write is reversed in
 * the same run: the draft ends unpublished, the reaction ends removed.
 */
export async function recordWriteCycle(
  rf: Rf,
  reactableArticleId: number,
  outDir: string,
): Promise<Recorded[]> {
  const out: Recorded[] = [];
  // capture each write as it succeeds: assert the label, keep it, persist it (KTD4)
  const emit = (template: string, method: string, path: string, payload: unknown): void => {
    assertLabel(path, method, template);
    const rec: Recorded = { template, method, recordedAt: new Date().toISOString(), path, payload };
    out.push(rec);
    writeFixture(outDir, rec);
  };

  const draft = await rf<{ id: number }>("POST", "/api/articles", {
    body: {
      article: {
        // unique per run: dev.to rejects duplicate titles within five minutes
        title: `devto-client fixture draft ${Date.now()}`,
        body_markdown: "Synthetic fixture content. Safe to delete.",
        published: false,
      },
    },
  });
  emit("/api/articles", "POST", "/api/articles", scrub(draft, true));
  console.log(`created draft article ${draft.id}: v1 has no delete endpoint, remove it manually`);

  const updated = await rf<unknown>("PUT", `/api/articles/${draft.id}`, {
    body: { article: { body_markdown: "Synthetic fixture content, updated. Safe to delete." } },
  });
  emit("/api/articles/{id}", "PUT", `/api/articles/${draft.id}`, scrub(updated, true));

  // moderator-gated on dev.to (regular keys get 401); the draft was never
  // published, so skipping it leaves no residue either way
  try {
    await rf<undefined>("PUT", `/api/articles/${draft.id}/unpublish`);
    emit("/api/articles/{id}/unpublish", "PUT", `/api/articles/${draft.id}/unpublish`, null);
  } catch (err) {
    if (!(err instanceof DevToApiError && [401, 403].includes(err.status))) throw err;
    console.warn(`skipped: PUT /api/articles/{id}/unpublish (${err.status}, privilege-gated)`);
  }

  // the reactions API is admin-gated upstream (ReactionPolicy#api?); regular
  // keys get 401: skip, leaving reactions in the type-derived tier
  try {
    const toggleOn = await rf<unknown>("POST", "/api/reactions/toggle", {
      query: { category: "like", reactable_id: reactableArticleId, reactable_type: "Article" },
    });
    emit("/api/reactions/toggle", "POST", "/api/reactions/toggle", scrub(toggleOn));
    // reverse: toggle back off: never rethrow (toggle isn't idempotent, and the
    // like is live on someone else's article), but tell the operator loudly
    try {
      await rf<unknown>("POST", "/api/reactions/toggle", {
        query: { category: "like", reactable_id: reactableArticleId, reactable_type: "Article" },
      });
    } catch (err) {
      console.warn(
        `REVERSAL FAILED: like on article ${reactableArticleId} is still applied. Toggle it off manually (${String(err)})`,
      );
    }
  } catch (err) {
    if (!(err instanceof DevToApiError && [401, 403].includes(err.status))) throw err;
    console.warn(`skipped: POST /api/reactions/toggle (${err.status}, admin-gated)`);
  }

  return out;
}

const fixtureFileName = (rec: Recorded): string => {
  const slug = rec.template.replaceAll(/[/{}]+/g, "-").replaceAll(/^-|-$/g, "");
  return `${rec.method.toLowerCase()}_${slug}.json`;
};

export function writeFixture(dir: string, rec: Recorded): string {
  mkdirSync(dir, { recursive: true });
  const file = fixtureFileName(rec);
  writeFileSync(`${dir}/${file}`, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}

const DEFAULT_BASE_URL = "https://dev.to";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * KTD8: resolve the recording target from the environment. Defaults reproduce
 * today's behavior exactly (dev.to, DEVTO_API_KEY, 3s pacing). A non-default
 * base URL demands FOREM_API_KEY explicitly (the production dev.to key is
 * never silently sent to another host) and only loopback http is allowed.
 */
export function resolveTarget(env: NodeJS.ProcessEnv): {
  apiKey: string | undefined;
  baseUrl: string;
  allowInsecureHttp: boolean;
  pauseMs: number;
} {
  const baseUrl = env.FOREM_BASE_URL ?? DEFAULT_BASE_URL;
  let apiKey: string | undefined;
  if (baseUrl === DEFAULT_BASE_URL) {
    apiKey = env.FOREM_API_KEY ?? env.DEVTO_API_KEY;
  } else {
    if (!env.FOREM_API_KEY) {
      throw new Error(
        `FOREM_BASE_URL is set to ${baseUrl}; set FOREM_API_KEY explicitly: DEVTO_API_KEY is never sent to a non-default host`,
      );
    }
    apiKey = env.FOREM_API_KEY;
  }
  const parsed = new URL(baseUrl);
  const allowInsecureHttp = parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname);
  const pauseMs = env.FIXTURE_PAUSE_MS !== undefined ? Number(env.FIXTURE_PAUSE_MS) : 3000;
  return { apiKey, baseUrl, allowInsecureHttp, pauseMs };
}

/** Parse `--only <selector>` (repeatable) and an optional positional out dir. */
export function parseArgs(argv: string[]): { only: string[]; outDir: string } {
  const { values, positionals } = parseNodeArgs({
    args: argv,
    options: { only: { type: "string", multiple: true } },
    allowPositionals: true,
  });
  return { only: values.only ?? [], outDir: positionals.at(-1) ?? "tests/fixtures/recorded" };
}

/**
 * With a key present, a run that recorded zero user-scope fixtures means the key
 * silently 401'd (dev.to's misleading 401s): fail loudly so the reality-check
 * can't pass on stale user fixtures instead of re-verifying the user tier.
 */
export function assertUserTierRecorded(recorded: Recorded[], selectedUser: ReadSpec[]): void {
  if (selectedUser.length === 0) return;
  const got = new Set(recorded.map((r) => r.template));
  if (!selectedUser.some((s) => got.has(s.template))) {
    throw new Error(
      "a key was provided but every user-scope read was skipped (dev.to misleading 401s?): user fixtures were NOT refreshed; failing so reality-check does not pass on stale fixtures",
    );
  }
}

/** Filter read specs to the selected templates; a selector matching nothing is fatal (KTD3). */
export function selectReads(all: ReadSpec[], selectors: string[]): ReadSpec[] {
  const selected = all.filter((s) => selectors.includes(s.template));
  const matched = new Set(selected.map((s) => s.template));
  const unmatched = selectors.filter((t) => !matched.has(t));
  if (unmatched.length > 0) {
    throw new Error(`--only matched no recordable endpoint: ${unmatched.join(", ")}`);
  }
  return selected;
}

/**
 * The recording client's transport settings, out here rather than inside the main
 * guard so a test can read them. Pacing and throttle patience are the library's
 * now. This script no longer hand-rolls either.
 */
export function buildRecorderConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const target = resolveTarget(env);
  const options: ClientOptions = {
    baseUrl: target.baseUrl,
    // dev.to's 429s often arrive without Retry-After, so the flat throttle wait is
    // what a run rides out. `attempts` no longer bounds how long that can take.
    // timeoutMs does, so it has to be generous enough for the whole schedule.
    retry: { attempts: 5, throttleDelayMs: 5000 },
    timeoutMs: 120_000,
    // a third of what Rack::Attack allows. The origin would permit 3 reads/s; the
    // edge in front of dev.to boxes an IP that sustains anything near it, and a
    // recording run is exactly the sustained crawl that provokes that.
    pace: createPacer({ readsPerSecond: 1 }),
  };
  if (target.apiKey !== undefined) options.apiKey = target.apiKey;
  if (target.allowInsecureHttp) options.allowInsecureHttp = true;
  return resolveConfig(options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { only, outDir } = parseArgs(process.argv.slice(2));
  // resolveTarget again for `pauseMs`, which the transport config has no home for
  const target = resolveTarget(process.env);
  const apiKey = target.apiKey;
  const config = buildRecorderConfig(process.env);
  const rf: Rf = (method, path, opts) => request(config, method, path, opts);

  const runAll = only.length === 0;
  const wantWriteCycle = only.includes("write-cycle");
  const readSelectors = only.filter((s) => s !== "write-cycle");

  // discover concrete ids from the public articles list
  const articles = await rf<
    {
      id: number;
      user: { username: string; user_id: number };
      path: string;
      organization?: { username: string };
    }[]
  >("GET", "/api/articles", { query: { per_page: 10 } });
  // prefer a user-owned article so path-derived {username} is a user, not an org
  const first = articles.find((a) => !a.organization) ?? articles[0];
  if (!first) throw new Error("no articles returned: cannot derive sample ids");
  const [username = "", slug = ""] = first.path.replace(/^\//, "").split("/");
  // a numeric org username would make deriveTemplate pick {id} over {username} and
  // crash assertLabel: prefer a non-numeric one, else skip the org reads this run
  const org = articles.find((a) => a.organization && !/^\d+$/.test(a.organization.username))
    ?.organization?.username;

  const publicReads: ReadSpec[] = [
    { template: "/api/articles", path: "/api/articles" },
    { template: "/api/articles/latest", path: "/api/articles/latest" },
    { template: "/api/articles/search", path: "/api/articles/search", query: { q: "javascript" } },
    { template: "/api/articles/{id}", path: `/api/articles/${first.id}` },
    { template: "/api/articles/{username}/{slug}", path: `/api/articles/${username}/${slug}` },
    { template: "/api/comments", path: "/api/comments", query: { a_id: first.id } },
    { template: "/api/tags", path: "/api/tags" },
    { template: "/api/pages", path: "/api/pages", trim: 3 },
    { template: "/api/podcast_episodes", path: "/api/podcast_episodes" },
    { template: "/api/videos", path: "/api/videos" },
    { template: "/api/users/{id}", path: `/api/users/${first.user.user_id}` },
    ...(org
      ? [
          { template: "/api/organizations/{username}", path: `/api/organizations/${org}` },
          {
            template: "/api/organizations/{organization_id_or_username}/articles",
            path: `/api/organizations/${org}/articles`,
          },
          {
            template: "/api/organizations/{organization_id_or_username}/users",
            path: `/api/organizations/${org}/users`,
          },
        ]
      : []),
    { template: "/api/instance", path: "/api/instance" },
    { template: "/api/subforems", path: "/api/subforems" },
    { template: "/api/trends", path: "/api/trends" },
    { template: "/api/surveys", path: "/api/surveys" },
    { template: "/api/badges", path: "/api/badges" },
    { template: "/api/badge_achievements", path: "/api/badge_achievements" },
    { template: "/api/concepts", path: "/api/concepts" },
    { template: "/api/agent_sessions", path: "/api/agent_sessions" },
  ];

  const userReads: ReadSpec[] = apiKey
    ? [
        { template: "/api/users/me", path: "/api/users/me" },
        { template: "/api/articles/me", path: "/api/articles/me", scrubContent: true },
        {
          template: "/api/articles/me/published",
          path: "/api/articles/me/published",
          scrubContent: true,
        },
        {
          template: "/api/articles/me/unpublished",
          path: "/api/articles/me/unpublished",
          scrubContent: true,
        },
        { template: "/api/articles/me/all", path: "/api/articles/me/all", scrubContent: true },
        { template: "/api/readinglist", path: "/api/readinglist" },
        { template: "/api/followers/users", path: "/api/followers/users" },
        { template: "/api/follows/tags", path: "/api/follows/tags" },
      ]
    : [];

  const allReads = [...publicReads, ...userReads];
  const selectedReads = runAll ? allReads : selectReads(allReads, readSelectors);
  // recordReads persists each fixture as it lands (KTD4): no separate batch write
  const reads = await recordReads(rf, selectedReads, outDir, target.pauseMs);
  if (apiKey !== undefined) {
    const userTemplates = new Set(userReads.map((u) => u.template));
    assertUserTierRecorded(
      reads.recorded,
      selectedReads.filter((s) => userTemplates.has(s.template)),
    );
  }

  const doWriteCycle = runAll ? apiKey !== undefined : wantWriteCycle;
  if (wantWriteCycle && apiKey === undefined) {
    throw new Error("--only write-cycle needs an API key (FOREM_API_KEY or DEVTO_API_KEY)");
  }
  const writes = doWriteCycle ? await recordWriteCycle(rf, first.id, outDir) : [];
  const files = [...reads.files, ...writes.map(fixtureFileName)];

  // KTD13: do public endpoints answer cross-origin? Probe with an Origin header.
  // Only on a full run: a targeted re-record must not clobber the CORS snapshot.
  if (runAll) {
    const corsRes = await config.fetch(`${config.baseUrl}/api/articles?per_page=1`, {
      headers: { origin: "https://example.com", accept: "application/vnd.forem.api-v1+json" },
    });
    const cors = {
      probedAt: new Date().toISOString(),
      endpoint: "/api/articles",
      accessControlAllowOrigin: corsRes.headers.get("access-control-allow-origin"),
    };
    writeFileSync(`${outDir}/../cors.json`, `${JSON.stringify(cors, null, 2)}\n`);
    console.log(`CORS allow-origin on public GET: ${cors.accessControlAllowOrigin ?? "(absent)"}`);
  }

  console.log(`recorded ${files.length} fixtures to ${outDir}`);
  for (const s of reads.skipped) console.log(`skipped: ${s}`);
}
