import type { BoundOps, OpTable } from "../ops.ts";

export const conceptsTable = {
  list: { path: "/api/concepts", verb: "get", paginated: true },
  get: { path: "/api/concepts/{id}", verb: "get" },
  update: { path: "/api/concepts/{id}", verb: "patch" },
  articles: { path: "/api/concepts/{id}/articles", verb: "get", paginated: true },
  search: { path: "/api/concepts/search", verb: "get" },
} as const;

conceptsTable satisfies OpTable;

export type ConceptsNamespace = BoundOps<typeof conceptsTable>;
