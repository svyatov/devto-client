import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaNames } from "../scripts/schema-names.ts";

/**
 * The clean-hover promise, guarded against silent regression (R5/KTD6). We emit
 * real declarations with `tsc --emitDeclarationOnly` and assert on the .d.ts the
 * editor actually reads: mapped ops show friendly `Promise<Friendly>` returns and
 * named param types, never the computed `CallResult<…>` / `CallQuery<…>`. The
 * assertion is scoped to mapped (schema-backed) ops — the ~31 inline/malformed
 * fallback ops legitimately keep `CallResult<pv>` (KTD3), so a global "no
 * CallResult anywhere" check would false-positive.
 */
let out: string;
let index = "";
let signatures = "";
let schemas = "";
let http = "";

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "devto-dts-"));
  execFileSync(
    "node_modules/.bin/tsc",
    ["-p", "tsconfig.build.json", "--emitDeclarationOnly", "--outDir", out],
    { stdio: "pipe" },
  );
  index = readFileSync(join(out, "index.d.ts"), "utf8");
  signatures = readFileSync(join(out, "generated", "signatures.d.ts"), "utf8");
  schemas = readFileSync(join(out, "generated", "schemas.d.ts"), "utf8");
  http = readFileSync(join(out, "http.d.ts"), "utf8");
}, 120_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

/** Friendly names that shadow a lib.dom global, so they stay off the flat surface (KTD5). */
const DENYLIST = new Set(["Comment", "RequestRedirect"]);

/** The single flat `export type { … } from "./generated/schemas.ts"` line in index.d.ts. */
const flatReExport = (): string => {
  const line = index
    .split("\n")
    .find((l) => l.startsWith("export type {") && l.includes('from "./generated/schemas.ts"'));
  if (!line) throw new Error("no flat schemas re-export in index.d.ts");
  return line;
};

/** The emitted line for a member inside ArticlesNamespace. */
const articleLine = (member: string): string => {
  const block = signatures.match(/export interface ArticlesNamespace \{([\s\S]*?)\n\}/)?.[1] ?? "";
  const line = block.split("\n").find((l) => new RegExp(`\\b${member}: \\(`).test(l));
  if (!line) throw new Error(`no emitted member ${member} in ArticlesNamespace`);
  return line;
};

describe("dts-surface guard (R5)", () => {
  it("emits the friendly result signature (R1)", () => {
    expect(signatures).toContain("get: (id: number, opts?: CallOptions) => Promise<Article>;");
    expect(articleLine("list")).toContain("=> Promise<ArticleSummary[]>;");
  });

  it("emits a named, importable param type (R2)", () => {
    expect(schemas).toContain("export type ArticleSearchParams =");
    expect(articleLine("search")).toContain("params?: ArticleSearchParams");
  });

  it("shows no CallResult / CallQuery for the mapped article ops (regression guard)", () => {
    // Reverting any of these signatures to CallResult<pv> would put `CallResult<`
    // back on its line and fail here — that is the guard biting.
    const mapped = ["get", "getByPath", "list", "latest", "search", "create", "update", "me"];
    for (const op of mapped) {
      const line = articleLine(op);
      expect(line, op).not.toMatch(/CallResult</);
      expect(line, op).not.toMatch(/CallQuery</);
    }
  });

  it("leaves fallback ops out of the guard — semanticSearch legitimately keeps CallResult (KTD3)", () => {
    // array-inline response → no named schema to alias; the fallback is correct,
    // and it is NOT in the mapped set above so it never trips the guard.
    expect(articleLine("semanticSearch")).toContain("=> CallResult<");
  });

  it("keeps DOM-colliding names off the flat surface, reachable only via DevTo (KTD5)", () => {
    const flat = flatReExport();
    expect(flat).not.toMatch(/\bComment\b/);
    expect(flat).not.toMatch(/\bRequestRedirect\b/);
    // but both are declared in schemas.d.ts, so DevTo.Comment / DevTo.RequestRedirect resolve
    expect(schemas).toContain("export type Comment =");
    expect(schemas).toContain("export type RequestRedirect =");
  });

  it("re-exports every non-DOM-colliding friendly name flat (index/schema-names drift guard)", () => {
    // index.ts hand-maintains the flat re-export list; without this check a new
    // schemaNames entry forgotten there would compile clean and be silently
    // reachable only via DevTo.* (KTD2's completeness gate, applied to the surface).
    const flat = flatReExport();
    const missing = [...new Set(Object.values(schemaNames))]
      .filter((n) => !DENYLIST.has(n))
      .filter((n) => !new RegExp(`\\b${n}\\b`).test(flat));
    expect(missing).toEqual([]);
  });

  /**
   * The block above pins only the generated friendly types. The transport option
   * interfaces live in http.d.ts, which nothing read until the transport-hardening
   * work — so removing a public option used to ship green and unverified.
   */
  describe("transport option surface", () => {
    const members = (iface: string): string =>
      http.match(new RegExp(`interface ${iface} \\{([\\s\\S]*?)\\n\\}`))?.[1] ??
      (() => {
        throw new Error(`no ${iface} in http.d.ts`);
      })();

    it("pins the ClientOptions members", () => {
      const block = members("ClientOptions");
      for (const member of [
        "apiKey?",
        "baseUrl?",
        "allowInsecureHttp?",
        "retry?",
        "timeoutMs?",
        "pace?",
        "onResponse?",
        "headers?",
        "fetch?",
        "sleep?",
      ]) {
        expect(block, member).toContain(member);
      }
    });

    it("pins the RequestOptions members", () => {
      const block = members("RequestOptions");
      for (const member of ["query?", "body?", "signal?", "headers?", "timeoutMs?"]) {
        expect(block, member).toContain(member);
      }
    });

    it("pins the RetryOptions members and proves maxDelayMs is gone (R15)", () => {
      const block = members("RetryOptions");
      expect(block).toContain("attempts?");
      expect(block).toContain("baseDelayMs?");
      expect(block).toContain("throttleDelayMs?");
      // the one assertion in tests/ allowed to name the removed option: it is
      // what proves the removal reached the public surface, not just the source
      expect(block).not.toContain("maxDelayMs");
    });
  });

  it("keeps the DevTo re-export type-only so dist ships no runtime import of the empty module", () => {
    // schemas.ts is type-only; a plain `export *` would survive into dist/index.js as a
    // live import of an `export {}` module under verbatimModuleSyntax. `export type *` erases it.
    expect(readFileSync("src/index.ts", "utf8")).toMatch(/export type \* as DevTo from/);
  });
});
