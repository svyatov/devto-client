import type { BoundOps, OpTable } from "../ops.ts";

export const analyticsTable = {
  dashboard: { path: "/api/analytics/dashboard", verb: "get" },
  followerEngagement: { path: "/api/analytics/follower_engagement", verb: "get" },
  heatmap: { path: "/api/analytics/heatmap", verb: "get" },
  historical: { path: "/api/analytics/historical", verb: "get" },
  pastDay: { path: "/api/analytics/past_day", verb: "get" },
  referrers: { path: "/api/analytics/referrers", verb: "get" },
  topContributors: { path: "/api/analytics/top_contributors", verb: "get" },
  totals: { path: "/api/analytics/totals", verb: "get" },
} as const;

analyticsTable satisfies OpTable;

export type AnalyticsNamespace = BoundOps<typeof analyticsTable>;
