import type { OpTable } from "../ops.ts";

export const badgeAchievementsTable = {
  list: { path: "/api/badge_achievements", verb: "get", paginated: true },
  create: { path: "/api/badge_achievements", verb: "post", bodyKey: "badge_achievement" },
  get: { path: "/api/badge_achievements/{id}", verb: "get" },
  delete: { path: "/api/badge_achievements/{id}", verb: "delete" },
} as const;

badgeAchievementsTable satisfies OpTable;

export type { BadgeAchievementsNamespace } from "../generated/signatures.ts";
