import type { OpTable } from "../ops.ts";

export const adminConceptsTable = {
  list: { path: "/api/admin/concepts", verb: "get", paginated: true },
  create: { path: "/api/admin/concepts", verb: "post", bodyKey: "concept" },
  get: { path: "/api/admin/concepts/{id}", verb: "get" },
  update: { path: "/api/admin/concepts/{id}", verb: "patch", bodyKey: "concept" },
  delete: { path: "/api/admin/concepts/{id}", verb: "delete" },
  triggerLookback: { path: "/api/admin/concepts/{id}/trigger_lookback", verb: "post" },
} as const;

adminConceptsTable satisfies OpTable;

export type { AdminConceptsNamespace } from "../generated/signatures.ts";
