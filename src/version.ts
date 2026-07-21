/**
 * The published package version, sent in the default `user-agent`.
 *
 * release-please rewrites the literal below on every release via the
 * `extra-files` entry in `release-please-config.json`: the annotation comment
 * is what marks the line, so keep it on the same line as the string.
 * `tests/http.test.ts` pins this against `package.json` so drift fails CI
 * rather than shipping a lying user-agent.
 */
export const VERSION = "1.0.1"; // x-release-please-version
