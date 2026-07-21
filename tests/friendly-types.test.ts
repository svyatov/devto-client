import { describe, expect, it } from "bun:test";
import { generate, loadSpec } from "../scripts/generate-signatures.ts";
// U4 export surface: flat friendly names import directly (R3); every alias —
// including the DOM-denylisted ones — is reachable through the `DevTo` namespace.
// The denylist's *absence* from the flat surface is asserted on the emitted
// `.d.ts` in tests/dts-surface.test.ts (a string check, robust to import merging).
import type { Article, DevTo, User } from "../src/index.ts";

/**
 * The friendly-type layer's contract: the generator emits 1:1 aliases over the
 * spec schemas (KTD1/R4) and resolves op success responses to friendly returns
 * (KTD3/R1). U2 extends this with the completeness gate; U3 with param types.
 */
const spec = loadSpec();
const { signatures, schemas } = generate(spec);

/** Compile-time assertion helper — `Assert<false>` is a type error. */
type Assert<T extends true> = T;

// U4 (R3/KTD5), enforced by tsc: flat names import directly; denylisted names
// resolve through `DevTo.*`, and the friendly `DevTo.Comment` is genuinely a
// different type from the lib.dom `Comment` (no shadowing).
type _flatArticle = Article;
type _flatUser = User;
type _nsComment = DevTo.Comment;
type _nsRedirect = DevTo.RequestRedirect;
type _distinct = Assert<DevTo.Comment extends Node ? false : true>;

