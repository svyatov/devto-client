# Contributing

Thanks for looking under the hood. This client is a thin, typed mirror of the dev.to (Forem) v1 API, and most contributions come down to one thing: teaching it about an endpoint it doesn't cover yet. This guide walks you from a fresh clone to a green PR doing exactly that.

## Setup

You'll need Node 22.12 or newer. Clone the repo and install with a clean, lockfile-exact install:

```sh
npm ci
```

That's the whole setup. There's no build step to run before working, no local services to start, and the test suite never touches the network. It runs against committed fixtures and a fake fetch, so it works on a plane.

## The two gates

Everything a PR has to pass lives in two commands.

```sh
npm run check   # Biome (format + lint + import-organizing) then tsc
npm test        # Vitest with a 100% coverage threshold
```

`npm run check` is the fast one: it formats, lints, and type-checks. Run it before you commit and it'll fix formatting in place. `npm test` runs the suite with coverage, and the threshold is 100% (excluding the generated types file). That number isn't aspirational; a line you add without a test covering it fails CI. Both commands run on Node 22 and 24 in the matrix, so match them locally if something passes for you but not in CI.

## Adding an endpoint

Say Forem ships a new route and you want it on the client. The work happens in two places, in this order: the spec first, then the resource table.

The client's types come from a composed OpenAPI spec, not from hand-written interfaces. So an operation has to exist in that spec before you can wire it up. There are two ways to get it there. If the operation is already in Forem's published spec, refresh the pinned snapshot at `spec/api_v1.json` from upstream. If it's missing or wrong there (Forem's spec under-documents plenty), add an entry to `spec/overlay.json` describing the correction. Each overlay entry carries a `target` (a JSON pointer), an `expect` (what you assert is currently there, so a silent upstream change trips the composer), a `reason`, and a `patch`. Copy the shape of a neighbor.

Then regenerate:

```sh
npm run generate
```

That composes the spec and rewrites the generated files: `src/generated/types.ts` (the response and parameter types), plus `src/generated/signatures.ts` and `src/generated/routing.ts` (the ergonomic call signatures with true parameter names, and their query-vs-body routing). Now the operation exists in the type world, and you can add it to its resource's operation table. That's a one-line `{ path, verb }` entry in the right `src/resources/*.ts` file:

```ts
export const tagsTable = {
  list: { path: "/api/tags", verb: "get", paginated: true },
  get: { path: "/api/tags/{id}", verb: "get" }, // your new line
} as const;
```

Add `paginated: true` if it's a `page`/`per_page` list endpoint (a `list` entry then also gets a `listAll` iterator for free; the twin is always your key name plus `All`), and `undocumented: true` if the route is real but absent from Forem's docs. The path and verb are checked against the composed spec at the type level, so a typo won't compile.

If the endpoint has a single-key wrapper body — the server wants `{ "article": { ... } }` and callers pass the inner fields flat — add `bodyKey: "article"`. The type checker requires it for wrapper bodies and forbids it for flat ones, so a wrong, stale, or missing key won't compile. Then run `npm run generate` once more so the new op's named signature and routing land in `src/generated/`.

If the endpoint needs more than an ordinary key, flag that in the JSDoc rather than trusting yourself to remember. The namespace type is a generated re-export now, so its documentation home is the matching property comment in `src/client.ts` — carry a short note there ("Requires admin credentials.", "Requires moderator credentials."), and a surprising gate belongs in the README deviations table too. The one that bites is the endpoint that looks like a plain user action but isn't: reactions are admin-gated upstream, so an ordinary key gets a 401 nothing in the types warns you about.

One last step: `tests/surface-inventory.test.ts` asserts a hard operation count, the "100% of the surface" gate. Bump both numbers in the count assertion (they're the upstream total plus the code-only extras). That test enforces three-way parity between the spec, the tables, and that count, so it fails loudly if you added a table entry without a matching spec operation, or vice versa. Green there means you're done.

## Never edit the generated types

`src/generated/types.ts` is output. `npm run generate` recreates it from the composed spec, and any hand edit you make is gone the next time anyone runs it. If a type is wrong, the fix belongs in `spec/overlay.json`, not in the generated file.

## Comments

The code follows a policy worth keeping: JSDoc on the public API surface (the client class, its namespaces, the exported option types), why-comments where behavior would surprise a reader, and nothing on code that already reads clearly. The operation tables stay bare. They're data, and a comment restating `{ path, verb }` is noise. When in doubt, explain why something is the way it is, never what a line plainly does.

## Recording fixtures

You almost certainly won't need to, but if you're recording live API responses to back a test, record them authenticated. Keyless requests hit a per-IP throttle far stricter than the documented limits, and tripping it earns a silent 30-minute penalty window where everything just fails. Record through that and your fixtures are garbage. Use a dedicated, low-privilege account, never your main one.

Write-endpoint fixtures have to close a reversible cycle: create then delete, follow then unfollow, whatever undoes itself, so re-recording leaves no litter on the account. If a recording can't clean up after itself, it doesn't belong in the suite.
