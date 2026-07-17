import type { BoundOps, OpTable } from "../ops.ts";

export const trendsTable = {
  list: { path: "/api/trends", verb: "get", paginated: true },
  get: { path: "/api/trends/{id_or_slug}", verb: "get" },
  articles: { path: "/api/trends/{trend_id_or_slug}/articles", verb: "get", paginated: true },
} as const;

trendsTable satisfies OpTable;

/** Trends: list, read a trend, and list a trend's articles. */
export type TrendsNamespace = BoundOps<typeof trendsTable>;
