import type { BoundOps, OpTable } from "../ops.ts";

export const reactionsTable = {
  create: { path: "/api/reactions", verb: "post" },
  toggle: { path: "/api/reactions/toggle", verb: "post" },
} as const;

reactionsTable satisfies OpTable;

export type ReactionsNamespace = BoundOps<typeof reactionsTable>;
