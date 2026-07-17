import type { BoundOps, OpTable } from "../ops.ts";

export const reactionsTable = {
  create: { path: "/api/reactions", verb: "post" },
  toggle: { path: "/api/reactions/toggle", verb: "post" },
} as const;

reactionsTable satisfies OpTable;

/** Reactions: create one, or toggle it on/off (toggle needs the category, reactable id, and reactable type). Admin-gated upstream; ordinary keys get 401. */
export type ReactionsNamespace = BoundOps<typeof reactionsTable>;
