import type { BoundOps, OpTable } from "../ops.ts";

export const recommendedArticlesListsTable = {
  list: { path: "/api/recommended_articles_lists", verb: "get", paginated: true },
  create: { path: "/api/recommended_articles_lists", verb: "post" },
  get: { path: "/api/recommended_articles_lists/{id}", verb: "get" },
  update: { path: "/api/recommended_articles_lists/{id}", verb: "patch" },
} as const;

recommendedArticlesListsTable satisfies OpTable;

/** Recommended-articles lists: read, list, create, and update. */
export type RecommendedArticlesListsNamespace = BoundOps<typeof recommendedArticlesListsTable>;
