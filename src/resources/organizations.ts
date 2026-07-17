import type { BoundOps, OpTable } from "../ops.ts";

export const organizationsTable = {
  list: { path: "/api/organizations", verb: "get", paginated: true },
  create: { path: "/api/organizations", verb: "post" },
  get: { path: "/api/organizations/{id}", verb: "get" },
  update: { path: "/api/organizations/{id}", verb: "put" },
  delete: { path: "/api/organizations/{id}", verb: "delete" },
  getByUsername: { path: "/api/organizations/{username}", verb: "get" },
  articles: {
    path: "/api/organizations/{organization_id_or_username}/articles",
    verb: "get",
    paginated: true,
  },
  users: {
    path: "/api/organizations/{organization_id_or_username}/users",
    verb: "get",
    paginated: true,
  },
} as const;

organizationsTable satisfies OpTable;

/** Organizations: listings, reads by id or username, member and article listings, and authenticated CRUD. */
export type OrganizationsNamespace = BoundOps<typeof organizationsTable>;
