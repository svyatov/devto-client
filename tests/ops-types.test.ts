import { expect, it } from "bun:test";
import { DevToClient } from "../src/index.ts";
import type { NoQueryAndBody, NoQueryAndBodyOp, OpEntry } from "../src/ops.ts";

/** Compile-time assertion helper — `Assert<false>` is a type error. */
type Assert<T extends true> = T;

// ---------------------------------------------------------------------------
// KTD4: bodyKey is constrained to the op's real single-key wrapper, required
// when the body is a wrapper and forbidden otherwise. A wrong, stale, or
// missing bodyKey is a compile error.
// ---------------------------------------------------------------------------
// AE2 (type half): the correct wrapper key compiles.
({ path: "/api/articles", verb: "post", bodyKey: "article" }) satisfies OpEntry;
// @ts-expect-error — misspelled wrapper key
({ path: "/api/articles", verb: "post", bodyKey: "artcle" }) satisfies OpEntry;
// @ts-expect-error — a wrapper op must declare its bodyKey (completeness)
({ path: "/api/articles", verb: "post" }) satisfies OpEntry;
// @ts-expect-error — a flat-body op must not declare a bodyKey
({ path: "/api/admin/users", verb: "post", bodyKey: "user" }) satisfies OpEntry;
// a genuinely flat-body op carries no bodyKey
({ path: "/api/admin/users", verb: "post" }) satisfies OpEntry;

// ---------------------------------------------------------------------------
// R8: no operation may declare both a query object and a body — the routing
// rule (body-else-query) depends on it. The real surface holds; the guard
// mechanism rejects a synthetic op that violates it.
// ---------------------------------------------------------------------------
type _r8Holds = Assert<NoQueryAndBodyOp>;
type SyntheticQueryAndBody = {
  parameters: { query: { x: string } };
  requestBody: { content: { "application/json": { y: number } } };
  responses: { 200: { content: { "application/json": { ok: true } } } };
};
// @ts-expect-error — an op with both query and body fails the guard
type _r8Rejects = Assert<NoQueryAndBody<SyntheticQueryAndBody>>;

/**
 * Compile-time contract for the Call rule: positional path params, required
 * query params, and iterator page-rejection must hold at the type level.
 * Enforced by `tsc` (an unfired @ts-expect-error is itself an error); the
 * closure is never invoked, so no requests are made.
 */
const client = new DevToClient();

it("enforces the Call rule at compile time (AE3, AE4, AE6)", () => {
  const compileOnly = () => {
    // fully optional → zero-arg call allowed
    void client.articles.list();
    void client.comments.list();

    // AE3: required query params make the flat params object mandatory
    // @ts-expect-error toggle requires category/reactable_id/reactable_type
    void client.reactions.toggle();
    // @ts-expect-error the params object is required
    void client.reactions.toggle({});
    // @ts-expect-error reactable_type is missing
    void client.reactions.toggle({ category: "like", reactable_id: 1 });
    void client.reactions.toggle({ category: "like", reactable_id: 1, reactable_type: "Article" });
    // @ts-expect-error semantic search requires q
    void client.articles.semanticSearch();
    void client.articles.semanticSearch({ q: "cats" });

    // AE4: iterator variants inherit the requirement but never accept page
    // @ts-expect-error q is still required on the iterator
    void client.articles.semanticSearchAll();
    // @ts-expect-error page is driven by the iterator, not the caller
    void client.articles.semanticSearchAll({ q: "cats", page: 2 });
    void client.articles.semanticSearchAll({ q: "cats" });
    void client.articles.listAll();

    // AE6: positional path params — true names, arity enforced
    // @ts-expect-error id path param is required
    void client.articles.get();
    void client.articles.get(1);
    // @ts-expect-error getByPath needs both username and slug
    void client.articles.getByPath("jess");
    void client.articles.getByPath("jess", "some-post");
  };
  expect(compileOnly).toBeInstanceOf(Function);
});
