import type { OpTable } from "../ops.ts";

export const videosTable = {
  list: { path: "/api/videos", verb: "get", paginated: true },
} as const;

videosTable satisfies OpTable;

export type { VideosNamespace } from "../generated/signatures.ts";
