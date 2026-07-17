import { describe, expect, it } from "vitest";
import { generate, loadSpec } from "../scripts/generate-signatures.ts";

/**
 * The generator's contract: labeled Call-rule members with true names/order/types,
 * derived from the composed spec + op tables. Assertions match the raw (pre-Biome)
 * single-line output `generate()` returns.
 */
const spec = loadSpec();
const { signatures, routing } = generate(spec);

describe("generate-signatures", () => {
  it("emits 0-, 1-, and 2-arity path signatures with true names, order, and types", () => {
    expect(signatures).toContain(
      'get: (id: number, opts?: CallOptions) => CallResult<"/api/articles/{id}", "get">;',
    );
    expect(signatures).toContain(
      'getByPath: (username: string, slug: string, opts?: CallOptions) => CallResult<"/api/articles/{username}/{slug}", "get">;',
    );
    // 0-arity op with only optional query keeps the params object optional
    expect(signatures).toContain(
      'list: (params?: CallQuery<"/api/articles", "get">, opts?: CallOptions) => CallResult<"/api/articles", "get">;',
    );
  });

  it("makes the params object required for a required-query op (AE3), optional otherwise", () => {
    expect(signatures).toContain(
      'semanticSearch: (params: CallQuery<"/api/articles/semantic_search", "get">',
    );
    expect(signatures).toContain('search: (params?: CallQuery<"/api/articles/search", "get">');
  });

  it("unwraps a single-key body op to flat inner fields, leaves a flat body unchanged", () => {
    // wrapper op → CallBodyInner keyed by bodyKey
    expect(signatures).toContain(
      'create: (params?: CallBodyInner<"/api/articles", "post", "article">',
    );
    // flat-body op (UserInviteParam { email, name }) → CallBody, no unwrap
    expect(signatures).toContain('create: (params?: CallBody<"/api/admin/users", "post">');
  });

  it("emits an `<name>All` iterator twin for paginated ops", () => {
    expect(signatures).toContain(
      'listAll: (params?: IterQuery<"/api/articles", "get">, opts?: CallOptions) => IterResult<"/api/articles", "get">;',
    );
    // a non-paginated op gets no twin
    expect(signatures).not.toContain("getByPathAll:");
  });

  it("routes params to query vs body per op kind", () => {
    expect(routing).toContain('"post /api/articles": "body"');
    expect(routing).toContain('"get /api/articles": "query"');
    expect(routing).toContain('"post /api/reactions/toggle": "query"');
    // no-params ops are absent from the routing manifest
    expect(routing).not.toContain('"get /api/articles/{id}":');
    expect(routing).not.toContain('"get /api/articles/{username}/{slug}":');
  });

  it("is deterministic — regenerating produces byte-identical output", () => {
    const again = generate(spec);
    expect(again.signatures).toBe(signatures);
    expect(again.routing).toBe(routing);
  });

  it("fails with a named error when an op references a path absent from the spec", () => {
    const empty = { ...spec, paths: {} };
    expect(() => generate(empty)).toThrow(/absent from the composed spec/);
  });
});
