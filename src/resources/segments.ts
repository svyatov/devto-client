import type { BoundOps, OpTable } from "../ops.ts";

export const segmentsTable = {
  list: { path: "/api/segments", verb: "get" },
  create: { path: "/api/segments", verb: "post" },
  get: { path: "/api/segments/{id}", verb: "get" },
  delete: { path: "/api/segments/{id}", verb: "delete" },
  addUsers: { path: "/api/segments/{id}/add_users", verb: "put" },
  removeUsers: { path: "/api/segments/{id}/remove_users", verb: "put" },
  users: { path: "/api/segments/{id}/users", verb: "get" },
} as const;

segmentsTable satisfies OpTable;

/** Audience segments: CRUD plus membership management. Requires admin credentials. */
export type SegmentsNamespace = BoundOps<typeof segmentsTable>;
