import type { OpTable } from "../ops.ts";

export const followsTable = {
  create: { path: "/api/follows", verb: "post" },
  tags: { path: "/api/follows/tags", verb: "get" },
} as const;

followsTable satisfies OpTable;

export type { FollowsNamespace } from "../generated/signatures.ts";
