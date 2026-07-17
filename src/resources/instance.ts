import type { BoundOps, OpTable } from "../ops.ts";

export const instanceTable = {
  get: { path: "/api/instance", verb: "get" },
} as const;

instanceTable satisfies OpTable;

/** Metadata for the connected Forem instance. */
export type InstanceNamespace = BoundOps<typeof instanceTable>;