describe("friendly-types", () => {
  it("emits a 1:1 alias over the spec schema for each mapped name (KTD1/R4)", () => {
    expect(schemas).toContain('export type Article = components["schemas"]["ArticleShow"];');
    expect(schemas).toContain(
      'export type ArticleSummary = components["schemas"]["ArticleIndex"];',
    );
  });

  it("resolves article response $refs to friendly returns (KTD3/R1)", () => {
    // top-level $ref → Promise<Friendly>
    expect(signatures).toContain("get: (id: number, opts?: CallOptions) => Promise<Article>;");
    // real array + items.$ref → Promise<Friendly[]>
    expect(signatures).toContain("=> Promise<ArticleSummary[]>;");
  });

  it("resolves a real array response to Promise<Friendly[]> (KTD3 branch 2)", () => {
    expect(signatures).toContain(
      "list: (params?: CommentListParams, opts?: CallOptions) => Promise<Comment[]>;",
    );
  });

  it("keeps CallResult for a spec-malformed object+items response (KTD3 branch-3 guard)", () => {
    // get /api/segments/{id} is `{type: object, items: $ref Segment}` — following
    // items.$ref would emit Promise<Segment> the generated type does not back.
    expect(signatures).toContain(
      'get: (id: number, opts?: CallOptions) => CallResult<"/api/segments/{id}", "get">;',
    );
    // the malformed get must NOT resolve to a friendly Segment (siblings legitimately do)
    expect(signatures).not.toContain("get: (id: number, opts?: CallOptions) => Promise<Segment>;");
  });

  it("emits Promise<void> for a no-content 2xx op (KTD3 void branch)", () => {
    // articles.unpublish is 200-no-content → void, not CallResult
    expect(signatures).toContain(
      "unpublish: (id: number, params?: ArticleUnpublishParams, opts?: CallOptions) => Promise<void>;",
    );
  });

  it("keeps CallResult for an inline-object response and does not throw (KTD3 branch 3)", () => {
    // get /api/instance is an inline object with no named schema
    expect(signatures).toContain(
      'get: (opts?: CallOptions) => CallResult<"/api/instance", "get">;',
    );
  });

  it("throws naming the schema + op when a response schema is unmapped (KTD2)", () => {
    const mutated = structuredClone(spec);
    const op = mutated.paths["/api/articles/{id}"]?.get;
    // point the success response at a schema absent from the name map
    (op as { responses: Record<string, unknown> }).responses = {
      200: { content: { "application/json": { schema: { $ref: "#/components/schemas/Nope" } } } },
    };
    expect(() => generate(mutated)).toThrow(
      /response schema "Nope" for get \/api\/articles\/\{id\}/,
    );
  });

  it("throws when a real array response's items.$ref is unmapped (KTD2 branch 2)", () => {
    // the completeness gate is reached from branch 2 (array + items.$ref), not only branch 1
    const mutated = structuredClone(spec);
    const op = mutated.paths["/api/articles/{id}"]?.get;
    (op as { responses: Record<string, unknown> }).responses = {
      200: {
        content: {
          "application/json": {
            schema: { type: "array", items: { $ref: "#/components/schemas/Nope" } },
          },
        },
      },
    };
    expect(() => generate(mutated)).toThrow(
      /response schema "Nope" for get \/api\/articles\/\{id\}/,
    );
  });

  it("collapses identical 200 + 201 schemas to one friendly return (SuccessOf union)", () => {
    // reactions.create/toggle document ReactionResult at both 200 and 201; the union
    // collapses to a single schema, so it stays friendly rather than falling back
    expect(signatures).toContain(
      "create: (params: ReactionCreateParams, opts?: CallOptions) => Promise<ReactionResult>;",
    );
  });

  it("falls back to CallResult when 200 and 201 carry distinct schemas (SuccessOf union)", () => {
    const mutated = structuredClone(spec);
    const op = mutated.paths["/api/articles/{id}"]?.get;
    (op as { responses: Record<string, unknown> }).responses = {
      200: {
        content: { "application/json": { schema: { $ref: "#/components/schemas/ArticleShow" } } },
      },
      201: { content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } },
    };
    const { signatures: sig } = generate(mutated);
    expect(sig).toContain(
      'get: (id: number, opts?: CallOptions) => CallResult<"/api/articles/{id}", "get">;',
    );
    expect(sig).not.toContain("get: (id: number, opts?: CallOptions) => Promise<Article>;");
  });

  it("falls back to CallResult when a JSON body coexists with a 204 (SuccessOf gains undefined)", () => {
    const mutated = structuredClone(spec);
    const op = mutated.paths["/api/articles/{id}"]?.get;
    (op as { responses: Record<string, unknown> }).responses = {
      200: {
        content: { "application/json": { schema: { $ref: "#/components/schemas/ArticleShow" } } },
      },
      204: {},
    };
    const { signatures: sig } = generate(mutated);
    expect(sig).toContain(
      'get: (id: number, opts?: CallOptions) => CallResult<"/api/articles/{id}", "get">;',
    );
  });

  it("keeps CallResult for an op whose only 2xx is outside 200/201/204 (SuccessOf is never)", () => {
    // a 202-only op: SuccessOf reads only 200|201|204, so the runtime type is never —
    // emitting a friendly Promise<Article> here would be the exact "present but wrong" lie
    const mutated = structuredClone(spec);
    const op = mutated.paths["/api/articles/{id}"]?.get;
    (op as { responses: Record<string, unknown> }).responses = {
      202: {
        content: { "application/json": { schema: { $ref: "#/components/schemas/ArticleShow" } } },
      },
    };
    const { signatures: sig } = generate(mutated);
    expect(sig).toContain(
      'get: (id: number, opts?: CallOptions) => CallResult<"/api/articles/{id}", "get">;',
    );
  });

  it("does not gate body-only schemas — `Article` (create/update body) needs no map entry (KTD2)", () => {
    // generation succeeds even though the body schema literally named `Article`
    // has no map key; only `ArticleShow → Article` is aliased.
    expect(() => generate(spec)).not.toThrow();
    expect(schemas).toContain('export type Article = components["schemas"]["ArticleShow"];');
  });

  it("names each params slot and defines it as a Prettify alias (KTD4/R2)", () => {
    // query op: slot references the named alias; alias is Prettify<CallQuery<…>>
    expect(signatures).toContain("search: (params?: ArticleSearchParams,");
    expect(schemas).toContain(
      'export type ArticleSearchParams = Prettify<CallQuery<"/api/articles/search", "get">>;',
    );
    // body op: alias over the unwrapped inner fields
    expect(signatures).toContain("create: (params?: ArticleCreateParams,");
    expect(schemas).toContain(
      'export type ArticleCreateParams = Prettify<CallBodyInner<"/api/articles", "post", "article">>;',
    );
    // iterator op: its own …AllParams alias over IterQuery
    expect(schemas).toContain(
      'export type ArticleListAllParams = Prettify<IterQuery<"/api/articles", "get">>;',
    );
  });

  it("emits no param alias for a method with no params slot (KTD4 edge)", () => {
    // articles.get is positional-only — no empty `{}` param type
    expect(schemas).not.toContain("ArticleGetParams");
  });

  it("emits no duplicate alias names (resourcePrefix collision guard)", () => {
    // resourcePrefix de-pluralizes naively; a cross-resource collision would emit two
    // `export type X = …` lines and surface as a raw TS duplicate-identifier error.
    // This pins it as a clear generator diagnostic instead.
    const names = [...schemas.matchAll(/^export type (\w+) =/gm)].map((m) => m[1]);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it("is deterministic — regenerating schemas is byte-identical", () => {
    const again = generate(spec);
    expect(again.schemas).toBe(schemas);
    expect(again.signatures).toBe(signatures);
  });
});
