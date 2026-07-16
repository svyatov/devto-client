/**
 * Records real dev.to responses into tests/fixtures/recorded/ — R17's raw material.
 *
 * Keyless: public read endpoints. With DEVTO_API_KEY (dedicated low-privilege
 * account only): user-scope reads plus the reversible write cycle — draft
 * create (published: false) → update → unpublish, and a reaction toggle pair.
 * POST /api/follows is NOT recorded: v1 has no unfollow endpoint, so the write
 * cannot be reversed in the same run (KTD9); its fixture stays type-derived.
 *
 * Run: DEVTO_API_KEY=... node --experimental-strip-types scripts/record-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DevToApiError } from "../src/errors.ts";
import { type RequestOptions, request, resolveConfig } from "../src/http.ts";

export type Rf = <T>(method: string, path: string, opts?: RequestOptions) => Promise<T>;

export interface ReadSpec {
  /** Spec path template, e.g. "/api/articles/{id}" — U7 keys response types on this. */
  template: string;
  /** Concrete path to call. */
  path: string;
  method?: string;
  query?: Record<string, string | number>;
  /** Replace title/body/description content in the payload (draft listings). */
  scrubContent?: boolean;
}

export interface Recorded {
  template: string;
  method: string;
  recordedAt: string;
  payload: unknown;
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

/** Records each read; 401/403/404 means the key can't access it — skip, not fail. */
export async function recordReads(
  rf: Rf,
  specs: ReadSpec[],
  pauseMs = 1000, // Rack::Attack allows 3 GET/s per key; keyless throttling is stricter
): Promise<{ recorded: Recorded[]; skipped: string[] }> {
  const recorded: Recorded[] = [];
  const skipped: string[] = [];
  for (const spec of specs) {
    const method = spec.method ?? "GET";
    try {
      const opts: RequestOptions = {};
      if (spec.query) opts.query = spec.query;
      const payload = await rf<unknown>(method, spec.path, opts);
      recorded.push({
        template: spec.template,
        method,
        recordedAt: new Date().toISOString(),
        payload: scrub(payload, spec.scrubContent ?? false),
      });
    } catch (err) {
      if (err instanceof DevToApiError && [401, 403, 404].includes(err.status)) {
        skipped.push(`${method} ${spec.template} (${err.status})`);
      } else {
        throw err;
      }
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { recorded, skipped };
}

/**
 * The reversible write cycle: draft create → update → unpublish, plus a
 * reaction toggle pair on an existing article. Every write is reversed in
 * the same run — the draft ends unpublished, the reaction ends removed.
 */
export async function recordWriteCycle(rf: Rf, reactableArticleId: number): Promise<Recorded[]> {
  const stamp = (): string => new Date().toISOString();
  const out: Recorded[] = [];

  const draft = await rf<{ id: number }>("POST", "/api/articles", {
    body: {
      article: {
        title: "devto-client fixture draft",
        body_markdown: "Synthetic fixture content. Safe to delete.",
        published: false,
      },
    },
  });
  out.push({
    template: "/api/articles",
    method: "POST",
    recordedAt: stamp(),
    payload: scrub(draft, true),
  });

  const updated = await rf<unknown>("PUT", `/api/articles/${draft.id}`, {
    body: { article: { body_markdown: "Synthetic fixture content, updated. Safe to delete." } },
  });
  out.push({
    template: "/api/articles/{id}",
    method: "PUT",
    recordedAt: stamp(),
    payload: scrub(updated, true),
  });

  await rf<undefined>("PUT", `/api/articles/${draft.id}/unpublish`);
  out.push({
    template: "/api/articles/{id}/unpublish",
    method: "PUT",
    recordedAt: stamp(),
    payload: null,
  });

  const toggleOn = await rf<unknown>("POST", "/api/reactions/toggle", {
    query: { category: "like", reactable_id: reactableArticleId, reactable_type: "Article" },
  });
  out.push({
    template: "/api/reactions/toggle",
    method: "POST",
    recordedAt: stamp(),
    payload: scrub(toggleOn),
  });

  // reverse: toggle back off
  await rf<unknown>("POST", "/api/reactions/toggle", {
    query: { category: "like", reactable_id: reactableArticleId, reactable_type: "Article" },
  });

  return out;
}

const fixtureFileName = (rec: Recorded): string => {
  const slug = rec.template.replaceAll(/[/{}]+/g, "-").replaceAll(/^-|-$/g, "");
  return `${rec.method.toLowerCase()}_${slug}.json`;
};

export function writeFixtures(dir: string, recorded: Recorded[]): string[] {
  mkdirSync(dir, { recursive: true });
  return recorded.map((rec) => {
    const file = fixtureFileName(rec);
    writeFileSync(`${dir}/${file}`, `${JSON.stringify(rec, null, 2)}\n`);
    return file;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const apiKey = process.env.DEVTO_API_KEY;
  // dev.to's 429s often arrive without Retry-After; ride out the throttle window
  const retry = { attempts: 5, baseDelayMs: 5000, maxDelayMs: 60_000 };
  const config = resolveConfig(apiKey ? { apiKey, retry } : { retry });
  const rf: Rf = (method, path, opts) => request(config, method, path, opts);
  const outDir = process.argv[2] ?? "tests/fixtures/recorded";

  // discover concrete ids from the public articles list
  const articles = await rf<
    { id: number; user: { username: string }; path: string; organization?: { username: string } }[]
  >("GET", "/api/articles", { query: { per_page: 10 } });
  // prefer a user-owned article so path-derived {username} is a user, not an org
  const first = articles.find((a) => !a.organization) ?? articles[0];
  if (!first) throw new Error("no articles returned — cannot derive sample ids");
  const [username = "", slug = ""] = first.path.replace(/^\//, "").split("/");
  const org = articles.find((a) => a.organization)?.organization?.username;

  const publicReads: ReadSpec[] = [
    { template: "/api/articles", path: "/api/articles" },
    { template: "/api/articles/latest", path: "/api/articles/latest" },
    { template: "/api/articles/search", path: "/api/articles/search", query: { q: "javascript" } },
    { template: "/api/articles/{id}", path: `/api/articles/${first.id}` },
    { template: "/api/articles/{username}/{slug}", path: `/api/articles/${username}/${slug}` },
    { template: "/api/comments", path: "/api/comments", query: { a_id: first.id } },
    { template: "/api/tags", path: "/api/tags" },
    { template: "/api/pages", path: "/api/pages" },
    { template: "/api/podcast_episodes", path: "/api/podcast_episodes" },
    { template: "/api/videos", path: "/api/videos" },
    { template: "/api/users/{id}", path: "/api/users/by_username", query: { url: username } },
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

  const reads = await recordReads(rf, [...publicReads, ...userReads]);
  const writes = apiKey ? await recordWriteCycle(rf, first.id) : [];
  const files = writeFixtures(outDir, [...reads.recorded, ...writes]);

  // KTD13: do public endpoints answer cross-origin? Probe with an Origin header.
  const corsRes = await config.fetch(`${config.baseUrl}/api/articles?per_page=1`, {
    headers: { origin: "https://example.com", accept: "application/vnd.forem.api-v1+json" },
  });
  const cors = {
    probedAt: new Date().toISOString(),
    endpoint: "/api/articles",
    accessControlAllowOrigin: corsRes.headers.get("access-control-allow-origin"),
  };
  writeFileSync(`${outDir}/../cors.json`, `${JSON.stringify(cors, null, 2)}\n`);

  console.log(`recorded ${files.length} fixtures to ${outDir}`);
  for (const s of reads.skipped) console.log(`skipped: ${s}`);
  console.log(`CORS allow-origin on public GET: ${cors.accessControlAllowOrigin ?? "(absent)"}`);
}
