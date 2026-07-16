import { expect, it } from "vitest";
import { DevToClient } from "../src/index.ts";

/**
 * Compile-time contract for bound call signatures: required path params,
 * required query params, and required bodies must make the args mandatory.
 * Enforced by `tsc` (an unfired @ts-expect-error is itself an error); the
 * closure is never invoked, so no requests are made.
 */
const client = new DevToClient();

it("enforces required args at compile time", () => {
  const compileOnly = () => {
    // fully optional → zero-arg call allowed
    void client.articles.list();
    void client.comments.list({});

    // required query params make args and query mandatory
    // @ts-expect-error toggle requires category/reactable_id/reactable_type
    void client.reactions.toggle();
    // @ts-expect-error query itself is required
    void client.reactions.toggle({});
    // @ts-expect-error reactable_type is missing
    void client.reactions.toggle({ query: { category: "like", reactable_id: 1 } });
    void client.reactions.toggle({
      query: { category: "like", reactable_id: 1, reactable_type: "Article" },
    });
    // @ts-expect-error semantic search requires q
    void client.articles.semanticSearch();
    void client.articles.semanticSearch({ query: { q: "cats" } });

    // iterator variants inherit the requirement but never accept page
    // @ts-expect-error q is still required on the iterator
    void client.articles.semanticSearchAll();
    // @ts-expect-error page is driven by the iterator, not the caller
    void client.articles.semanticSearchAll({ query: { q: "cats", page: 2 } });
    void client.articles.semanticSearchAll({ query: { q: "cats" } });
    void client.articles.listAll();

    // required path params (pre-existing behavior, pinned); the upstream spec
    // marks every requestBody optional, so there is no required-body case to pin
    // @ts-expect-error id path param is required
    void client.articles.get();
    void client.articles.get({ path: { id: 1 } });
  };
  expect(compileOnly).toBeInstanceOf(Function);
});
