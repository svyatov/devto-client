import type { BoundOps, OpTable } from "../ops.ts";

export const pagesTable = {
  list: { path: "/api/pages", verb: "get" },
  create: { path: "/api/pages", verb: "post" },
  get: { path: "/api/pages/{id}", verb: "get" },
  update: { path: "/api/pages/{id}", verb: "put" },
  delete: { path: "/api/pages/{id}", verb: "delete" },
} as const;

pagesTable satisfies OpTable;

/** Static instance pages: CRUD. Mutations require admin credentials. */
export type PagesNamespace = BoundOps<typeof pagesTable>;
