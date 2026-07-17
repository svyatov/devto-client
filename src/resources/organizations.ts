import type { OpTable } from "../ops.ts";

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

export type { OrganizationsNamespace } from "../generated/signatures.ts";
