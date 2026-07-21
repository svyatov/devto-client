/**
 * Guards the changelog against a silent release-please failure.
 *
 * `@conventional-commits/parser` reads a body line beginning `word(` as the
 * start of a scope, the shape release-please uses to split a squash merge back
 * into its parts. A second `(` before the closing `)` is a syntax error there,
 * so the parser throws, release-please catches it, logs at debug level, and
 * drops the *whole commit* from the changelog. Every job stays green and the
 * entry is simply absent.
 *
 * There is no version to upgrade to: 0.4.1 is npm `latest` and shipped in
 * January 2021, release-please pins `^0.4.1`, and the bug is open upstream as
 * conventional-commits/parser#54 and googleapis/release-please#2564.
 *
 * Commit 5c7bd8f lost its entry from two separate release PRs this way: its
 * body carried the code sample `/\/+$/.exec("a" + "/".repeat(50_000) + "x")`,
 * whose `.repeat(` is a second paren inside what the parser took for a scope.
 * Markdown fences are no protection, since the parser does not read markdown.
 *
 * Anything at all before the opening paren saves the line, so the fix is always
 * to indent the offending line by one space.
 *
 * Run: bun scripts/check-commit-message.ts < message.txt
 */
import { pathToFileURL } from "node:url";

export interface BadLine {
  /** 1-based, counting the subject as line 1. */
  line: number;
  text: string;
}

/**
 * Body lines that would make release-please drop this commit. The subject is
 * exempt: it is parsed as the header, where a nested paren is legal.
 */
export function unparseableLines(message: string): BadLine[] {
  const bad: BadLine[] = [];
  message
    .split("\n")
    .slice(1)
    .forEach((text, i) => {
      // lazy, so the opener is the line's FIRST paren; greedy would skip to the
      // last one and read `foo(bar(1))` as an innocent `foo(bar(` plus `1))`
      const opener = /^\S*?\(/.exec(text);
      if (!opener) return;
      const rest = text.slice(opener[0].length);
      const close = rest.indexOf(")");
      const nested = rest.indexOf("(");
      // unterminated, or a second paren before the first close
      if (close === -1 || (nested !== -1 && nested < close)) bad.push({ line: i + 2, text });
    });
  return bad;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const bad = unparseableLines(await Bun.stdin.text());
  if (bad.length > 0) {
    console.error("release-please would drop this commit from the changelog.\n");
    console.error("These lines start with `word(` and nest another paren inside:\n");
    for (const { line, text } of bad) console.error(`  line ${line}: ${text}`);
    console.error("\nIndent each one by a space. Anything before the paren is enough.");
    process.exit(1);
  }
}
