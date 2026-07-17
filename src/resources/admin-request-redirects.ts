import type { OpTable } from "../ops.ts";

export const adminRequestRedirectsTable = {
  list: { path: "/api/admin/request_redirects", verb: "get", paginated: true },
  create: { path: "/api/admin/request_redirects", verb: "post", bodyKey: "request_redirect" },
  get: { path: "/api/admin/request_redirects/{id}", verb: "get" },
  update: { path: "/api/admin/request_redirects/{id}", verb: "patch", bodyKey: "request_redirect" },
  delete: { path: "/api/admin/request_redirects/{id}", verb: "delete" },
} as const;

adminRequestRedirectsTable satisfies OpTable;

export type { AdminRequestRedirectsNamespace } from "../generated/signatures.ts";
