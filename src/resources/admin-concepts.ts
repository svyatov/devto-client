import type { BoundOps, OpTable } from "../ops.ts";

export const adminConceptsTable = {
  list: { path: "/api/admin/concepts", verb: "get", paginated: true },
  create: { path: "/api/admin/concepts", verb: "post" },
  get: { path: "/api/admin/concepts/{id}", verb: "get" },
  update: { path: "/api/admin/concepts/{id}", verb: "patch" },
  delete: { path: "/api/admin/concepts/{id}", verb: "delete" },
  triggerLookback: { path: "/api/admin/concepts/{id}/trigger_lookback", verb: "post" },
} as const;

adminConceptsTable satisfies OpTable;

/** Admin concept management: CRUD plus lookback triggering. Requires admin credentials. */
export type AdminConceptsNamespace = BoundOps<typeof adminConceptsTable>;
