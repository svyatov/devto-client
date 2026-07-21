# Changelog

## [2.0.0](https://github.com/svyatov/devto-client/compare/v1.0.1...v2.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* ArticleSummary now requires comments_count. Reading an ArticleSummary is unaffected. Constructing one, as a test mock or an adapter does, now needs the field. It is typed required to match Article, MyArticle and ReadingListArticle, which already require it, and every recorded dev.to fixture carries it.
* `maxDelayMs` is removed from RetryOptions. It gated an oversized Retry-After and clamped the jittered exponential; the deadline replaces the first outright and, together with the budget clamp, the second. Set `timeoutMs` instead.

### Features

* bound, pace, and instrument the transport layer ([#14](https://github.com/svyatov/devto-client/issues/14)) ([152efca](https://github.com/svyatov/devto-client/commit/152efcad327f44c004c12ea0dabdacd3ee564beb))
* sweep the write half and record the tier each operation needs ([#19](https://github.com/svyatov/devto-client/issues/19)) ([1fa4799](https://github.com/svyatov/devto-client/commit/1fa479961ccead751bb4885d5475cafc5f1e49b4))
* verify the spec against a running Forem and correct 24 entries ([#18](https://github.com/svyatov/devto-client/issues/18)) ([c20d7ef](https://github.com/svyatov/devto-client/commit/c20d7efdef1a821c7e3a4738a3d4a5bcec59fa37))


### Bug Fixes

* **tests:** stop the reality check false-alarming on conditional article keys ([#10](https://github.com/svyatov/devto-client/issues/10)) ([45b4f4c](https://github.com/svyatov/devto-client/commit/45b4f4c09f41f2d3997f0c5e94bc4ba5079bc9fe))

## [1.0.1](https://github.com/svyatov/devto-client/compare/v1.0.0...v1.0.1) (2026-07-21)


### Documentation

* **contributing:** explain how releases publish ([7e9b095](https://github.com/svyatov/devto-client/commit/7e9b0951f1b55f71bd7ffb2144ae3501baee808f))

## 1.0.0 (2026-07-21)


### ⚠ BREAKING CHANGES

* **api:** every operation's call signature changed. `client.request` remains the raw escape hatch for the `{ query, body, signal }` shape.

### Features

* **api:** replace Args envelope with the ergonomic Call rule ([588abce](https://github.com/svyatov/devto-client/commit/588abce5910ea7b987a13cabadb6c4ed08967069))
* async-iterator pagination with empty-page-only termination ([58bb150](https://github.com/svyatov/devto-client/commit/58bb15091917057c0a55a4c120d83cfecb6375ad))
* core HTTP client — versioned Accept, api-key auth, typed errors, bounded retry ([e1ce7b5](https://github.com/svyatov/devto-client/commit/e1ce7b51602f2a0bb146775ba6f57756acbc31c7))
* **fixtures:** on-demand re-record pipeline with chain-of-custody ([92d5206](https://github.com/svyatov/devto-client/commit/92d5206551b41a3c6b5ddd58e3869d6d6f65590e))
* full v1 surface — 30 namespaces, 130 operations, surface-inventory gate ([9decfb4](https://github.com/svyatov/devto-client/commit/9decfb46b4e530b708442b3a66a9b3395c7f8e5f))
* migrate tooling to Bun and add a request-headers option ([#6](https://github.com/svyatov/devto-client/issues/6)) ([0cbc477](https://github.com/svyatov/devto-client/commit/0cbc477085fe4f0f38891f1836d01f35964232d3))
* reality validation — key-completeness vs composed spec, vacuous detection ([2db74ff](https://github.com/svyatov/devto-client/commit/2db74ff829a6aafc50f2d3cf08099b0808703973))
* recorded fixtures (public + user tier) and reality validation ([fbc822a](https://github.com/svyatov/devto-client/commit/fbc822a7360fcd685d2984e572c532f1969367c8))
* scaffold ESM-only TypeScript package with TS7, Vitest 4, Biome ([f3fdd4c](https://github.com/svyatov/devto-client/commit/f3fdd4c11357e519a5572da40c0783ab014032d8))
* spec pipeline — pinned upstream snapshot, overlay compose, generated types ([7572cf6](https://github.com/svyatov/devto-client/commit/7572cf622cfbcb441e5ecdf3e4f0a517ce01a529))
* **types:** surface friendly, importable result and param types ([dc170d9](https://github.com/svyatov/devto-client/commit/dc170d92b5b1b35329a8fb9eef46d8a47b65a0d0))


### Bug Fixes

* apply code-review fixes across release gate, HTTP core, and CI plumbing ([92401b9](https://github.com/svyatov/devto-client/commit/92401b91b4e1238f840c75333e265291c308f7e7))
* compose spec in-memory in tests instead of reading the gitignored artifact ([086b109](https://github.com/svyatov/devto-client/commit/086b109d87f831610719f0b18a11c22598fb7532))
* import order, JSON module resolution, slower keyless recording pace ([f67f5d4](https://github.com/svyatov/devto-client/commit/f67f5d4de2d20dd602ce77d3e56aff5d76eb6e92))
* no exports from test files (biome noExportsInTest) ([d99078d](https://github.com/svyatov/devto-client/commit/d99078d709374729456299b41a1782844f062fbe))
* resolve remaining review findings — required query params, keyed reality-check, truthful users fixture ([40cdaf2](https://github.com/svyatov/devto-client/commit/40cdaf25093ab192fb9df1758e161fd41f811832))


### Miscellaneous Chores

* pin the first release ([582db7a](https://github.com/svyatov/devto-client/commit/582db7a9643d88ff575690413bfacf18378211c4))
* release 1.0.0 ([3adcc29](https://github.com/svyatov/devto-client/commit/3adcc29d519764d925c6ad71f98b9a388b6fc3b5))
