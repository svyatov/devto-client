import type { OpTable } from "../ops.ts";

export const badgesTable = {
  list: { path: "/api/badges", verb: "get", paginated: true },
  create: { path: "/api/badges", verb: "post", bodyKey: "badge" },
  get: { path: "/api/badges/{id}", verb: "get" },
  update: { path: "/api/badges/{id}", verb: "patch", bodyKey: "badge" },
  delete: { path: "/api/badges/{id}", verb: "delete" },
} as const;

badgesTable satisfies OpTable;

export type { BadgesNamespace } from "../generated/signatures.ts";
