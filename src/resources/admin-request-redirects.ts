import type { BoundOps, OpTable } from "../ops.ts";

export const adminRequestRedirectsTable = {
  list: { path: "/api/admin/request_redirects", verb: "get", paginated: true },
  create: { path: "/api/admin/request_redirects", verb: "post" },
  get: { path: "/api/admin/request_redirects/{id}", verb: "get" },
  update: { path: "/api/admin/request_redirects/{id}", verb: "patch" },
  delete: { path: "/api/admin/request_redirects/{id}", verb: "delete" },
} as const;

adminRequestRedirectsTable satisfies OpTable;

/** Admin URL-redirect rules: CRUD. Requires admin credentials. */
export type AdminRequestRedirectsNamespace = BoundOps<typeof adminRequestRedirectsTable>;
