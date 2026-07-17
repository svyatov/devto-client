# Changelog

## 0.1.0 (2026-07-17)


### Features

* async-iterator pagination with empty-page-only termination ([58bb150](https://github.com/svyatov/devto-client/commit/58bb15091917057c0a55a4c120d83cfecb6375ad))
* core HTTP client — versioned Accept, api-key auth, typed errors, bounded retry ([e1ce7b5](https://github.com/svyatov/devto-client/commit/e1ce7b51602f2a0bb146775ba6f57756acbc31c7))
* full v1 surface — 30 namespaces, 130 operations, surface-inventory gate ([9decfb4](https://github.com/svyatov/devto-client/commit/9decfb46b4e530b708442b3a66a9b3395c7f8e5f))
* reality validation — key-completeness vs composed spec, vacuous detection ([2db74ff](https://github.com/svyatov/devto-client/commit/2db74ff829a6aafc50f2d3cf08099b0808703973))
* recorded fixtures (public + user tier) and reality validation ([fbc822a](https://github.com/svyatov/devto-client/commit/fbc822a7360fcd685d2984e572c532f1969367c8))
* scaffold ESM-only TypeScript package with TS7, Vitest 4, Biome ([f3fdd4c](https://github.com/svyatov/devto-client/commit/f3fdd4c11357e519a5572da40c0783ab014032d8))
* spec pipeline — pinned upstream snapshot, overlay compose, generated types ([7572cf6](https://github.com/svyatov/devto-client/commit/7572cf622cfbcb441e5ecdf3e4f0a517ce01a529))


### Bug Fixes

* apply code-review fixes across release gate, HTTP core, and CI plumbing ([92401b9](https://github.com/svyatov/devto-client/commit/92401b91b4e1238f840c75333e265291c308f7e7))
* compose spec in-memory in tests instead of reading the gitignored artifact ([086b109](https://github.com/svyatov/devto-client/commit/086b109d87f831610719f0b18a11c22598fb7532))
* import order, JSON module resolution, slower keyless recording pace ([f67f5d4](https://github.com/svyatov/devto-client/commit/f67f5d4de2d20dd602ce77d3e56aff5d76eb6e92))
* no exports from test files (biome noExportsInTest) ([d99078d](https://github.com/svyatov/devto-client/commit/d99078d709374729456299b41a1782844f062fbe))
* resolve remaining review findings — required query params, keyed reality-check, truthful users fixture ([40cdaf2](https://github.com/svyatov/devto-client/commit/40cdaf25093ab192fb9df1758e161fd41f811832))


### Miscellaneous Chores

* pin the first release ([582db7a](https://github.com/svyatov/devto-client/commit/582db7a9643d88ff575690413bfacf18378211c4))
