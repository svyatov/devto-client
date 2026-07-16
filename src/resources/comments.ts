import type { BoundOps, OpTable } from "../ops.ts";

export const commentsTable = {
  list: { path: "/api/comments", verb: "get", paginated: true },
  get: { path: "/api/comments/{id}", verb: "get" },
} as const;

commentsTable satisfies OpTable;

export type CommentsNamespace = BoundOps<typeof commentsTable>;
