import type { OpTable } from "../ops.ts";

export const billboardsTable = {
  list: { path: "/api/billboards", verb: "get" },
  create: { path: "/api/billboards", verb: "post" },
  get: { path: "/api/billboards/{id}", verb: "get" },
  update: { path: "/api/billboards/{id}", verb: "put" },
  unpublish: { path: "/api/billboards/{id}/unpublish", verb: "put" },
} as const;

billboardsTable satisfies OpTable;

export type { BillboardsNamespace } from "../generated/signatures.ts";
