# Contributing

Thanks for looking under the hood. This client is a thin, typed mirror of the dev.to (Forem) v1 API, and most contributions come down to one thing: teaching it about an endpoint it doesn't cover yet. This guide walks you from a fresh clone to a green PR doing exactly that.

Before you start, one thing worth knowing: taking part here means agreeing to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You'll need [Bun](https://bun.sh): the toolchain runs on Bun, so you don't need a separate Node install to work on the client. Clone the repo and install with a clean, lockfile-exact install:

```sh
bun install --frozen-lockfile
```

That's the whole setup. There's no build step to run before working, no local services to start, and the test suite never touches the network. It runs against committed fixtures and a fake fetch, so it works on a plane.

## The two gates

Everything a PR has to pass lives in two commands.

```sh
bun run check   # Biome (format + lint + import-organizing) then tsc
bun test        # Bun's test runner
```

`bun run check` is the fast one: it formats, lints, and type-checks. Run it before you commit and it'll fix formatting in place. `bun test` runs the suite. Coverage is tracked on [Codecov](https://codecov.io/gh/svyatov/devto-client), and CI's patch-coverage check fails a PR that adds code without a test covering it, so bring a test for anything you touch. CI runs the suite under Bun and also imports the built ESM under the minimum supported Node, so match those locally if something passes for you but not in CI.

## Adding an endpoint

Say Forem ships a new route and you want it on the client. The work happens in two places, in this order: the spec first, then the resource table.

The client's types come from a composed OpenAPI spec, not from hand-written interfaces. So an operation has to exist in that spec before you can wire it up. There are two ways to get it there. If the operation is already in Forem's published spec, refresh the pinned snapshot at `spec/api_v1.json` from upstream. If it's missing or wrong there (Forem's spec under-documents plenty), add an entry to `spec/overlay.json` describing the correction. Each overlay entry carries a `target` (a JSON pointer), an `expect` (what you assert is currently there, so a silent upstream change trips the composer), a `reason`, and a `patch`. Copy the shape of a neighbor.

Then regenerate:

```sh
bun run generate
```

That composes the spec and rewrites the generated files: `src/generated/types.ts` (the response and parameter types), plus `src/generated/signatures.ts` and `src/generated/routing.ts` (the ergonomic call signatures with true parameter names, and their query-vs-body routing). Now the operation exists in the type world, and you can add it to its resource's operation table. That's a one-line `{ path, verb }` entry in the right `src/resources/*.ts` file:

```ts
export const tagsTable = {
  list: { path: "/api/tags", verb: "get", paginated: true },
  get: { path: "/api/tags/{id}", verb: "get" }, // your new line
} as const;
```

Add `paginated: true` if it's a `page`/`per_page` list endpoint (a `list` entry then also gets a `listAll` iterator for free; the twin is always your key name plus `All`), and `undocumented: true` if the route is real but absent from Forem's docs. The path and verb are checked against the composed spec at the type level, so a typo won't compile.

If the endpoint has a single-key wrapper body (the server wants `{ "article": { ... } }` and callers pass the inner fields flat), add `bodyKey: "article"`. The type checker requires it for wrapper bodies and forbids it for flat ones, so a wrong, stale, or missing key won't compile. Then run `bun run generate` once more so the new op's named signature and routing land in `src/generated/`.

If the endpoint needs more than an ordinary key, flag that in the JSDoc rather than trusting yourself to remember. The namespace type is a generated re-export now, so its documentation home is the matching property comment in `src/client.ts`: carry a short note there ("Requires admin credentials.", "Requires moderator credentials."), and a surprising gate belongs in the README deviations table too. The one that bites is the endpoint that looks like a plain user action but isn't: reactions are admin-gated upstream, so an ordinary key gets a 401 nothing in the types warns you about.

One last step: `tests/surface-inventory.test.ts` asserts a hard operation count, the "100% of the surface" gate. Bump both numbers in the count assertion (they're the upstream total plus the code-only extras). That test enforces three-way parity between the spec, the tables, and that count, so it fails loudly if you added a table entry without a matching spec operation, or vice versa. Green there means you're done.

## How a release happens

You don't have to do anything for a release, but it's worth knowing what your commit messages set in motion. release-please reads them off `main` and keeps a release PR open, adding your change to the pending changelog under `feat` or `fix`. Merging that PR is the whole release: it tags the version, cuts the GitHub release, and publishes to npm in the same workflow run.

One trap is worth knowing about, because it fails silently. Your PR title and body become the squash commit message, and release-please parses that message with [`@conventional-commits/parser`](https://github.com/conventional-commits/parser). A body line that starts with `word(` and nests a second paren inside it, which is to say most one-line code samples, is a syntax error to that parser. It throws, release-please catches it, and your commit vanishes from the changelog with every CI job still green. Commit 5c7bd8f lost its entry from two separate release PRs this way. Indenting the line by a single space is enough to fix it, and CI checks for the pattern so you'll hear about it before you merge.

Don't go looking for a version to upgrade to. That parser last shipped in January 2021, release-please pins it at `^0.4.1`, and the bug is open upstream as [conventional-commits/parser#54](https://github.com/conventional-commits/parser/issues/54) and [release-please#2564](https://github.com/googleapis/release-please/issues/2564). The check in CI is the fix available to us.

There is no npm token in this repository, and there never will be. The publish authenticates through OIDC trusted publishing, so npm verifies the workflow itself rather than a stored credential, and every published version carries a provenance attestation you can check on its npm page. That's also why the tests and the build run in a separate job from the publish: the job holding the publish identity installs no project dependencies and builds nothing, so nothing your `bun install` pulls in ever runs next to it.

## Never edit the generated types

`src/generated/types.ts` is output. `bun run generate` recreates it from the composed spec, and any hand edit you make is gone the next time anyone runs it. If a type is wrong, the fix belongs in `spec/overlay.json`, not in the generated file.

## Comments

The code follows a policy worth keeping: JSDoc on the public API surface (the client class, its namespaces, the exported option types), why-comments where behavior would surprise a reader, and nothing on code that already reads clearly. The operation tables stay bare. They're data, and a comment restating `{ path, verb }` is noise. When in doubt, explain why something is the way it is, never what a line plainly does.

## Recording fixtures

You almost certainly won't need to, but if you're recording live API responses to back a test, record them authenticated. Keyless requests hit a per-IP throttle far stricter than the documented limits, and tripping it earns a silent 30-minute penalty window where everything just fails. Record through that and your fixtures are garbage. Use a dedicated, low-privilege account, never your main one.

Write-endpoint fixtures have to close a reversible cycle: create then delete, follow then unfollow, whatever undoes itself, so re-recording leaves no litter on the account. If a recording can't clean up after itself, it doesn't belong in the suite.
