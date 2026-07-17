import type { OpTable } from "../ops.ts";

export const tagsTable = {
  list: { path: "/api/tags", verb: "get", paginated: true },
} as const;

tagsTable satisfies OpTable;

export type { TagsNamespace } from "../generated/signatures.ts";
