import { describe, expect, it } from "bun:test";
import { unparseableLines } from "../scripts/check-commit-message.ts";

/**
 * Every case below was checked against the real parser first, by feeding the
 * message to `parseConventionalCommits` from release-please 17.10.3 (what
 * `release-please-action@v5` wraps) and seeing whether the commit survived.
 * "drops" means release-please returned zero commits for it. If this guard ever
 * disagrees with a real release PR, re-run that probe rather than trusting the
 * regex here.
 */
const body = (text: string): string => `fix: subject line\n\n${text}`;

describe("unparseableLines", () => {
  it.each([
    ["a line-initial call with a nested paren", "foo(bar(1))"],
    ["the real 5c7bd8f sample", '/\\/+$/.exec("a" + "/".repeat(50_000) + "x")'],
    ["the same sample inside a fence, which the parser cannot see", "```js\nfoo(bar(1))\n```"],
    ["an inline code span", "`foo(bar(1))`"],
    ["a backtick before the call", "`x`.foo(bar(1))"],
    ["an unterminated paren", "foo(1"],
  ])("flags %s", (_label, text) => {
    expect(unparseableLines(body(text))).not.toEqual([]);
  });

  it.each([
    ["prose with no parens", "just some prose"],
    ["a single, balanced call", "foo(1)"],
    ["a quoted argument", 'foo("a")'],
    ["an underscore-separated number", "foo(50_000)"],
    ["anything at all before the paren", "call foo(bar(1))"],
    ["one leading space, the fix we recommend", " foo(bar(1))"],
    ["an indented sample", '    /\\/+$/.exec("a" + "/".repeat(50_000) + "x")'],
    ["a space between word and paren", "a (b (c))"],
    ["two sequential calls", "foo(1) bar(2)"],
  ])("leaves %s alone", (_label, text) => {
    expect(unparseableLines(body(text))).toEqual([]);
  });

  it("exempts the subject, which is parsed as the header", () => {
    expect(unparseableLines("fix: call foo(bar(1))")).toEqual([]);
  });

  it("numbers lines from the subject so the message matches an editor", () => {
    expect(unparseableLines("fix: x\n\nfine\nfoo(bar(1))")).toEqual([
      { line: 4, text: "foo(bar(1))" },
    ]);
  });
});
