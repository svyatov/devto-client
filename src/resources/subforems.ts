import type { OpTable } from "../ops.ts";

export const subforemsTable = {
  list: { path: "/api/subforems", verb: "get" },
} as const;

subforemsTable satisfies OpTable;

export type { SubforemsNamespace } from "../generated/signatures.ts";
