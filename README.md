# devto-client

[![npm](https://img.shields.io/npm/v/devto-client)](https://www.npmjs.com/package/devto-client)
[![CI](https://github.com/svyatov/devto-client/actions/workflows/ci.yml/badge.svg)](https://github.com/svyatov/devto-client/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/svyatov/devto-client/blob/main/vitest.config.ts)
[![types](https://img.shields.io/badge/types-included-blue)](https://www.npmjs.com/package/devto-client)
[![node](https://img.shields.io/node/v/devto-client)](https://nodejs.org)

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

const articles = await devto.articles.list({ query: { tag: "typescript", per_page: 3 } });
for (const article of articles) {
  console.log(article.title, article.url); // fully typed, autocomplete included
}
```

That's a real request against dev.to. The response type comes from Forem's own OpenAPI spec, so `article.` in your editor lists exactly what the server sends.

## Authentication

Grab an API key from dev.to under Settings → Extensions → DEV Community API Keys, and pass it once:

```ts
const devto = new DevToClient({ apiKey: process.env.DEVTO_API_KEY });

const draft = await devto.articles.create({
  body: {
    article: {
      title: "Hello from devto-client",
      body_markdown: "Drafted via the API.",
      published: false,
    },
  },
});
console.log(`draft #${draft.id} created`);
```

The key travels in the `api-key` header on every request. The client refuses `http://` base URLs so it can't leak in cleartext (see self-hosted instances below for the escape hatch).

## Pagination

The API paginates with `page` and `per_page` and sends no pagination metadata, so knowing when to stop is your problem. Worse, servers may cap `per_page` below what you asked for, which makes a short page indistinguishable from the last page. The iterator variants handle this for you by walking pages until an empty one:

```ts
for await (const article of devto.articles.listAll({ query: { tag: "devops" } })) {
  console.log(article.title);
}
```

Every paginated list gets an `All` twin: `articles.list` / `articles.listAll`, `tags.list` / `tags.listAll`, and so on. The plain methods stay available when you want a single page.

## Errors

Every non-2xx response throws a single error class carrying the HTTP status and whatever the server sent:

```ts
import { DevToApiError } from "devto-client";

try {
  await devto.articles.get({ path: { id: 999999999 } });
} catch (err) {
  if (err instanceof DevToApiError) {
    console.log(err.status); // 404
    console.log(err.body); // { error: "not found", status: 404 } when the server sends JSON
    console.log(err.rawBody); // raw text otherwise (Rack::Attack's 429 is plain text)
  }
}
```

You might expect every error body to be JSON. It isn't: rate-limit 429s arrive as plain text, and some hand-rolled 400s omit the `status` field. `DevToApiError` covers all three shapes.

## Retries

Rate-limited (429) requests retry automatically for all methods, honoring `Retry-After`, because a 429 means the server never processed the request. Transient 5xx responses retry only for idempotent methods; retrying a failed `POST /articles` could double-publish. Backoff is exponential with jitter, three attempts total by default.

```ts
const devto = new DevToClient({
  apiKey: process.env.DEVTO_API_KEY,
  retry: { attempts: 5, maxDelayMs: 10_000 }, // or retry: false to disable
});
```

A `Retry-After` above `maxDelayMs` throws immediately instead of parking your process; an arbitrary self-hosted instance could otherwise tell you to sleep for an hour. Every request also accepts an `AbortSignal` that cancels mid-backoff, not just mid-request:

```ts
const controller = new AbortController();
const promise = devto.articles.list({ signal: controller.signal });
controller.abort(); // rejects promptly, even if the client was waiting out a 429
```

## Self-hosted Forem instances

The base URL defaults to `https://dev.to` and is configurable:

```ts
const forem = new DevToClient({ baseUrl: "https://community.example.com", apiKey: "..." });
```

Plain `http://` throws at construction unless you opt in with `allowInsecureHttp: true`, which exists for local development against a Forem instance on localhost.

## Browser usage

Public endpoints (articles, comments, tags, and friends) send `Access-Control-Allow-Origin: *`, so keyless reads work from a browser. Authenticated endpoints deliberately don't: Forem disables CORS on them because the API key is intended for non-browser scripts. Keep keys on a server.

## Rate limits

These are server configuration, not documented API contract, so treat them as guidance that can change without notice. As of mid-2026, dev.to allows roughly 3 GET requests per second and 1 write per second per API key, returning 429 with a `Retry-After` header (which proxies sometimes strip). Admin keys are exempt. The default retry policy absorbs occasional 429s; a sustained crawl needs pacing on your side.

## How the types are made

Types generate from Forem's own rswag spec (`swagger/v1/api_v1.json`, pinned in [`spec/api_v1.json`](spec/api_v1.json)) composed with [`spec/overlay.json`](spec/overlay.json), a list of corrections where the upstream spec is missing schemas or disagrees with what the server actually sends. Each overlay entry records why it exists, which makes the spec-vs-reality gap machine-readable and each entry a candidate PR to Forem. A daily CI job diffs the pinned snapshot against upstream — structurally, so it names which path templates and operations changed — and flags any recorded fixture that has aged past its freshness window, filing an issue with the exact re-record command for each affected fixture. From there you re-record live responses from dev.to on demand, one endpoint at a time, instead of on a weekly schedule that dev.to's per-IP throttling made flaky; a manual reality-check run still type-checks fresh recordings against the spec, catching the server drifting under an unchanged spec.

## Deviations from the upstream spec

The client mirrors the server, not the docs, and every deviation is explicit. The full machine-readable list is [`spec/overlay.json`](spec/overlay.json); the highlights:

| Kind | What | Why |
| --- | --- | --- |
| Included, undocumented | `agentSessions.presign` (`POST /api/agent_sessions/presign`) | Exists in Forem's routes, absent from the spec. Marked `undocumented` in its operation table. |
| Included, undocumented | `agentSessions.rawUrl` (`GET /api/agent_sessions/{id}/raw_url`) | Same. |
| Excluded | listings endpoints | Dead upstream stubs returning empty responses. |
| Excluded | `/api/display_ads` | Transitional alias of `/api/billboards`. |
| Excluded | `suspended` user-role alias | Alias of `suspend`. |
| Excluded | `GET /api/followers/organizations` | The route exists but the controller action doesn't. Calling it 404s. |
| Privilege-gated | `POST /api/reactions`, `POST /api/reactions/toggle` | Admin-gated upstream despite looking like regular user endpoints; ordinary keys get 401. |
| Privilege-gated | `PUT /api/articles/{id}/unpublish` | Moderator-gated; ordinary keys get 401. |
| Quirk | `GET /api/users/me` | Has been observed intermittently returning 401 on dev.to with a valid key that authenticates elsewhere. |
| Corrected | duplicate `page` param on `GET /api/comments` | The spec declares it twice; the overlay removes the inline copy. |
| Corrected | `POST /api/reactions` responses | The controller returns 201 for newly created reactions; the spec only declares 200. |
| Added schemas | 50 or so response schemas | The upstream spec declares many 2xx responses with no schema at all, including `POST /api/articles`. The overlay fills them from the verified controller/view sources, each entry citing where. |
| Typed `unknown` | all `/api/analytics/*` responses, `PATCH /api/feedback_messages/{id}` | Shapes are produced by service objects, undocumented, and not verifiable without a qualifying account. Honest `unknown` beats a guessed interface. |

Fixture-backed tests verify recorded reality for the public and user-scope tiers. Admin, moderation, and analytics responses can't be recorded with a low-privilege account, so their types derive from the composed spec and carry the unverified caveat above.

## The documented verb, nothing else

Rails accepts PUT and PATCH interchangeably on update routes. The client exposes only the verb the spec documents for each endpoint (`articles.update` is PUT, `concepts.update` is PATCH), staying a strict mirror.

## Contributing

Most contributions come down to teaching the client an endpoint it doesn't cover yet, and [CONTRIBUTING.md](CONTRIBUTING.md) walks you from a fresh clone through that first PR: setup, the two quality gates, and the add-an-endpoint loop.

## License

[MIT](LICENSE)
