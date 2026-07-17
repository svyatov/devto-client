import type { OpTable } from "../ops.ts";

export const readinglistTable = {
  list: { path: "/api/readinglist", verb: "get", paginated: true },
} as const;

readinglistTable satisfies OpTable;

export type { ReadinglistNamespace } from "../generated/signatures.ts";
