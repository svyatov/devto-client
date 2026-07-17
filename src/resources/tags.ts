import type { BoundOps, OpTable } from "../ops.ts";

export const tagsTable = {
  list: { path: "/api/tags", verb: "get", paginated: true },
} as const;

tagsTable satisfies OpTable;

/** The instance's tags. */
export type TagsNamespace = BoundOps<typeof tagsTable>;
