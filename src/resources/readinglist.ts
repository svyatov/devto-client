import type { BoundOps, OpTable } from "../ops.ts";

export const readinglistTable = {
  list: { path: "/api/readinglist", verb: "get", paginated: true },
} as const;

readinglistTable satisfies OpTable;

/** Your reading list (saved articles). Requires authentication. */
export type ReadinglistNamespace = BoundOps<typeof readinglistTable>;
