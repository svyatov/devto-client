---
name: Bug report
about: Something the client does that it shouldn't (or doesn't do that it should)
title: ""
labels: bug
---

**What happened, and what you expected instead**

**Reproduction**: the smallest snippet that shows it. Redact your API key.

```ts

```

**Environment**

- `devto-client` version:
- Runtime and version (Node 22.12, Bun 1.3, …):
- Endpoint involved (`GET /api/articles/{id}`, or the client call):
- Was the request authenticated (API key set)?

Those last two matter more than they look. dev.to throttles keyless requests far harder than its documented limits, and some endpoints answer a valid key with a 401 that has nothing to do with the key, so an unauthenticated repro can look like a client bug when it isn't.

**Anything else**: full error output, response body, whether it reproduces every time.
