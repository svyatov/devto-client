import type { BoundOps, OpTable } from "../ops.ts";

export const followsTable = {
  create: { path: "/api/follows", verb: "post" },
  tags: { path: "/api/follows/tags", verb: "get" },
} as const;

followsTable satisfies OpTable;

/** Follows: create a follow and list the tags you follow. */
export type FollowsNamespace = BoundOps<typeof followsTable>;
