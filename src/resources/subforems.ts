import type { BoundOps, OpTable } from "../ops.ts";

export const subforemsTable = {
  list: { path: "/api/subforems", verb: "get" },
} as const;

subforemsTable satisfies OpTable;

export type SubforemsNamespace = BoundOps<typeof subforemsTable>;
