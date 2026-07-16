import type { BoundOps, OpTable } from "../ops.ts";

export const articlesTable = {
  list: { path: "/api/articles", verb: "get", paginated: true },
  latest: { path: "/api/articles/latest", verb: "get", paginated: true },
  search: { path: "/api/articles/search", verb: "get", paginated: true },
  semanticSearch: { path: "/api/articles/semantic_search", verb: "get", paginated: true },
  create: { path: "/api/articles", verb: "post" },
  get: { path: "/api/articles/{id}", verb: "get" },
  update: { path: "/api/articles/{id}", verb: "put" },
  unpublish: { path: "/api/articles/{id}/unpublish", verb: "put" },
  getByPath: { path: "/api/articles/{username}/{slug}", verb: "get" },
  me: { path: "/api/articles/me", verb: "get", paginated: true },
  mePublished: { path: "/api/articles/me/published", verb: "get", paginated: true },
  meUnpublished: { path: "/api/articles/me/unpublished", verb: "get", paginated: true },
  meAllStatuses: { path: "/api/articles/me/all", verb: "get", paginated: true },
} as const;

articlesTable satisfies OpTable;

export type ArticlesNamespace = BoundOps<typeof articlesTable>;
