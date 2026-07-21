# devto-client

[![npm version](https://img.shields.io/npm/v/devto-client?style=flat-square)](https://www.npmjs.com/package/devto-client)
[![CI](https://img.shields.io/github/actions/workflow/status/svyatov/devto-client/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/svyatov/devto-client/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/codecov/c/github/svyatov/devto-client?style=flat-square)](https://codecov.io/gh/svyatov/devto-client)
[![minzipped size](https://img.shields.io/bundlephobia/minzip/devto-client?style=flat-square)](https://bundlephobia.com/package/devto-client)
[![license](https://img.shields.io/npm/l/devto-client?style=flat-square)](./LICENSE)

An unofficial, zero-dependency TypeScript client for the [dev.to (Forem) v1 API](https://developers.forem.com/api/v1). Every endpoint typed, every correctness trap handled by default.

The raw API punishes hand-rollers. Forget the versioned Accept header and your requests silently downgrade to the deprecated v0 API, which returns different shapes. Miss the undocumented rate limits and you get plain-text 429s your JSON parser chokes on. This client bakes the fixes in so you can't reach for the wrong thing.

## Install

```sh
npm install devto-client
```

Node 22.12 or newer, ESM only. CommonJS projects on Node 22.12+ can load it with `require()` thanks to `require(esm)`.

## Quickstart

```ts
import { DevToClient } from "devto-client";

const devto = new DevToClient(); // public endpoints need no key

const articles = await devto.articles.list({ tag: "typescript", per_page: 3 });
for (const article of articles) {
  console.log(article.title, article.url); // fully typed, autocomplete included
}
```

That's a real request against dev.to. The response type comes from Forem's own OpenAPI spec, so `article.` in your editor lists exactly what the server sends.

Every method follows one call shape: required path ids come first as positional arguments (`articles.get(123)`, `articles.getByPath("ben", "my-slug")`), then everything else (query params or body fields) goes in a single flat object, then an optional `{ signal }` for aborting. You never say whether a value travels as a path, query, or body slot; that's the client's job. The parameter names in your editor are the real ones, generated from the spec, so `getByPath` autocompletes as `(username, slug)`, not `(arg0, arg1)`.

## What's covered

Each property on the client is a resource namespace, and the tier column tells you what credentials it needs before you write the code:

| Namespace | Covers | Tier |
| --- | --- | --- |
| `devto.articles` | Read, search, publish, and manage your own drafts via the `me` operations | public / api-key |
| `devto.comments` | Comment threads on articles and podcast episodes | public |
| `devto.users` | User profiles, plus moderation actions | public / moderator |
| `devto.organizations` | Organizations, their members, and their articles | public |
| `devto.followers` | The users following you | api-key |
| `devto.follows` | Create a follow and list the tags you follow | api-key |
| `devto.tags` | The instance's tags | public |
| `devto.readinglist` | Your saved-articles reading list | api-key |
| `devto.podcastEpisodes` | Published podcast episodes | public |
| `devto.videos` | Articles published with a video | public |
| `devto.profileImages` | A user's profile-image URLs, looked up by username | public |
| `devto.reactions` | Create or toggle reactions | admin |
| `devto.instance` | Metadata for the connected Forem instance | public |
| `devto.subforems` | Sub-communities on the instance | public |
| `devto.healthChecks` | App, cache, and database liveness probes | public |
| `devto.trends` | Trends and their articles | public |
| `devto.surveys` | Surveys and their poll results | api-key |
| `devto.concepts` | Concepts and their articles | public |
| `devto.agentSessions` | Agent sessions, plus the undocumented presign and raw-url helpers | api-key |
| `devto.badges` | Badge definitions; mutations need admin | public / admin |
| `devto.badgeAchievements` | Badges awarded to users; awarding needs admin | public / admin |
| `devto.billboards` | Billboards (display ads) | admin |
| `devto.pages` | Static instance pages; mutations need admin | public / admin |
| `devto.segments` | Audience segments and their membership | admin |
| `devto.recommendedArticlesLists` | Recommended-articles lists | api-key |
| `devto.analytics` | Analytics for your own content | api-key |
| `devto.feedbackMessages` | Update the status of an abuse/feedback report | moderator |
| `devto.admin.users` | User administration | admin |
| `devto.admin.concepts` | Concept administration | admin |
| `devto.admin.requestRedirects` | Request redirects | admin |

`reactions` looks like a regular user endpoint and isn't: Forem gates it on admin upstream, so an ordinary key gets a 401. The same goes for `articles.unpublish`, which wants a moderator. Anything missing from this table is still reachable through [the escape hatch](#the-escape-hatch) at the bottom.

## Authentication

Grab an API key from dev.to under Settings → Extensions → DEV Community API Keys, and pass it once:

```ts
const devto = new DevToClient({ apiKey: process.env.DEVTO_API_KEY });

const draft = await devto.articles.create({
  title: "Hello from devto-client",
  body_markdown: "Drafted via the API.",
  published: false,
});
console.log(`draft #${draft.id} created`);
```

You pass the article fields flat. On the wire dev.to wants them wrapped in `{ "article": { ... } }`, and the client adds that wrapper for you, one less bit of transport trivia to remember. The key travels in the `api-key` header on every request. The client refuses `http://` base URLs so it can't leak in cleartext (see self-hosted instances below for the escape hatch).

## Pagination

The API paginates with `page` and `per_page` and sends no pagination metadata, so knowing when to stop is your problem. Worse, servers may cap `per_page` below what you asked for, which makes a short page indistinguishable from the last page. The iterator variants handle this for you by walking pages until an empty one:

```ts
for await (const article of devto.articles.listAll({ tag: "devops" })) {
  console.log(article.title);
}
```

Every paginated list gets an `All` twin: `articles.list` / `articles.listAll`, `tags.list` / `tags.listAll`, and so on. The plain methods stay available when you want a single page.

## Errors

Every non-2xx response throws a single error class carrying the HTTP status and whatever the server sent:

```ts
import { DevToApiError } from "devto-client";

try {
  await devto.articles.get(999999999);
} catch (err) {
  if (err instanceof DevToApiError) {
    console.log(err.status); // 404
    console.log(err.body); // { error: "not found", status: 404 } when the server sends JSON
    console.log(err.rawBody); // raw text otherwise (Rack::Attack's 429 is plain text)
  }
}
```

You might expect every error body to be JSON. It isn't: rate-limit 429s arrive as plain text, and some hand-rolled 400s omit the `status` field. `DevToApiError` covers all three shapes.

Three more fields tell you where the response came from:

```ts
console.log(err.requestId); // upstream x-request-id, the handle to quote in a bug report
console.log(err.fromCache); // true when a CDN answered instead of the origin
console.log(err.age); // how many seconds the cached copy had been sitting there
```

A `fromCache` 429 is the nasty one. dev.to's CDN doesn't vary on your credential, so a stored 429 generated for someone else can be replayed at you, and every retry reads the same stored bytes. The client stops retrying that one. It can't be won, and each attempt spends rate budget getting nowhere.

Cache status matters just as much on calls that succeed, which is somewhere an error object can't reach. Pass an `onResponse` observer and you'll see it on every response:

```ts
const devto = new DevToClient({
  onResponse: ({ status, fromCache, age, requestId }) => {
    if (fromCache) console.warn(`${status} served from cache, ${age}s old (${requestId})`);
  },
});
```

The observer fires before the body is read, on successes and failures alike, and it can't affect the call. Throw from it and the request carries on regardless.

## Retries

Rate-limited (429) requests retry automatically for all methods, honoring `Retry-After`, because a 429 means the server never processed the request. Transient 5xx responses retry only for idempotent methods; retrying a failed `POST /articles` could double-publish. Three attempts by default.

The two failure modes get different patience, because they're different problems. A 5xx is a server having a bad time and you don't know for how long, so it backs off exponentially with jitter from `baseDelayMs`. A 429 without a usable `Retry-After` is a fixed one-second counter that has already tripped, and an exponential schedule has nothing to grow into, so it waits a flat `throttleDelayMs` instead.

```ts
const devto = new DevToClient({
  apiKey: process.env.DEVTO_API_KEY,
  timeoutMs: 60_000, // whole-call deadline, 30s by default
  retry: { attempts: 5, baseDelayMs: 500, throttleDelayMs: 5_000 }, // or retry: false
});
```

`timeoutMs` is the one number that answers "how long can this block?". It covers everything: every attempt, every backoff wait, every pacing hold, and the response body read. When it runs out you get a `DevToTimeoutError`, which is a separate class from `DevToApiError` because nothing came back from the server to describe.

```ts
import { DevToTimeoutError } from "devto-client";

try {
  await devto.articles.get(123);
} catch (err) {
  if (err instanceof DevToTimeoutError) console.log(err.declinedWaitMs);
}
```

That `declinedWaitMs` shows up when the client refused a wait rather than sat through one. If the server asks for 45 seconds and you have 80 left, you get the full 45 and a retry. If you have 10 left, the call fails right there and tells you what it turned down, because sleeping a shortened version of the server's answer accomplishes nothing. Waits the client picks itself are treated differently: those get trimmed to whatever budget remains rather than refused, so raising `attempts` keeps producing attempts you can actually reach.

Worth knowing if you're upgrading: a call used to be able to hang forever. No timeout existed, so a socket that never answered blocked you indefinitely while the retry loop sat waiting for a response that would never arrive. Those calls reject now. That's the fix, but it does mean a new failure path in code that never had one.

A deadline bounds one HTTP request, not one iteration. Each page of an `All` iterator carries its own, so a long `listAll` walk over a big tag never dies on a whole-walk timer. To bound the walk itself, pass your own signal:

```ts
const controller = new AbortController();
const promise = devto.articles.get(123, { signal: controller.signal });
controller.abort(); // rejects promptly, even if the client was waiting out a 429
```

An abort surfaces your own reason, so `instanceof DevToTimeoutError` tells a deadline apart from a cancellation you initiated. Signal lives in that trailing options argument, not the params object, so aborting never collides with a real query or body field. For a method whose params are optional, pass `undefined` first: `devto.articles.list(undefined, { signal })`. `timeoutMs` lives there too, if one call needs a different budget than the client's default.

If you point `baseUrl` at a Forem instance you don't control, `timeoutMs` is what bounds your patience. There's no separate ceiling on a server-supplied `Retry-After` anymore, so a hostile instance can ask you to sleep for an hour and the deadline is the only thing that says no. Set it to something you're willing to wait.

It bounds time, not bytes. Responses are buffered whole before parsing, so an instance that answers fast with a gigabyte still costs you a gigabyte of memory. Treat the deadline as one control among several rather than the whole boundary, and don't point the client at a host you wouldn't trust with a plain `fetch`.

## Self-hosted Forem instances

The base URL defaults to `https://dev.to` and is configurable:

```ts
const forem = new DevToClient({ baseUrl: "https://community.example.com", apiKey: "..." });
```

Plain `http://` throws at construction unless you opt in with `allowInsecureHttp: true`, which exists for local development against a Forem instance on localhost.

## Custom headers

Every request already carries a versioned Accept header, a `user-agent` of `devto-client/<version>`, and, when you're authenticated, your api-key. Beyond those you can attach your own defaults. Replacing the `user-agent` so your app is the thing dev.to's logs name is the usual reason:

```ts
const devto = new DevToClient({
  apiKey: process.env.DEVTO_API_KEY,
  headers: { "user-agent": "my-app/1.0 (+https://my-app.example)" },
});
```

Client-level headers merge into every request, and a per-request header of the same name wins, so you can override a default for a single call:

```ts
await devto.request("GET", "/api/articles/latest", {
  headers: { "user-agent": "my-app/1.0 batch-job" },
});
```

Your `user-agent` replaces the library's rather than appending to it, which is the opposite of how the other two behave. The versioned Accept header always wins, because dropping it silently falls back to the deprecated v0 API. So does the `api-key`, which belongs in the `apiKey` option rather than here; a key smuggled through `headers` skips the guard that refuses redirects so it can't leak off dev.to.

Browsers are the exception. They ignore a `user-agent` set from JavaScript and send their own, so this option only takes effect off the browser.

## Browser usage

Public endpoints (articles, comments, tags, and friends) send `Access-Control-Allow-Origin: *`, so keyless reads work from a browser. Authenticated endpoints deliberately don't: Forem disables CORS on them because the API key is intended for non-browser scripts. Keep keys on a server.

## Rate limits

These are server configuration, not documented API contract, so treat them as guidance that can change without notice. As of mid-2026, Forem allows roughly 3 GET requests per second and 1 write per second, counted per IP address *and* per API key at the same figures, returning 429 with a `Retry-After` header (which proxies sometimes strip). Admin keys are exempt.

Those are the origin's numbers. The CDN in front of dev.to enforces its own, stricter for sustained traffic: a long keyless crawl can start collecting 429s below 3 reads per second, and those arrive as plain "Retry later" text with no `Retry-After` at all. If you're walking a lot of pages rather than making occasional calls, pace well under the ceiling. One read per second is a reasonable starting point.

The client paces itself against those budgets by default, so you don't have to. Reads and writes draw on separate token buckets sized to the per-second allowance, which means a script that stays inside the budget never waits at all. Three GETs in a row cost you nothing. The fourth waits about a third of a second, and every page of an `All` iterator draws on the same budget without you doing anything.

```ts
import { createPacer, DevToClient } from "devto-client";

const pace = createPacer({ readsPerSecond: 1 }); // slower than the ceiling, for a long crawl
const devto = new DevToClient({ apiKey: process.env.DEVTO_API_KEY, pace });
const archive = new DevToClient({ pace }); // same pacer, one shared budget
```

Each client holds its own budget unless you hand two of them the same pacer. Worth knowing: dev.to throttles per IP as well as per key, so two clients on one machine already share a server-side budget whether or not they share a pacer. Independent pacers under-protect you rather than merely over-pacing.

Turn it off with `pace: false`. The main reason to is an admin key, which is exempt upstream. The client can't detect one, and the only reliable probe would be `/api/users/me`, the endpoint that intermittently 401s on a perfectly good key. So pacing stays on for everyone and admins opt out by hand.

One boundary to be aware of if you fire many calls concurrently. Every deadline clock starts when its call is created, so more than roughly `timeoutMs × rate` requests in flight at once (about 90 reads at the defaults) means the tail of the burst exhausts its deadline waiting for a slot and fails with `DevToTimeoutError`. That's deliberate: a request that can't start inside its own budget should say so rather than queue invisibly.

The token bucket also isn't quite the same shape as the server's counter. Forem uses a fixed one-second window; a bucket guarantees at most `capacity + rate` requests in any one-second span, so a burst straddling a window boundary can still draw a 429. The retry path absorbs those. Lower the rate if you'd rather not see them at all.

## Types you can import

Hover `devto.articles.get(1)` and your editor shows `Promise<Article>` instead of a path-indexed blob you have to decode. Every result backed by a real schema has a friendly name, and every one of those names is importable:

```ts
import type { Article, ArticleSummary, User } from "devto-client";

function render(article: Article) {
  /* … */
}
```

These are plain 1:1 aliases over the spec schemas. `Article` is exactly the `ArticleShow` schema; `ArticleSummary` is the lighter `ArticleIndex` that the list endpoints return. There's no merged god-type here, and no hand-written shape that can drift from the server. When the spec changes the alias changes with it, so a mismatch is a build error rather than a silent lie.

Method params get names too. `articles.search` takes `ArticleSearchParams`, `articles.create` takes `ArticleCreateParams`, and they hover as a flat field list instead of an `Omit<…> & {…}` intersection you'd have to squint at. You won't usually import these by hand, since you pass the fields as a plain object and let inference do the naming. When you do want the type itself, to annotate a wrapper function for instance, reach for it through the `DevTo` namespace below (`DevTo.ArticleSearchParams`), which is where the param names live.

A few schema names collide with browser globals. `Comment` is a DOM node, `RequestRedirect` is a fetch mode, and flat-importing either would shadow the real one. Those live only under the `DevTo` namespace, which is the collision-free home for every alias:

```ts
import type { DevTo } from "devto-client";

function reply(comment: DevTo.Comment) {
  /* … */
}
```

`DevTo.*` reaches every friendly name, colliding or not, so lean on it whenever a bare import would be ambiguous.

## How the types are made

Types generate from Forem's own rswag spec (`swagger/v1/api_v1.json`, pinned in [`spec/api_v1.json`](spec/api_v1.json)) composed with [`spec/overlay.json`](spec/overlay.json), a list of corrections where the upstream spec is missing schemas or disagrees with what the server actually sends. Each overlay entry records why it exists, which makes the spec-vs-reality gap machine-readable and each entry a candidate PR to Forem. A daily CI job diffs the pinned snapshot against upstream (structurally, so it names which path templates and operations changed) and flags any recorded fixture that has aged past its freshness window, filing an issue with the exact re-record command for each affected fixture. From there you re-record live responses from dev.to on demand, one endpoint at a time, instead of on a weekly schedule that dev.to's per-IP throttling made flaky; a manual reality-check run still type-checks fresh recordings against the spec, catching the server drifting under an unchanged spec.

## Deviations from the upstream spec

The call surface is ergonomic, but the core stays faithful to the server: response types mirror what dev.to actually sends, not what the docs claim, and every deviation is explicit. The full machine-readable list is [`spec/overlay.json`](spec/overlay.json); the highlights:

| Kind | What | Why |
| --- | --- | --- |
| Included, undocumented | `agentSessions.presign` (`POST /api/agent_sessions/presign`) | Exists in Forem's routes, absent from the spec. Marked `undocumented` in its [operation table](src/resources/agent-sessions.ts). |
| Included, undocumented | `agentSessions.rawUrl` (`GET /api/agent_sessions/{id}/raw_url`) | Same. |
| Excluded | listings endpoints | Dead upstream stubs returning empty responses. |
| Excluded | `/api/display_ads` | Transitional alias of `/api/billboards`. |
| Excluded | `suspended` user-role alias | Alias of `suspend`. |
| Excluded | `GET /api/followers/organizations` | The route exists but the controller action doesn't. Calling it 404s. |
| Privilege-gated | `POST /api/reactions`, `POST /api/reactions/toggle` | Admin-gated upstream despite looking like regular user endpoints; ordinary keys get 401. |
| Privilege-gated | `PUT /api/articles/{id}/unpublish` | Moderator-gated; ordinary keys get 401. |
| Quirk | `GET /api/users/me` | Has been observed intermittently returning 401 on dev.to with a valid key that authenticates elsewhere. |
| Corrected | duplicate `page` param on `GET /api/comments` | The spec declares it twice; the overlay removes the inline copy. |
| Corrected | 11 responses declared as `{"type": "object", "items": {"$ref": ...}}` | `items` is array-only, so on an object the `$ref` never resolves and the response types out as unknown. Affects the `show` operations for articles, users, organizations, segments, profile images and trends, plus the two billboards writes. Eight are confirmed against a running Forem or a recorded fixture; the trends read and the two billboards writes rest on the structural defect alone, and say so in their overlay entry. |
| Corrected | `comments_count` on `ArticleSummary` | The articles serializer emits it, the upstream schema omits it. Typed required, matching `Article`, `MyArticle` and `ReadingListArticle`, which already require it. Note this narrows the type for anyone constructing an `ArticleSummary` (a test mock, say) rather than just reading one. |
| Corrected | `POST /api/reactions` responses | The controller returns 201 for newly created reactions; the spec only declares 200. |
| Added schemas | 50 or so response schemas | The upstream spec declares many 2xx responses with no schema at all, including `POST /api/articles`. The overlay fills them from the verified controller/view sources, each entry citing where. |
| Typed `unknown` | all `/api/analytics/*` responses, `PATCH /api/feedback_messages/{id}` | Shapes are produced by service objects, undocumented, and not verifiable without a qualifying account. Honest `unknown` beats a guessed interface. |

Fixture-backed tests verify recorded reality for the public and user-scope tiers. Admin, moderation, and analytics responses can't be recorded with a low-privilege account, so their types derive from the composed spec and carry the unverified caveat above.

## The documented verb, nothing else

Rails accepts PUT and PATCH interchangeably on update routes. The client exposes only the verb the spec documents for each endpoint (`articles.update` is PUT, `concepts.update` is PATCH). The ergonomic surface reshapes how you _call_ an endpoint; it never invents endpoints or verbs the spec doesn't have.

## The escape hatch

When you need an endpoint the typed surface doesn't cover, or want to send a request exactly your way, drop to the raw transport:

```ts
const controller = new AbortController();
const raw = await devto.request<unknown>("GET", "/api/articles/latest", {
  query: { page: 1 },
  signal: controller.signal,
});
```

`client.request(method, path, opts)` still layers on the versioned header, auth, retries, and error handling: it only hands you back control over the path and payload. It's the one place the `{ query, body, signal }` options object survives, precisely because a raw call has no spec to derive its shape from.

## Contributing

Most contributions come down to teaching the client an endpoint it doesn't cover yet, and [CONTRIBUTING.md](CONTRIBUTING.md) walks you from a fresh clone through that first PR: setup, the two quality gates, and the add-an-endpoint loop. The [Code of Conduct](CODE_OF_CONDUCT.md) applies to everyone taking part.

Version history lives in [CHANGELOG.md](CHANGELOG.md). Security problems have their own private reporting route in [SECURITY.md](SECURITY.md); please use that instead of a public issue.

## License

[MIT](LICENSE)
