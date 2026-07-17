import type { OpTable } from "../ops.ts";

export const instanceTable = {
  get: { path: "/api/instance", verb: "get" },
} as const;

instanceTable satisfies OpTable;

export type { InstanceNamespace } from "../generated/signatures.ts";
